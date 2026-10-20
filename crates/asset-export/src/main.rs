//! Local-only retail art preprocessing. Simulation stays in the WASM bridge.
//! All decoders/rasterizers are the vendored VERA owners; no diagnostic frames.
use anyhow::{Context, Result, bail};
use image::{Rgba, RgbaImage};
use serde::Serialize;
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
pub use vera20k_core::{assets, map, rules, sim, util};
mod render;
use assets::{
    asset_manager::{AssetManager, MediaArchiveMode},
    hva_file::HvaFile,
    pal_file::Palette,
    shp_file::ShpFile,
    vpl_file::VplFile,
    vxl_file::VxlFile,
};
use map::theater::{TheaterData, TileKey};
use render::vxl_raster::{VxlRenderParams, VxlSprite};
use rules::{art_data::ArtRegistry, ini_parser::IniFile};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Frame {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    offset_x: f32,
    offset_y: f32,
    facing: u8,
    animation: u8,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sprite {
    image: String,
    remap_image: String,
    cameo: Option<String>,
    source: String,
    kind: String,
    width: u32,
    height: u32,
    frames: Vec<Frame>,
    foundation: [u16; 2],
}
struct RawFrame {
    image: RgbaImage,
    mask: RgbaImage,
    offset_x: f32,
    offset_y: f32,
    facing: u8,
    animation: u8,
}
struct Exporter {
    out: PathBuf,
    sprites: BTreeMap<String, Sprite>,
    warnings: Vec<String>,
    colors: Vec<serde_json::Value>,
    names: BTreeMap<String, String>,
}

fn main() -> Result<()> {
    let mut retail = PathBuf::from("/Users/bxy/Library/Application Support/VERA20k/retail-assets");
    let mut out = PathBuf::from("public/generated");
    let mut maps = Vec::new();
    let mut names_only = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--retail" | "--asset-root" => {
                retail = PathBuf::from(args.next().context("retail path")?)
            }
            "--out" => out = PathBuf::from(args.next().context("output path")?),
            "--map" => maps.push(args.next().context("map name")?),
            "--names-only" => names_only = true,
            "--help" => {
                println!("asset-export [--retail DIR] [--out DIR] [--map XMP29U2.MAP]...");
                return Ok(());
            }
            _ => bail!("unknown argument {arg}"),
        }
    }
    if names_only {
        let assets = AssetManager::new(&retail, MediaArchiveMode::STOCK_DIGITAL)?;
        let rules = load_ini(&assets, "RULESMD.INI")?;
        let csf = assets
            .get_ref("RA2MD.CSF")
            .and_then(|bytes| assets::csf_file::CsfFile::from_bytes(bytes).ok());
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(out.join("catalog.json"))?)?;
        manifest["names"] = serde_json::to_value(localized_type_names(&rules, csf.as_ref()))?;
        let bytes = serde_json::to_vec(&manifest)?;
        std::fs::write(out.join("catalog.json"), &bytes)?;
        std::fs::write(out.join("manifest.json"), &bytes)?;
        eprintln!(
            "Updated localized CSF names for {} types without rewriting any PNG",
            manifest["names"].as_object().map_or(0, |names| names.len())
        );
        return Ok(());
    }
    if maps.is_empty() {
        maps = vec!["XMP29U2.MAP".into(), "XMP03T4.MAP".into()];
    }
    std::fs::create_dir_all(out.join("sprites"))?;
    std::fs::create_dir_all(out.join("maps"))?;
    let mut export = Exporter {
        out,
        sprites: BTreeMap::new(),
        warnings: Vec::new(),
        colors: Vec::new(),
        names: BTreeMap::new(),
    };
    let mut map_manifest = Vec::new();
    for name in maps {
        eprintln!("Exporting actual retail map {name}");
        match export.export_map(&retail, &name) {
            Ok(value) => map_manifest.push(value),
            Err(error) => {
                eprintln!("{name}: {error:#}");
                export.warnings.push(format!("{name}: {error:#}"));
            }
        }
    }
    if map_manifest.is_empty() {
        bail!("no retail map exported");
    }
    let manifest = json!({"schema":1,"generator":"VERA retail CPU decoders + vxl_raster; local assets only",
        "maps":map_manifest,"sprites":export.sprites,"warnings":export.warnings,"colors":export.colors,"names":export.names});
    let bytes = serde_json::to_vec(&manifest)?;
    std::fs::write(export.out.join("manifest.json"), &bytes)?;
    std::fs::write(export.out.join("catalog.json"), &bytes)?;
    eprintln!(
        "Exported {} maps, {} real sprites, {} unavailable art entries",
        manifest["maps"].as_array().unwrap().len(),
        manifest["sprites"].as_object().unwrap().len(),
        manifest["warnings"].as_array().unwrap().len()
    );
    Ok(())
}

