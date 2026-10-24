//! Process-font reuse decisions need no GPU or browser rasterizer.

use super::{BitFont, FntBuildIdentity, tests::make_test_font};
use crate::assets::fnt_file::FntFile;

fn parsed_font(ink: u8) -> FntFile {
    const HEADER: usize = 28;
    const LOOKUP: usize = 65536 * 2;
    let mut bytes = vec![0_u8; HEADER + LOOKUP + 2];
    for (index, word) in [0x546e_6f66_u32, 20, 1, 1, 2, 1, 2].into_iter().enumerate() {
        bytes[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    bytes[HEADER + usize::from(b'A') * 2] = 1;
    bytes[HEADER + LOOKUP..].copy_from_slice(&[1, ink]);
    FntFile::from_bytes(&bytes).expect("one-glyph FNT")
}

fn identified_font(source: &FntFile, modern: bool) -> BitFont {
    let mut font = make_test_font(&[(u16::from(b'A'), 1)], 1);
    font.source_identity = (!modern)
        .then(|| source.source_identity().cloned())
        .flatten();
    font.build_identity = FntBuildIdentity::new(source.source_identity(), modern);
    font
}

#[test]
fn ui_font_reuse_accepts_identical_parsed_sources_in_same_mode() {
    let original = parsed_font(0x80);
    let incoming = parsed_font(0x80);
    for modern in [false, true] {
        let font = identified_font(&original, modern);
        assert!(font.can_reuse_for_ui(&incoming, modern));
        assert_eq!(font.text_width("A"), 2);
    }
}

#[test]
fn ui_font_reuse_rejects_changed_source_even_with_identical_metrics() {
    let original = parsed_font(0x80);
    let changed = parsed_font(0);
    assert_eq!(original.cell_height, changed.cell_height);
    assert_eq!(original.bitmap_rows, changed.bitmap_rows);
    assert_eq!(original.glyph(u16::from(b'A')).unwrap().width, 1);
    assert_eq!(changed.glyph(u16::from(b'A')).unwrap().width, 1);
    for modern in [false, true] {
        let font = identified_font(&original, modern);
        assert!(!font.can_reuse_for_ui(&changed, modern));
    }
}

#[test]
fn ui_font_reuse_rejects_requested_raster_mode_changes() {
    let source = parsed_font(0x80);
    for modern in [false, true] {
        let font = identified_font(&source, modern);
        assert!(!font.can_reuse_for_ui(&source, !modern));
    }
}

#[test]
fn ui_font_reuse_rejects_fallback_and_missing_source_identity() {
    let source = parsed_font(0x80);
    let fallback = make_test_font(&[(u16::from(b'A'), 1)], 1);
    assert!(fallback.build_identity.is_none());
    for modern in [false, true] {
        assert!(!fallback.can_reuse_for_ui(&source, modern));
        assert!(FntBuildIdentity::new(None, modern).is_none());
        let identity = FntBuildIdentity::new(source.source_identity(), modern).unwrap();
        assert!(!identity.matches(None, modern));
    }
}

#[test]
fn ui_font_reuse_preserves_retail_capture_identity_rules() {
    let source = parsed_font(0x80);
    let retail = identified_font(&source, false);
    let modern = identified_font(&source, true);
    assert_eq!(
        retail.capture_observation().source_identity,
        source.source_identity()
    );
    assert!(modern.capture_observation().source_identity.is_none());
    assert!(modern.can_reuse_for_ui(&source, true));
}
