// The same authoritative A bytes used by CPU surface admission. World origin
// belongs to ShroudBuffer; camera rounding belongs to BatchRenderer. Sampling
// texel centers through floor preserves native pixels at fractional zoom/scroll.
struct TacticalASource { origin: vec2f, enabled: u32, pad: u32 };
@group(0) @binding(1) var tactical_a: texture_2d<f32>;
@group(0) @binding(2) var<uniform> tactical_a_source: TacticalASource;
fn tactical_a_at(position: vec2f) -> u32 {
    // Fragment @builtin(position) is the rasterization point in framebuffer
    // pixels, even when its user-defined field is named clip_position.
    // https://www.w3.org/TR/WGSL/#builtin-values-position
    if tactical_a_source.enabled == 0u { return 127u; }
    let pixel = vec2i(floor(position / camera.zoom + camera.camera_pos - tactical_a_source.origin));
    if any(pixel < vec2i(0)) || any(pixel >= vec2i(textureDimensions(tactical_a))) { return 127u; }
    return u32(round(textureLoad(tactical_a, pixel, 0).r * 255.0));
}
