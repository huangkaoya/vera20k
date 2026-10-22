//! Browser glyph coverage. GAME.FNT continues to own every advance and cell size.
use wasm_bindgen::JsCast;

pub(crate) struct Rasterizer {
    canvas: web_sys::HtmlCanvasElement,
    context: web_sys::CanvasRenderingContext2d,
    rows: u32,
}

impl Rasterizer {
    pub(crate) fn new(rows: u32) -> Option<Self> {
        if rows == 0 {
            return None;
        }
        let canvas: web_sys::HtmlCanvasElement = web_sys::window()?
            .document()?
            .create_element("canvas")
            .ok()?
            .dyn_into()
            .ok()?;
        let context = canvas.get_context("2d").ok()??.dyn_into().ok()?;
        Some(Self {
            canvas,
            context,
            rows,
        })
    }

    pub(super) fn face_names(&self) -> (String, String) {
        ("WERHD UI Medium".into(), "browser system sans-serif".into())
    }

    pub(crate) fn glyph(&mut self, codepoint: u16, width: u32) -> Option<Vec<u8>> {
        let ch = char::from_u32(u32::from(codepoint))?;
        if width == 0 {
            return None;
        }
        self.canvas.set_width(width);
        self.canvas.set_height(self.rows);
        let context = &self.context;
        context.set_font(&format!("500 {}px 'WERHD UI', sans-serif", self.rows));
        context.set_text_baseline("alphabetic");
        let text = ch.to_string();
        let metrics = context.measure_text(&text).ok()?;
        let left = metrics.actual_bounding_box_left();
        let right = metrics.actual_bounding_box_right();
        let ascent = metrics.actual_bounding_box_ascent();
        let descent = metrics.actual_bounding_box_descent();
        let ink_width = left + right;
        let ink_height = ascent + descent;
        if ink_width > 0.0 && ink_height > 0.0 {
            let scale = (f64::from(width) / ink_width)
                .min(f64::from(self.rows) / ink_height)
                .min(1.0);
            let x = (f64::from(width) - ink_width * scale) * 0.5 + left * scale;
            let y = (f64::from(self.rows) - ink_height * scale) * 0.5 + ascent * scale;
            context.set_transform(scale, 0.0, 0.0, scale, x, y).ok()?;
            context.set_fill_style_str("white");
            context.fill_text(&text, 0.0, 0.0).ok()?;
        }
        let mut rgba = context
            .get_image_data(0.0, 0.0, f64::from(width), f64::from(self.rows))
            .ok()?
            .data()
            .0;
        for pixel in rgba.chunks_exact_mut(4) {
            pixel[..3].fill(255);
        }
        Some(rgba)
    }
}
