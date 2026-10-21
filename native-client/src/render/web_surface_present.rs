//! Browser swapchain transport for the complete native-rendered frame.
//!
//! WebGPU canvas textures expose UNORM/RENDER_ATTACHMENT, while the stock shell
//! compositor requires an sRGB surface with compatible encoded-byte views and
//! COPY_SRC/COPY_DST. All native drawing therefore targets a normal offscreen
//! sRGB texture. Only the final, already-composited bytes pass through here.

pub(crate) struct WebSurfacePresenter {
    texture: wgpu::Texture,
    group: wgpu::BindGroup,
    pipeline: wgpu::RenderPipeline,
    device: wgpu::Device,
    queue: wgpu::Queue,
}

impl WebSurfacePresenter {
    pub(crate) fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        width: u32,
        height: u32,
        render_format: wgpu::TextureFormat,
        canvas_format: wgpu::TextureFormat,
    ) -> Self {
        let encoded_format = render_format.remove_srgb_suffix();
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Native complete frame for WebGPU canvas"),
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: render_format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[encoded_format],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor {
            label: Some("Native completed frame encoded-byte view"),
            format: Some(encoded_format),
            usage: Some(wgpu::TextureUsages::TEXTURE_BINDING),
            ..Default::default()
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("WebGPU canvas transport layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }],
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Native completed frame encoded bytes"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&view),
            }],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Native frame to browser canvas byte transport"),
            source: wgpu::ShaderSource::Wgsl(include_str!("web_surface_present.wgsl").into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("WebGPU canvas transport pipeline layout"),
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("WebGPU canvas exact encoded-byte transport"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: canvas_format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });
        Self {
            texture,
            group,
            pipeline,
            device: device.clone(),
            queue: queue.clone(),
        }
    }

    pub(crate) fn frame(&self, output: wgpu::SurfaceTexture) -> WebSurfaceFrame {
        WebSurfaceFrame {
            texture: self.texture.clone(),
            output,
            group: self.group.clone(),
            pipeline: self.pipeline.clone(),
            device: self.device.clone(),
            queue: self.queue.clone(),
        }
    }
}

/// Matches the native SurfaceTexture call sites without introducing a second
/// renderer, different scene state, or a CPU framebuffer copy.
pub struct WebSurfaceFrame {
    pub texture: wgpu::Texture,
    output: wgpu::SurfaceTexture,
    group: wgpu::BindGroup,
    pipeline: wgpu::RenderPipeline,
    device: wgpu::Device,
    queue: wgpu::Queue,
}

impl WebSurfaceFrame {
    pub fn present(self) {
        let destination = self.output.texture.create_view(&Default::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Native frame browser presentation"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Copy native encoded pixels to WebGPU canvas"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &destination,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.group, &[]);
            pass.draw(0..3, 0..1);
        }
        // The caller already submitted all original render passes. Queue order
        // makes their final pixels visible here without any blocking device poll.
        self.queue.submit([encoder.finish()]);
        self.output.present();
    }
}
