//! The menu loop's presentation source. Retail/capture keeps the original
//! Bink surface; iOS/macOS/Android retain the approved indexed PNG/XOR loop.
//! Web uses its original first-frame poster plus an optional browser-decoded
//! compressed MP4. This is not the campaign/fullscreen movie player.

use crate::assets::error::AssetError;
use crate::render::batch::BatchTexture;
use crate::render::bink_movie::{BinkMovieStep, BinkMovieSurface};
use crate::render::gpu::GpuContext;

#[cfg(test)]
use std::sync::Arc;

#[cfg(target_arch = "wasm32")]
#[path = "werhd_menu_movie_browser.rs"]
mod browser_video;

/// Decoded media timestamps are authoritative. The compatibility path samples
/// the same media clock at the approved MP4's 15 fps, never the UI frame rate.
#[cfg(any(target_arch = "wasm32", test))]
#[derive(Default)]
struct VideoFrameClock {
    last: Option<(bool, u64)>,
}

#[cfg(any(target_arch = "wasm32", test))]
impl VideoFrameClock {
    fn admit(&mut self, seconds: f64, decoded_timestamp: bool) -> bool {
        if !seconds.is_finite() || seconds < 0.0 {
            return false;
        }
        let seconds = if seconds == 0.0 { 0.0 } else { seconds };
        let value = if decoded_timestamp {
            seconds.to_bits()
        } else {
            (seconds * 15.0).floor() as u64
        };
        let stamp = (decoded_timestamp, value);
        if self.last == Some(stamp) {
            return false;
        }
        self.last = Some(stamp);
        true
    }
}

/// The shell owns playback admission; browser decode time must stop whenever
/// the native movie control is hidden or its application is not foreground.
#[cfg(any(target_arch = "wasm32", test))]
#[derive(Clone, Copy)]
struct VideoPlaybackGate {
    menu_shown: bool,
    window_active: bool,
    document_visible: bool,
}

#[cfg(any(target_arch = "wasm32", test))]
impl Default for VideoPlaybackGate {
    fn default() -> Self {
        Self {
            menu_shown: false,
            window_active: true,
            document_visible: true,
        }
    }
}

#[cfg(any(target_arch = "wasm32", test))]
impl VideoPlaybackGate {
    fn playing(self) -> bool {
        self.menu_shown && self.window_active && self.document_visible
    }
}

pub(crate) enum MenuMovieSurface {
    Retail(BinkMovieSurface),
    #[cfg(any(
        target_os = "ios",
        target_os = "macos",
        target_os = "android",
        target_arch = "wasm32"
    ))]
    Branded(BrandedMenuSurface),
}

impl From<BinkMovieSurface> for MenuMovieSurface {
    fn from(value: BinkMovieSurface) -> Self {
        Self::Retail(value)
    }
}

impl MenuMovieSurface {
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn set_playing(&mut self, playing: bool) {
        if let Self::Branded(movie) = self
            && let Some(video) = movie.video.as_mut()
        {
            video.set_playing(playing);
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub(crate) fn set_window_active(&mut self, active: bool) {
        if let Self::Branded(movie) = self
            && let Some(video) = movie.video.as_mut()
        {
            video.set_window_active(active);
        }
    }

    #[cfg(any(
        target_os = "ios",
        target_os = "macos",
        target_os = "android",
        target_arch = "wasm32"
    ))]
    pub(crate) fn branded(
        gpu: &GpuContext,
        batch: &crate::render::batch::BatchRenderer,
    ) -> Result<Self, AssetError> {
        BrandedMenuSurface::new(gpu, batch).map(Self::Branded)
    }

    pub(crate) fn batch_texture(&self) -> &BatchTexture {
        match self {
            Self::Retail(movie) => movie.batch_texture(),
            #[cfg(any(
                target_os = "ios",
                target_os = "macos",
                target_os = "android",
                target_arch = "wasm32"
            ))]
            Self::Branded(movie) => &movie.batch_texture,
        }
    }

    pub(crate) fn source_archive(&self) -> &str {
        match self {
            Self::Retail(movie) => movie.source_archive(),
            #[cfg(any(
                target_os = "ios",
                target_os = "macos",
                target_os = "android",
                target_arch = "wasm32"
            ))]
            Self::Branded(movie) => movie.source,
        }
    }

    pub(crate) fn step(
        &mut self,
        gpu: &GpuContext,
        elapsed_secs: f64,
    ) -> Result<BinkMovieStep, AssetError> {
        match self {
            Self::Retail(movie) => movie.step(gpu, elapsed_secs),
            #[cfg(any(
                target_os = "ios",
                target_os = "macos",
                target_os = "android",
                target_arch = "wasm32"
            ))]
            Self::Branded(movie) => movie.step(gpu, elapsed_secs),
        }
    }
}