impl Exporter {
    fn export_map(&mut self, retail: &Path, name: &str) -> Result<serde_json::Value> {
        let mut assets = AssetManager::new(retail, MediaArchiveMode::STOCK_DIGITAL)
            .context("open retail assets")?;
        let map = map::source::load_map_by_name_or_path_with_assets(retail, name, &assets)?.map;
        let csf = assets
            .get_ref("RA2MD.CSF")
            .and_then(|bytes| assets::csf_file::CsfFile::from_bytes(bytes).ok());
        let title = map::scenario_sources::list_skirmish_scenario_records_with_assets(
            retail,
            &mut assets,
            csf.as_ref(),
        )?
        .into_iter()
        .find(|record| record.file_name.eq_ignore_ascii_case(name))
        .map(|record| record.display_name)
        .or_else(|| map.basic.name.clone())
        .unwrap_or_else(|| name.to_owned());
        let rules_ini = load_ini(&assets, "RULESMD.INI")?;
        if self.names.is_empty() {
            self.names = localized_type_names(&rules_ini, csf.as_ref());
        }
        if self.colors.is_empty() {
            let schemes = rules::color_scheme::parse_color_schemes(&rules_ini);
            self.colors = (0..8)
                .filter_map(|priority| {
                    let scheme =
                        schemes.get(rules::color_scheme::scheme_entry_for_priority(priority))?;
                    let rgb = rules::color_scheme::hsv_to_rgb(scheme.hsv);
                    let ramp =
                        rules::house_colors::build_scheme_ramp(scheme.hsv).map(|c| [c.r, c.g, c.b]);
                    Some(json!({"id":priority,"name":scheme.name,"rgb":rgb,
                    "hex":format!("#{:02x}{:02x}{:02x}",rgb[0],rgb[1],rgb[2]),"ramp":ramp}))
                })
                .collect();
        }
        let art_ini = load_ini(&assets, "ARTMD.INI")?;
        let art = ArtRegistry::from_ini(&art_ini);
        let theater =
            map::theater::load_theater(&mut assets, &map.header.theater).context("load theater")?;
        // The presentation owner resolves invalid/sparse authored cells to the
        // theater's actual Clear tile. Raw Pack5 IDs alone leave black holes.
        let terrain_rules = rules::terrain_rules::TerrainRules::from_ini(&rules_ini);
        let registry =
            rules::overlay_types::OverlayTypeRegistry::from_ini(&rules_ini, Some(&art_ini));
        let resolved = map::resolved_terrain::ResolvedTerrainGrid::build(
            &map,
            Some(&theater),
            Some(&assets),
            Some(&terrain_rules),
            Some(&registry),
            true,
            0,
        );
        let render_cells: Vec<map::map_file::MapCell> = resolved
            .cells()
            .iter()
            .filter(|cell| {
                map::playfield::size_diamond_contains(
                    map.header.width as i32,
                    map.header.height as i32,
                    (cell.rx as i16, cell.ry as i16),
                )
            })
            .map(|cell| {
                let (tile, sub) = resolved.presentation_tile(cell);
                map::map_file::MapCell {
                    rx: cell.rx,
                    ry: cell.ry,
                    tile_index: i32::from(tile),
                    sub_tile: sub,
                    z: cell.level,
                }
            })
            .collect();
        let needed = map::theater::collect_used_tiles(
            &render_cells
                .iter()
                .map(|c| (c.tile_index, c.sub_tile))
                .collect::<Vec<_>>(),
        );
        let tiles =
            map::theater::load_tile_images(&assets, &theater.lookup, &theater.iso_palette, &needed);
        if tiles.is_empty() {
            bail!("map has no decoded terrain images");
        }
        let mut min_x = i32::MAX;
        let mut min_y = i32::MAX;
        let mut max_x = i32::MIN;
        let mut max_y = i32::MIN;
        for cell in &render_cells {
            if let Some(tile) = tiles.get(&TileKey {
                tile_id: cell.tile_index as u16,
                sub_tile: cell.sub_tile,
                variant: 0,
            }) {
                let (sx, sy) = map::terrain::iso_to_screen(cell.rx, cell.ry, cell.z);
                let x = sx as i32 + tile.offset_x;
                let y = sy as i32 + tile.offset_y;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x + tile.width as i32);
                max_y = max_y.max(y + tile.height as i32);
            }
        }
        // Margin keeps tree crowns and coast edge pixels within the image.
        min_x -= 200;
        min_y -= 220;
        max_x += 200;
        max_y += 140;
        let width = (max_x - min_x) as u32;
        let height = (max_y - min_y) as u32;
        if u64::from(width) * u64::from(height) > 100_000_000 {
            bail!("map bitmap exceeds local export budget {width}x{height}");
        }
        let mut terrain = RgbaImage::new(width, height);
        let mut sorted: Vec<_> = render_cells.iter().collect();
        sorted.sort_by_key(|c| (u32::from(c.rx) + u32::from(c.ry), c.rx));
        let mut heights = HashMap::new();
        for cell in sorted {
            heights.insert((cell.rx, cell.ry), cell.z);
            if let Some(tile) = tiles.get(&TileKey {
                tile_id: cell.tile_index as u16,
                sub_tile: cell.sub_tile,
                variant: 0,
            }) {
                let (sx, sy) = map::terrain::iso_to_screen(cell.rx, cell.ry, cell.z);
                blit_raw(
                    &mut terrain,
                    &tile.rgba,
                    tile.width,
                    tile.height,
                    i64::from(sx as i32 + tile.offset_x - min_x),
                    i64::from(sy as i32 + tile.offset_y - min_y),
                );
            }
        }
        // Static overlay art (ore, rocks, walls). Dynamic units/buildings are
        // not baked: their only live state comes from WASM snapshots.
        let registry =
            rules::overlay_types::OverlayTypeRegistry::from_ini(&rules_ini, Some(&art_ini));
        let mut overlay_cache: HashMap<u8, Option<ShpFile>> = HashMap::new();
        for cell in &map.overlays {
            let shp = overlay_cache.entry(cell.overlay_id).or_insert_with(|| {
                let id = registry.name(cell.overlay_id)?;
                let image = art.resolve_overlay_image_id(id, &rules_ini);
                load_shp(&assets, &art, &image, &theater, &map.header.theater).map(|(_, s)| s)
            });
            if let Some(shp) = shp.as_ref() {
                let z = *heights.get(&(cell.rx, cell.ry)).unwrap_or(&0);
                let (sx, sy) = map::terrain::iso_to_screen(cell.rx, cell.ry, z);
                let flags = registry.flags(cell.overlay_id);
                let palette = if flags.is_some_and(|f| f.tiberium) {
                    &theater.tiberium_palette
                } else if flags.is_some_and(|f| f.wall || f.is_veins || f.is_veinhole_monster) {
                    &theater.unit_palette
                } else {
                    &theater.iso_palette
                };
                let frame = usize::from(cell.frame).min(shp.frames.len().saturating_sub(1));
                if let Some(raw) = shp_raw(shp, frame, palette, (0, 0), 0, 0) {
                    let extra = flags.map_or(0., |f| f.y_draw_offset());
                    blit_image(
                        &mut terrain,
                        &raw.image,
                        (sx + 30. + raw.offset_x - min_x as f32) as i64,
                        (sy + 15. + extra + raw.offset_y - min_y as f32) as i64,
                    );
                }
            }
        }
        let mut static_objects = map.terrain_objects.iter().collect::<Vec<_>>();
        static_objects.sort_by_key(|o| (u32::from(o.rx) + u32::from(o.ry), o.rx));
        for object in static_objects {
            let rules_image = rules_ini
                .section(&object.name)
                .map(|s| s.read_string("Image", &object.name, 64))
                .unwrap_or_else(|| object.name.clone());
            let id = art.resolve_effective_image_id(&object.name, &rules_image);
            if let Some((_, shp)) = load_shp(&assets, &art, &id, &theater, &map.header.theater) {
                let z = *heights.get(&(object.rx, object.ry)).unwrap_or(&0);
                let (sx, sy) = map::terrain::iso_to_screen(object.rx, object.ry, z);
                // Match VERA overlay_atlas: ordinary terrain uses ISO;
                // only ore-spawning terrain objects use the Unit palette.
                let palette = if rules_ini
                    .section_or_empty(&object.name)
                    .read_bool("SpawnsTiberium", false)
                {
                    &theater.unit_palette
                } else {
                    &theater.iso_palette
                };
                if let Some(raw) = shp_raw(&shp, 0, palette, art.draw_offsets(&id), 0, 0) {
                    blit_image(
                        &mut terrain,
                        &raw.image,
                        (sx + 30. + raw.offset_x - min_x as f32) as i64,
                        (sy + 15. + raw.offset_y - min_y as f32) as i64,
                    );
                }
            }
        }
        let stem = safe(name);
        let image_name = format!("maps/{stem}.png");
        terrain.save(self.out.join(&image_name))?;
        let mini_name = format!("maps/{stem}-mini.png");
        image::imageops::thumbnail(&terrain, 480, 260).save(self.out.join(&mini_name))?;
        let mut types: BTreeMap<String, String> = BTreeMap::new();
        for (registry, kind) in [
            ("BuildingTypes", "structure"),
            ("VehicleTypes", "unit"),
            ("InfantryTypes", "infantry"),
            ("AircraftTypes", "aircraft"),
        ] {
            if let Some(section) = rules_ini.section(registry) {
                for (_, id) in section.raw_entries() {
                    types.insert(id.to_uppercase(), kind.into());
                }
            }
        }
        // Export every actual registered object with available art. This means
        // sidebar production never needs invented stand-in unit graphics.
        for entity in &map.entities {
            types
                .entry(entity.type_id.to_uppercase())
                .or_insert_with(|| {
                    match entity.category {
                        map::entities::EntityCategory::Infantry => "infantry",
                        map::entities::EntityCategory::Structure => "structure",
                        map::entities::EntityCategory::Aircraft => "aircraft",
                        _ => "unit",
                    }
                    .into()
                });
        }
        for (id, kind) in types {
            if self.sprites.contains_key(&id) {
                continue;
            }
            if let Err(error) = self.export_sprite(
                &assets,
                &rules_ini,
                &art_ini,
                &art,
                &theater,
                &map.header.theater,
                &id,
                &kind,
            ) {
                self.warnings.push(format!("{id}: {error:#}"));
            }
        }
        let starts = map::waypoints::multiplayer_start_waypoints(&map.waypoints);
        let cells = render_cells
            .iter()
            .map(|c| json!({"rx":c.rx,"ry":c.ry,"z":c.z}))
            .collect::<Vec<_>>();
        Ok(
            json!({"id":name.to_uppercase(),"title":title,"theater":map.header.theater,
            "image":format!("/generated/{image_name}"),"minimap":format!("/generated/{mini_name}"),
            "width":width,"height":height,"originX":min_x,"originY":min_y,
            "localLeft":map.header.local_left,"localTop":map.header.local_top,"localWidth":map.header.local_width,"localHeight":map.header.local_height,
            "starts":starts,"cells":cells}),
        )
    }

    fn export_sprite(
        &mut self,
        assets: &AssetManager,
        rules: &IniFile,
        art_ini: &IniFile,
        art: &ArtRegistry,
        theater: &TheaterData,
        theater_name: &str,
        id: &str,
        kind: &str,
    ) -> Result<()> {
        let rules_image = rules
            .section(id)
            .map(|s| s.read_string("Image", id, 64))
            .unwrap_or_else(|| id.to_owned());
        let image = art.resolve_effective_image_id(id, &rules_image);
        let metadata = art.resolve_metadata_entry(id, &rules_image);
        let mut frames = Vec::new();
        let source;
        let use_voxel = kind == "unit" || kind == "aircraft" || metadata.is_some_and(|e| e.voxel);
        if use_voxel && assets.contains(&format!("{image}.VXL")) {
            source = format!("{image}.VXL");
            let body = VxlFile::from_bytes(&assets.get(&source).context("missing VXL")?)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            let hva = assets
                .get(&format!("{image}.HVA"))
                .and_then(|b| HvaFile::from_bytes(&b).ok());
            let vpl = assets
                .get("VOXELS.VPL")
                .and_then(|b| VplFile::from_bytes(&b).ok());
            let mut parts = Vec::new();
            for suffix in ["TUR", "BARL"] {
                if let Some(bytes) = assets.get(&format!("{image}{suffix}.VXL")) {
                    if let Ok(vxl) = VxlFile::from_bytes(&bytes) {
                        let hva = assets
                            .get(&format!("{image}{suffix}.HVA"))
                            .and_then(|b| HvaFile::from_bytes(&b).ok());
                        parts.push((vxl, hva));
                    }
                }
            }
            for step in 0..32u8 {
                let params = VxlRenderParams {
                    facing: step * 8,
                    ..Default::default()
                };
                let mut layers = vec![render::vxl_raster::render_vxl(
                    &body,
                    hva.as_ref(),
                    &params,
                    vpl.as_ref(),
                )];
                layers.extend(parts.iter().map(|(v, h)| {
                    render::vxl_raster::render_vxl(v, h.as_ref(), &params, vpl.as_ref())
                }));
                let sprite = combine_voxels(&layers);
                let (rgba, mask) = indices_rgba(
                    &sprite.palette_indices,
                    sprite.width,
                    sprite.height,
                    &theater.unit_palette,
                );
                frames.push(RawFrame {
                    image: rgba,
                    mask,
                    offset_x: sprite.offset_x,
                    offset_y: sprite.offset_y,
                    facing: step * 8,
                    animation: 0,
                });
            }
        } else {
            let (file, shp) = load_shp(assets, art, &image, theater, theater_name)
                .context("no retail SHP/VXL art")?;
            source = file;
            let offset = metadata
                .map(|e| (e.x_draw_offset, e.y_draw_offset))
                .unwrap_or_default();
            if kind == "infantry" {
                let registry = rules::infantry_sequence::parse_infantry_sequence_registry(art_ini);
                let seq = metadata
                    .and_then(|e| e.sequence.as_ref())
                    .and_then(|name| registry.get(&name.to_uppercase()));
                for (animation, key) in [(0, "READY"), (1, "WALK")] {
                    if let Some(def) = seq.and_then(|s| s.entries.get(key)) {
                        for facing in 0..8u8 {
                            for anim in 0..def.frames_per_facing.max(1).min(12) {
                                let index =
                                    (def.start_frame + def.facings * i32::from(facing) + anim)
                                        .max(0) as usize;
                                if let Some(raw) = shp_raw(
                                    &shp,
                                    index,
                                    &theater.unit_palette,
                                    offset,
                                    facing * 32,
                                    animation,
                                ) {
                                    frames.push(raw);
                                }
                            }
                        }
                    }
                }
            }
            if frames.is_empty() {
                // Stand is the first un-damaged SHP frame; vehicles with SHP
                // art retain eight facings when their ART declares them.
                let count = if kind == "structure" {
                    1
                } else {
                    8.min(shp.frames.len())
                };
                for i in 0..count {
                    if let Some(raw) =
                        shp_raw(&shp, i, &theater.unit_palette, offset, (i * 32) as u8, 0)
                    {
                        frames.push(raw);
                    }
                }
            }
        }
        if frames.is_empty() {
            bail!("decoded art has no visible frames");
        }
        let image_name = format!("sprites/{}.png", safe(id));
        let mask_name = format!("sprites/{}-remap.png", safe(id));
        let (atlas, mask, metadata_frames) = pack_frames(frames)?;
        atlas.save(self.out.join(&image_name))?;
        mask.save(self.out.join(&mask_name))?;
        let cameo_id = art.resolve_declared_cameo_id(id, &rules_image);
        let cameo = self.export_cameo(assets, id, &cameo_id).ok();
        let foundation = metadata
            .and_then(|e| e.foundation)
            .and_then(|i| rules::foundation::FOUNDATION_TABLE.get(i as usize))
            .map(|d| [d.width, d.height])
            .unwrap_or([1, 1]);
        self.sprites.insert(
            id.to_owned(),
            Sprite {
                image: format!("/generated/{image_name}"),
                remap_image: format!("/generated/{mask_name}"),
                cameo,
                source,
                kind: kind.into(),
                width: atlas.width(),
                height: atlas.height(),
                frames: metadata_frames,
                foundation,
            },
        );
        Ok(())
    }
    fn export_cameo(&self, assets: &AssetManager, id: &str, cameo: &str) -> Result<String> {
        let bytes = assets
            .get(&format!("{cameo}.SHP"))
            .context("cameo unavailable")?;
        let shp = ShpFile::from_bytes(&bytes).map_err(|e| anyhow::anyhow!("{e}"))?;
        let palette = Palette::from_bytes(&assets.get("CAMEO.PAL").context("cameo palette")?)
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        let frame = shp.frames.first().context("empty cameo")?;
        let (image, _) = indices_rgba(
            &frame.pixels,
            u32::from(frame.frame_width),
            u32::from(frame.frame_height),
            &palette,
        );
        let name = format!("sprites/{}-cameo.png", safe(id));
        image.save(self.out.join(&name))?;
        Ok(format!("/generated/{name}"))
    }
}
fn localized_type_names(
    rules: &IniFile,
    csf: Option<&assets::csf_file::CsfFile>,
) -> BTreeMap<String, String> {
    let mut names = BTreeMap::new();
    let Some(csf) = csf else {
        return names;
    };
    for registry in [
        "BuildingTypes",
        "VehicleTypes",
        "InfantryTypes",
        "AircraftTypes",
    ] {
        if let Some(section) = rules.section(registry) {
            for (_, id) in section.raw_entries() {
                if let Some(label) = rules
                    .section(id)
                    .and_then(|entry| entry.read_name("UIName", 0x20))
                    .and_then(|key| csf.get(key))
                {
                    names.insert(id.to_ascii_uppercase(), label.to_owned());
                }
            }
        }
    }
    names
}
fn load_ini(assets: &AssetManager, name: &str) -> Result<IniFile> {
    let bytes = assets
        .get(name)
        .with_context(|| format!("missing {name}"))?;
    IniFile::from_bytes(&bytes).map_err(|error| anyhow::anyhow!("{error}"))
}
fn load_shp(
    assets: &AssetManager,
    art: &ArtRegistry,
    image: &str,
    theater: &TheaterData,
    theater_name: &str,
) -> Option<(String, ShpFile)> {
    rules::art_data::object_shp_candidates(Some(art), image, theater.extension, theater_name)
        .into_iter()
        .find_map(|name| {
            assets
                .get_ref(&name)
                .and_then(|bytes| ShpFile::from_bytes(bytes).ok())
                .map(|shp| (name, shp))
        })
}
fn shp_raw(
    shp: &ShpFile,
    index: usize,
    palette: &Palette,
    offset: (i32, i32),
    facing: u8,
    animation: u8,
) -> Option<RawFrame> {
    let frame = shp.frames.get(index)?;
    let w = u32::from(frame.frame_width);
    let h = u32::from(frame.frame_height);
    if w == 0 || h == 0 {
        return None;
    }
    let (image, mask) = indices_rgba(&frame.pixels, w, h, palette);
    Some(RawFrame {
        image,
        mask,
        offset_x: f32::from(frame.frame_x) - f32::from(shp.width / 2) + offset.0 as f32,
        offset_y: f32::from(frame.frame_y) - f32::from(shp.height / 2) + offset.1 as f32,
        facing,
        animation,
    })
}
fn indices_rgba(indices: &[u8], w: u32, h: u32, palette: &Palette) -> (RgbaImage, RgbaImage) {
    let mut image = RgbaImage::new(w, h);
    let mut mask = RgbaImage::new(w, h);
    for (i, &value) in indices.iter().take((w * h) as usize).enumerate() {
        if value == 0 {
            continue;
        }
        let c = palette.color(value);
        let x = i as u32 % w;
        let y = i as u32 / w;
        image.put_pixel(x, y, Rgba([c.r, c.g, c.b, 255]));
        if (16..32).contains(&value) {
            let shade = 255 - (value - 16) * 11;
            mask.put_pixel(x, y, Rgba([shade, shade, shade, 255]));
        }
    }
    (image, mask)
}
fn pack_frames(frames: Vec<RawFrame>) -> Result<(RgbaImage, RgbaImage, Vec<Frame>)> {
    let total = frames
        .iter()
        .map(|f| u64::from(f.image.width() + 2) * u64::from(f.image.height() + 2))
        .sum::<u64>();
    let widest = frames
        .iter()
        .map(|frame| frame.image.width() + 2)
        .max()
        .unwrap_or(1);
    let edge = ((total as f64).sqrt().ceil() as u32)
        .next_power_of_two()
        .clamp(256, 2048)
        .max(widest.next_power_of_two());
    if edge > 8192 {
        bail!("sprite frame is too wide for a browser atlas");
    }
    let mut positions = Vec::new();
    let (mut x, mut y, mut row_h) = (0, 0, 0);
    for frame in &frames {
        if x + frame.image.width() + 2 > edge {
            x = 0;
            y += row_h;
            row_h = 0;
        }
        positions.push((x, y));
        x += frame.image.width() + 2;
        row_h = row_h.max(frame.image.height() + 2);
    }
    let height = (y + row_h).max(1);
    if height > 16384 {
        bail!("sprite atlas is too tall");
    }
    let mut image = RgbaImage::new(edge, height);
    let mut mask = RgbaImage::new(edge, height);
    let mut metadata = Vec::new();
    for (frame, (x, y)) in frames.into_iter().zip(positions) {
        blit_image(&mut image, &frame.image, x.into(), y.into());
        blit_image(&mut mask, &frame.mask, x.into(), y.into());
        metadata.push(Frame {
            x,
            y,
            width: frame.image.width(),
            height: frame.image.height(),
            offset_x: frame.offset_x,
            offset_y: frame.offset_y,
            facing: frame.facing,
            animation: frame.animation,
        });
    }
    Ok((image, mask, metadata))
}
fn combine_voxels(layers: &[VxlSprite]) -> VxlSprite {
    let min_x = layers.iter().map(|s| s.offset_x as i32).min().unwrap_or(0);
    let min_y = layers.iter().map(|s| s.offset_y as i32).min().unwrap_or(0);
    let max_x = layers
        .iter()
        .map(|s| s.offset_x as i32 + s.width as i32)
        .max()
        .unwrap_or(1);
    let max_y = layers
        .iter()
        .map(|s| s.offset_y as i32 + s.height as i32)
        .max()
        .unwrap_or(1);
    let width = (max_x - min_x).max(1) as u32;
    let height = (max_y - min_y).max(1) as u32;
    let mut pixels = vec![0; (width * height) as usize];
    let mut depth = vec![f32::NEG_INFINITY; pixels.len()];
    for layer in layers {
        for y in 0..layer.height {
            for x in 0..layer.width {
                let source = (y * layer.width + x) as usize;
                let value = layer.palette_indices[source];
                if value == 0 {
                    continue;
                }
                let dx = layer.offset_x as i32 - min_x + x as i32;
                let dy = layer.offset_y as i32 - min_y + y as i32;
                let target = (dy as u32 * width + dx as u32) as usize;
                if layer.depth[source] >= depth[target] {
                    pixels[target] = value;
                    depth[target] = layer.depth[source];
                }
            }
        }
    }
    VxlSprite {
        palette_indices: pixels,
        depth,
        width,
        height,
        offset_x: min_x as f32,
        offset_y: min_y as f32,
    }
}
fn blit_image(dst: &mut RgbaImage, src: &RgbaImage, x: i64, y: i64) {
    image::imageops::overlay(dst, src, x, y)
}
fn blit_raw(dst: &mut RgbaImage, pixels: &[u8], w: u32, h: u32, x: i64, y: i64) {
    if let Some(src) = RgbaImage::from_raw(w, h, pixels.to_vec()) {
        blit_image(dst, &src, x, y)
    }
}
fn safe(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}
