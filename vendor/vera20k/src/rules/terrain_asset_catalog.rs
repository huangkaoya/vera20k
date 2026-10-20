//! GPU-independent terrain SHP metadata used by authoritative match systems.
//!
//! Terrain rendering addresses only the body half of a terrain SHP. Gameplay,
//! however, follows `TerrainClass::AI @ 0x0071C730` and reads the signed SHP
//! header frame count before comparing the current frame with `count / 2`.
//! Keeping the raw count here prevents presentation's body-frame projection
//! from being halved a second time by the simulation.

use std::collections::{BTreeMap, BTreeSet};

use crate::assets::asset_manager::AssetManager;
use crate::assets::shp_file::ShpFile;
use crate::rules::art_data;
use crate::rules::ini_parser::IniFile;
use crate::rules::ruleset::RuleSet;

/// Deterministic raw SHP frame counts for animated terrain ore spawners.
///
/// Keys are trimmed uppercase terrain-type IDs. Missing or malformed optional
/// assets are omitted so the existing zero-frame simulation fallback remains
/// explicit at the consumer. That fallback is VERA-internal; gamemd behavior
/// for missing or malformed modded terrain art remains UNCHECKED.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct TerrainSpawnerAssetCatalog {
    frame_counts: BTreeMap<String, u16>,
}

impl TerrainSpawnerAssetCatalog {
    /// Bind every registered animated `SpawnsTiberium=yes` terrain type.
    pub fn bind(
        rules: &RuleSet,
        rules_ini: &IniFile,
        asset_manager: &AssetManager,
        theater_ext: &str,
        theater_name: &str,
    ) -> Self {
        let roots: BTreeSet<String> = rules
            .terrain_object_types
            .values()
            .filter(|terrain| terrain.spawns_tiberium && terrain.is_animated)
            .filter_map(|terrain| canonical_type_id(&terrain.name))
            .collect();
        let mut catalog = Self::default();

        for name in roots {
            let image_id = rules.art().resolve_overlay_image_id(&name, rules_ini);
            let candidates = art_data::overlay_shp_candidates(
                Some(rules.art()),
                &name,
                &image_id,
                theater_ext,
                theater_name,
            );
            let mut found_asset = false;
            let mut invalid_candidates = Vec::new();
            let mut frame_count = None;
            for candidate in &candidates {
                let Some(data) = asset_manager.get_ref(candidate) else {
                    continue;
                };
                found_asset = true;
                match ShpFile::frame_count_from_bytes(data) {
                    Ok(count) => {
                        frame_count = Some(count);
                        break;
                    }
                    Err(error) => invalid_candidates.push(format!("{candidate}: {error}")),
                }
            }

            if let Some(frame_count) = frame_count {
                catalog.frame_counts.insert(name, frame_count);
            } else if found_asset {
                log::warn!(
                    "Authoritative terrain-spawner asset [{name}] has no valid SHP candidate ({invalid_candidates:?}); no validated spawning midpoint is available"
                );
            } else {
                log::warn!(
                    "Authoritative terrain-spawner asset [{name}] is missing; no validated spawning midpoint is available"
                );
            }
        }

        catalog
    }

    /// Literal unsigned SHP header count used by the persisted terrain-spawner
    /// state. Stock TIBTRE assets return 22 and therefore target midpoint 11.
    pub fn frame_count(&self, name: &str) -> Option<u16> {
        canonical_type_id(name).and_then(|name| self.frame_counts.get(&name).copied())
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn set_for_test(&mut self, name: &str, frame_count: u16) {
        if let Some(name) = canonical_type_id(name) {
            self.frame_counts.insert(name, frame_count);
        }
    }
}

fn canonical_type_id(name: &str) -> Option<String> {
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_ascii_uppercase())
}