#[cfg(any(
    target_os = "ios",
    target_os = "macos",
    target_os = "android",
    target_arch = "wasm32"
))]
pub(crate) struct BrandedMenuSurface {
    frames: FrameStream<'static>,
    source: &'static str,
    texture: wgpu::Texture,
    batch_texture: BatchTexture,
    #[cfg(target_arch = "wasm32")]
    video: Option<browser_video::BrowserMenuVideo>,
    #[cfg(target_arch = "wasm32")]
    showing_video: bool,
}

#[cfg(any(
    target_os = "ios",
    target_os = "macos",
    target_os = "android",
    target_arch = "wasm32"
))]
impl BrandedMenuSurface {
    fn new(
        gpu: &GpuContext,
        batch: &crate::render::batch::BatchRenderer,
    ) -> Result<Self, AssetError> {
        #[cfg(not(target_arch = "wasm32"))]
        let (frames, source) = (
            FrameStream::new(include_bytes!("../../art/branding/werhd-menu.wmvframes"))?,
            "built-in WERHD menu movie",
        );
        #[cfg(target_arch = "wasm32")]
        let frames = {
            const POSTER: &[u8] = include_bytes!("../../art/branding/werhd-menu-poster.wmvframes");
            FrameStream::new(POSTER)?
        };
        #[cfg(target_arch = "wasm32")]
        let video = {
            if crate::util::browser_content::capabilities().menu_animation {
                let path = std::path::Path::new(crate::util::browser_io::RETAIL_ROOT)
                    .join("werhd-menu.mp4");
                match crate::util::browser_io::read_shared(path) {
                    Ok(bytes) => match browser_video::BrowserMenuVideo::new(
                        bytes.as_slice(),
                        frames.archive.width,
                        frames.archive.height,
                    ) {
                        Ok(video) => Some(video),
                        Err(error) => {
                            log::warn!(
                                "Could not prepare browser menu MP4: {error:?}; keeping poster"
                            );
                            None
                        }
                    },
                    Err(_) => None,
                }
            } else {
                None
            }
        };
        #[cfg(target_arch = "wasm32")]
        let source = if video.is_some() {
            "/retail/werhd-menu.mp4 (browser decoder)"
        } else {
            "built-in WERHD menu poster"
        };
        let (texture, batch_texture) = batch.create_updatable_texture(
            &gpu.device,
            &gpu.queue,
            &frames.rgba,
            frames.archive.width,
            frames.archive.height,
            wgpu::FilterMode::Nearest,
        );
        Ok(Self {
            frames,
            source,
            texture,
            batch_texture,
            #[cfg(target_arch = "wasm32")]
            video,
            #[cfg(target_arch = "wasm32")]
            showing_video: false,
        })
    }

    fn step(&mut self, gpu: &GpuContext, elapsed_secs: f64) -> Result<BinkMovieStep, AssetError> {
        #[cfg(target_arch = "wasm32")]
        {
            let _ = elapsed_secs; // The browser's decoder owns MP4 time/looping.
            let Some(video) = self.video.as_mut() else {
                return Ok(BinkMovieStep::Unchanged);
            };
            match video.frame() {
                browser_video::FrameUpdate::Ready(rgba) => {
                    self.showing_video = true;
                    self.upload_frame(gpu, &rgba);
                    return Ok(BinkMovieStep::FrameUploaded);
                }
                browser_video::FrameUpdate::Failed => {
                    log::warn!("Browser menu MP4 is unavailable; keeping poster");
                    self.video = None;
                    self.source = "built-in WERHD menu poster";
                }
                // A buffering/pending frame retains the last valid texture;
                // only a failed decoder replaces it with the static poster.
                browser_video::FrameUpdate::Waiting => return Ok(BinkMovieStep::Unchanged),
                browser_video::FrameUpdate::Unchanged => return Ok(BinkMovieStep::Unchanged),
            }
            if self.showing_video {
                self.showing_video = false;
                self.upload_frame(gpu, &self.frames.rgba);
                return Ok(BinkMovieStep::FrameUploaded);
            }
            return Ok(BinkMovieStep::Unchanged);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            if !self.frames.advance(elapsed_secs)? {
                return Ok(BinkMovieStep::Unchanged);
            }
            self.upload_frame(gpu, &self.frames.rgba);
            Ok(BinkMovieStep::FrameUploaded)
        }
    }

