// Platform presentation only: native passes already produced the final encoded
// RGB565 presentation bytes. Read them without sRGB decoding and store those same
// values into the browser's UNORM canvas, with no filtering or second quantization.
@group(0) @binding(0) var encoded_frame: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    let x = f32((index << 1u) & 2u);
    let y = f32(index & 2u);
    return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
    return textureLoad(encoded_frame, vec2i(position.xy), 0);
}
