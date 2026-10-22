//! A bounded presentation-only slot for the approved browser menu MP4.
//!
//! The JavaScript ContentStore checks its catalog digest before installation.
//! This slot cannot modify mounted retail assets or any frozen game capability.

use std::sync::Arc;

const MAX_MENU_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
struct MenuMedia {
    bytes: Option<Arc<Vec<u8>>>,
}

impl MenuMedia {
    fn install(&mut self, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.len() < 16 || bytes.len() > MAX_MENU_BYTES || &bytes[4..8] != b"ftyp" {
            return Err("invalid compressed menu MP4".into());
        }
        let first_box = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        if !(16..=bytes.len()).contains(&first_box) {
            return Err("invalid menu MP4 file-type box".into());
        }
        if let Some(installed) = &self.bytes {
            return if installed.as_slice() == bytes.as_slice() {
                Ok(())
            } else {
                Err("the menu MP4 is already installed".into())
            };
        }
        self.bytes = Some(Arc::new(bytes));
        Ok(())
    }
}

#[cfg(target_arch = "wasm32")]
thread_local! {
    static MEDIA: std::cell::RefCell<MenuMedia> = std::cell::RefCell::new(MenuMedia::default());
}

#[cfg(target_arch = "wasm32")]
pub fn install(bytes: Vec<u8>) -> Result<(), String> {
    MEDIA.with(|media| media.borrow_mut().install(bytes))
}

#[cfg(target_arch = "wasm32")]
pub fn current() -> Option<Arc<Vec<u8>>> {
    MEDIA.with(|media| media.borrow().bytes.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mp4() -> Vec<u8> {
        let mut bytes = 16_u32.to_be_bytes().to_vec();
        bytes.extend_from_slice(b"ftypisom\0\0\0\0");
        bytes
    }

    #[test]
    fn one_bounded_presentation_slot_is_idempotent_but_cannot_replace_content() {
        let mut media = MenuMedia::default();
        media.install(mp4()).unwrap();
        let original = media.bytes.clone().unwrap();
        media.install(mp4()).unwrap();
        assert!(Arc::ptr_eq(&original, media.bytes.as_ref().unwrap()));
        let mut other = mp4();
        other.push(1);
        assert!(media.install(other).is_err());
        assert_eq!(media.bytes.as_ref().unwrap().as_slice(), mp4());
    }

    #[test]
    fn invalid_or_unbounded_media_never_occupies_the_slot() {
        for invalid in [Vec::new(), vec![0; 16], vec![0; MAX_MENU_BYTES + 1], {
            let mut bytes = mp4();
            bytes[..4].copy_from_slice(&32_u32.to_be_bytes());
            bytes
        }] {
            let mut media = MenuMedia::default();
            assert!(media.install(invalid).is_err());
            assert!(media.bytes.is_none());
        }
    }
}