    fn upload_frame(&self, gpu: &GpuContext, rgba: &[u8]) {
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(self.frames.archive.width * 4),
                rows_per_image: Some(self.frames.archive.height),
            },
            wgpu::Extent3d {
                width: self.frames.archive.width,
                height: self.frames.archive.height,
                depth_or_array_layers: 1,
            },
        );
    }
}

#[cfg(any(
    target_os = "ios",
    target_os = "macos",
    target_os = "android",
    target_arch = "wasm32",
    test
))]
enum FrameBytes<'a> {
    Borrowed(&'a [u8]),
    #[cfg(test)]
    Shared(Arc<Vec<u8>>),
}

#[cfg(any(
    target_os = "ios",
    target_os = "macos",
    target_os = "android",
    target_arch = "wasm32",
    test
))]
impl FrameBytes<'_> {
    fn as_slice(&self) -> &[u8] {
        match self {
            Self::Borrowed(bytes) => bytes,
            #[cfg(test)]
            Self::Shared(bytes) => bytes.as_slice(),
        }
    }
}

#[cfg(any(
    target_os = "ios",
    target_os = "macos",
    target_os = "android",
    target_arch = "wasm32",
    test
))]
struct FrameArchive<'a> {
    bytes: FrameBytes<'a>,
    payload_start: usize,
    offsets: Vec<usize>,
    width: u32,
    height: u32,
    fps: f64,
    key_interval: usize,
}

#[cfg(any(
    target_os = "ios",
    target_os = "macos",
    target_os = "android",
    target_arch = "wasm32",
    test
))]
impl<'a> FrameArchive<'a> {
    fn parse(bytes: &'a [u8]) -> Result<Self, AssetError> {
        Self::from_bytes(FrameBytes::Borrowed(bytes))
    }

