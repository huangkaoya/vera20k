// Bullet leaves 00494B60/00497FD0 overwrite an admitted body pixel;
// 00492D20/00496820 halve an admitted shadow pixel. Neither changes Z.
// Consequently the final word depends only on the last admitted body and
// admitted shadows after it. Atomic selection preserves command order without
// serializing one render-pass pair per overlapping piece.
struct ReadOnlyPixel { body: atomic<u32>, shadows: atomic<u32> };
@group(3) @binding(0) var<storage, read_write> read_only_pixels: array<ReadOnlyPixel>;

fn read_only_address(input: VertexOutput) -> u32 {
    let p = vec2u(input.position.xy);
    let width = textureDimensions(old_depth).x;
    let rows = arrayLength(&read_only_pixels) / width;
    return (p.y % rows) * width + p.x;
}

@fragment
fn fs_read_only_body(input: VertexOutput) -> @location(0) vec4f {
    let admitted = admitted_pixel(input);
    // The bound native Convert/LightConvert result is the same body color as
    // fs_body. Recover its RGB565 word before the packed destination operation.
    let rgb = vec3u(round(clamp(srgb_encode(body_color(input, admitted.index)),
        vec3f(0.0), vec3f(1.0)) * 255.0));
    let word = ((rgb.r >> 3u) << 11u) | ((rgb.g >> 2u) << 5u) | (rgb.b >> 3u);
    atomicMax(&read_only_pixels[read_only_address(input)].body,
        (input.command_ordinal << 16u) | word);
    return vec4f(0.0); // Color writes are disabled; only the scratch atomic changes.
}

@fragment
fn fs_read_only_shadow(input: VertexOutput) -> @location(0) vec4f {
    let admitted = admitted_pixel(input);
    let address = read_only_address(input);
    let last_body = atomicLoad(&read_only_pixels[address].body) >> 16u;
    if input.command_ordinal > last_body {
        atomicAdd(&read_only_pixels[address].shadows, 1u);
    }
    return vec4f(0.0);
}
