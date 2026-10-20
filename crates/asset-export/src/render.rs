// Reuse upstream's CPU voxel implementation, including its own native raster and
// normal tables. There is deliberately no wgpu/window/audio dependency here.
#[allow(dead_code)]
#[path = "../../../vendor/vera20k/src/render/vxl_normals.rs"]
pub mod vxl_normals;
#[allow(dead_code)]
#[path = "../../../vendor/vera20k/src/render/vxl_raster.rs"]
pub mod vxl_raster;