    fn from_bytes(source: FrameBytes<'a>) -> Result<Self, AssetError> {
        let bytes = source.as_slice();
        const HEADER_SIZE: usize = 8 + 6 * 4;
        if bytes.len() < HEADER_SIZE || &bytes[..8] != b"VWMV0001" {
            return Err(invalid("unrecognized or truncated header"));
        }
        let field = |index: usize| {
            let start = 8 + index * 4;
            u32::from_le_bytes(bytes[start..start + 4].try_into().expect("checked header"))
        };
        let (width, height, fps_num, fps_den, frame_count, key_interval) =
            (field(0), field(1), field(2), field(3), field(4), field(5));
        let pixel_count = width.checked_mul(height);
        if width == 0
            || height == 0
            || pixel_count.is_none_or(|count| count > 16_777_216)
            || fps_num == 0
            || fps_den == 0
            || frame_count == 0
            || key_interval == 0
        {
            return Err(invalid(
                "invalid dimensions, frame rate, frame count or key interval",
            ));
        }
        let count = usize::try_from(frame_count).map_err(|_| invalid("frame count overflows"))?;
        let index_end = count
            .checked_add(1)
            .and_then(|count| count.checked_mul(8))
            .and_then(|size| HEADER_SIZE.checked_add(size))
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| invalid("truncated frame index"))?;
        let payload = &bytes[index_end..];
        let mut offsets = Vec::with_capacity(count + 1);
        for chunk in bytes[HEADER_SIZE..index_end].chunks_exact(8) {
            let offset = u64::from_le_bytes(chunk.try_into().expect("eight-byte index entry"));
            let offset = usize::try_from(offset).map_err(|_| invalid("frame offset overflows"))?;
            if offset > payload.len() || offsets.last().is_some_and(|previous| *previous >= offset)
            {
                return Err(invalid(
                    "frame offsets are unordered or outside the payload",
                ));
            }
            offsets.push(offset);
        }
        if offsets[0] != 0 || offsets[count] != payload.len() {
            return Err(invalid("frame index does not cover the payload"));
        }
        Ok(Self {
            bytes: source,
            payload_start: index_end,
            offsets,
            width,
            height,
            fps: f64::from(fps_num) / f64::from(fps_den),
            key_interval: key_interval as usize,
        })
    }

    fn frame_count(&self) -> usize {
        self.offsets.len() - 1
    }

    fn decode(&self, index: usize, previous: &mut Vec<u8>) -> Result<(), AssetError> {
        let Some((&start, &end)) = self.offsets.get(index).zip(self.offsets.get(index + 1)) else {
            return Err(invalid("frame index is out of range"));
        };
        let payload = &self.bytes.as_slice()[self.payload_start..];
        let png =
            image::load_from_memory_with_format(&payload[start..end], image::ImageFormat::Png)
                .map_err(|error| invalid(format!("frame {index} PNG: {error}")))?
                .into_rgba8();
        if png.width() != self.width || png.height() != self.height {
            return Err(invalid(format!(
                "frame {index} dimensions do not match the archive"
            )));
        }
        let decoded = png.into_raw();
        if index.is_multiple_of(self.key_interval) {
            *previous = decoded;
        } else {
            if previous.len() != decoded.len() {
                return Err(invalid("delta frame has no matching previous RGBA frame"));
            }
            for (pixel, delta) in previous.iter_mut().zip(decoded) {
                *pixel ^= delta;
            }
        }
        Ok(())
    }
}

#[cfg(any(
    target_os = "ios",
    target_os = "macos",
    target_os = "android",
    target_arch = "wasm32",
    test
))]
struct FrameStream<'a> {
    archive: FrameArchive<'a>,
    /// One restored frame; decoding temporarily holds one additional PNG RGBA
    /// frame, then drops it. The compressed archive is borrowed or Arc-shared,
    /// never copied into each menu session.
    rgba: Vec<u8>,
    next_frame: usize,
    accumulator_secs: f64,
}

#[cfg(any(
    target_os = "ios",
    target_os = "macos",
    target_os = "android",
    target_arch = "wasm32",
    test
))]
impl<'a> FrameStream<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self, AssetError> {
        let archive = FrameArchive::parse(bytes)?;
        Self::from_archive(archive)
    }

    #[cfg(test)]
    fn from_shared(bytes: Arc<Vec<u8>>) -> Result<Self, AssetError> {
        Self::from_archive(FrameArchive::from_bytes(FrameBytes::Shared(bytes))?)
    }

    fn from_archive(archive: FrameArchive<'a>) -> Result<Self, AssetError> {
        let mut rgba = Vec::new();
        archive.decode(0, &mut rgba)?;
        Ok(Self {
            archive,
            rgba,
            next_frame: 1,
            accumulator_secs: 0.0,
        })
    }

    fn advance(&mut self, elapsed_secs: f64) -> Result<bool, AssetError> {
        // A one-frame poster is a static texture, not a looping stream that
        // repeatedly decodes and uploads the same frame.
        if self.archive.frame_count() == 1 {
            return Ok(false);
        }
        if elapsed_secs.is_finite() {
            self.accumulator_secs += elapsed_secs.max(0.0);
        }
        let frame_time = 1.0 / self.archive.fps;
        let mut changed = false;
        // Match the existing menu player's bounded catch-up. Entry/exit slide
        // and suspension timers remain with the menu's existing clock owner.
        for _ in 0..4 {
            if self.accumulator_secs < frame_time {
                break;
            }
            self.accumulator_secs -= frame_time;
            if self.next_frame == self.archive.frame_count() {
                self.archive.decode(0, &mut self.rgba)?;
                self.next_frame = 1;
                self.accumulator_secs = 0.0;
                return Ok(true);
            }
            self.archive.decode(self.next_frame, &mut self.rgba)?;
            self.next_frame += 1;
            changed = true;
        }
        Ok(changed)
    }
}

#[cfg(any(
    target_os = "ios",
    target_os = "macos",
    target_os = "android",
    target_arch = "wasm32",
    test
))]
fn invalid(detail: impl Into<String>) -> AssetError {
    AssetError::ParseError {
        format: "WERHD menu frames".to_string(),
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageEncoder;

    #[test]
    fn browser_video_requires_visible_movie_and_foreground_document() {
        let mut gate = VideoPlaybackGate::default();
        assert!(
            !gate.playing(),
            "entry slide must keep the media clock stopped"
        );
        gate.menu_shown = true;
        assert!(gate.playing());
        gate.document_visible = false;
        assert!(
            !gate.playing(),
            "background tabs stop even without a redraw"
        );
        gate.document_visible = true;
        gate.window_active = false;
        assert!(
            !gate.playing(),
            "document visibility cannot override WindowActive"
        );
        gate.menu_shown = false;
        gate.window_active = true;
        assert!(
            !gate.playing(),
            "focus restore cannot restart a sliding movie"
        );
        gate.menu_shown = true;
        assert!(
            gate.playing(),
            "steady foreground menu resumes the same clock"
        );
    }

    #[test]
    fn browser_video_clock_uploads_new_media_frames_and_accepts_loop_rewind() {
        let mut clock = VideoFrameClock::default();
        assert!(clock.admit(0.0, true));
        assert!(!clock.admit(0.0, true));
        assert!(clock.admit(1.0 / 15.0, true));
        assert!(!clock.admit(f64::NAN, true));
        assert!(!clock.admit(f64::INFINITY, true));
        assert!(!clock.admit(-1.0, true));
        assert!(!clock.admit(1.0 / 15.0, true));
        assert!(
            clock.admit(0.0, true),
            "browser loop time rewinds naturally"
        );

        assert!(clock.admit(0.0, false));
        assert!(!clock.admit(1.0 / 60.0, false));
        assert!(!clock.admit(1.0 / 30.0, false));
        assert!(clock.admit(1.0 / 15.0, false));
    }

    fn fixture(frames: &[Vec<u8>], width: u32, height: u32, interval: usize) -> Vec<u8> {
        let mut payload = Vec::new();
        let mut offsets = vec![0_u64];
        for (index, frame) in frames.iter().enumerate() {
            let pixels: Vec<_> = if index.is_multiple_of(interval) {
                frame.clone()
            } else {
                frame
                    .iter()
                    .zip(&frames[index - 1])
                    .map(|(a, b)| a ^ b)
                    .collect()
            };
            image::codecs::png::PngEncoder::new(&mut payload)
                .write_image(&pixels, width, height, image::ExtendedColorType::Rgba8)
                .unwrap();
            offsets.push(payload.len() as u64);
        }
        let mut bytes = b"VWMV0001".to_vec();
        for field in [width, height, 15, 1, frames.len() as u32, interval as u32] {
            bytes.extend(field.to_le_bytes());
        }
        for offset in offsets {
            bytes.extend(offset.to_le_bytes());
        }
        bytes.extend(payload);
        bytes
    }

    #[test]
    fn keyframes_and_xor_deltas_restore_every_rgba_byte_and_loop() {
        let frames = vec![
            vec![10, 20, 30, 255, 40, 50, 60, 255],
            vec![11, 25, 30, 255, 40, 80, 90, 255],
            vec![100, 110, 120, 255, 130, 140, 150, 255],
            vec![101, 111, 123, 255, 131, 144, 153, 255],
        ];
        let bytes = fixture(&frames, 2, 1, 2);
        let mut stream = FrameStream::new(&bytes).unwrap();
        assert_eq!(stream.rgba, frames[0]);
        assert!(!stream.advance(1.0 / 30.0).unwrap());
        assert!(stream.advance(1.0 / 30.0).unwrap());
        assert_eq!(stream.rgba, frames[1]);
        for frame in &frames[2..] {
            assert!(stream.advance(1.0 / 15.0).unwrap());
            assert_eq!(&stream.rgba, frame);
        }
        assert!(stream.advance(1.0 / 15.0).unwrap());
        assert_eq!(stream.rgba, frames[0]);
        assert_eq!(stream.next_frame, 1);
    }

    #[test]
    fn catch_up_is_bounded_and_nonfinite_elapsed_does_not_poison_clock() {
        let frames = (0..8)
            .map(|value| vec![value, value, value, 255])
            .collect::<Vec<_>>();
        let bytes = fixture(&frames, 1, 1, 3);
        let mut stream = FrameStream::new(&bytes).unwrap();
        assert!(!stream.advance(f64::INFINITY).unwrap());
        assert!(!stream.advance(f64::NAN).unwrap());
        assert!(stream.advance(1.0).unwrap());
        assert_eq!(stream.rgba, frames[4]);
        assert_eq!(stream.next_frame, 5);
    }

    #[test]
    fn malformed_index_and_mismatched_png_dimensions_are_rejected() {
        let frames = vec![vec![1, 2, 3, 255], vec![4, 5, 6, 255]];
        let bytes = fixture(&frames, 1, 1, 2);
        assert!(FrameArchive::parse(&bytes[..31]).is_err());
        let mut corrupt = bytes.clone();
        corrupt[40..48].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(FrameArchive::parse(&corrupt).is_err());
        let mut wrong_size = bytes;
        wrong_size[8..12].copy_from_slice(&2_u32.to_le_bytes());
        assert!(FrameStream::new(&wrong_size).is_err());
    }

    #[test]
    fn shared_stream_keeps_one_archive_allocation_and_releases_its_owner() {
        let frames = vec![
            vec![1, 2, 3, 255],
            vec![7, 8, 9, 255],
            vec![11, 12, 13, 255],
        ];
        let shared = Arc::new(fixture(&frames, 1, 1, 2));
        let weak = Arc::downgrade(&shared);
        let mut first = FrameStream::from_shared(Arc::clone(&shared)).unwrap();
        let second = FrameStream::from_shared(Arc::clone(&shared)).unwrap();
        assert_eq!(Arc::strong_count(&shared), 3);
        for stream in [&first, &second] {
            let FrameBytes::Shared(owner) = &stream.archive.bytes else {
                panic!("owned stream must retain the existing Arc");
            };
            assert!(Arc::ptr_eq(owner, &shared));
        }
        drop(shared);
        assert!(first.advance(1.0 / 15.0).unwrap());
        assert_eq!(first.rgba, frames[1]);
        assert_eq!(
            second.rgba, frames[0],
            "decoded frames belong to each session"
        );
        drop(second);
        assert!(first.advance(1.0 / 15.0).unwrap());
        assert_eq!(first.rgba, frames[2]);
        drop(first);
        assert!(
            weak.upgrade().is_none(),
            "no leaked static archive allocation"
        );
    }

    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn browser_poster_preserves_the_original_first_png_and_never_animates() {
        use std::io::{Read, Seek, SeekFrom};

        // Read only the first compressed frame, never the 73 MB archive.
        let mut original = std::fs::File::open(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("art/branding/werhd-menu.wmvframes"),
        )
        .unwrap();
        let mut header = [0_u8; 32];
        original.read_exact(&mut header).unwrap();
        let count = u32::from_le_bytes(header[24..28].try_into().unwrap()) as u64;
        let mut first_offsets = [0_u8; 16];
        original.read_exact(&mut first_offsets).unwrap();
        assert_eq!(&first_offsets[..8], &[0_u8; 8]);
        let length = u64::from_le_bytes(first_offsets[8..].try_into().unwrap()) as usize;
        original
            .seek(SeekFrom::Start(32 + (count + 1) * 8))
            .unwrap();
        let mut first_png = vec![0_u8; length];
        original.read_exact(&mut first_png).unwrap();

        let poster = include_bytes!("../../art/branding/werhd-menu-poster.wmvframes");
        let archive = FrameArchive::parse(poster).unwrap();
        assert_eq!(archive.frame_count(), 1);
        assert_eq!(
            &archive.bytes.as_slice()[archive.payload_start..],
            first_png
        );
        let mut stream = FrameStream::new(poster).unwrap();
        let initial = stream.rgba.clone();
        assert!(!stream.advance(60.0).unwrap());
        assert_eq!(stream.rgba, initial);
    }
}
