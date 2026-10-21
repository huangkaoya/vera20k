//! FLH (Forward/Lateral/Height) firing offset triplet.
//!
//! FLH defines where a projectile visually originates on a unit, relative to
//! the unit's turret pivot (or body center for turretless units).
//!
//! - **Forward**: along the unit's facing direction (positive = forward)
//! - **Lateral**: perpendicular to facing (positive = right of facing direction)
//! - **Height**: vertical offset (positive = up)
//!
//! Values are in leptons (256 leptons = 1 cell). Read from art.ini keys
//! (`PrimaryFireFLH=`, `SecondaryFireFLH=`, `ElitePrimaryFireFLH=`,
//! `EliteSecondaryFireFLH=`, `Weapon%dFLH=`, `AlternateFLH0..4=`) by the native coordinate
//! read, `IniSection::read_coord3`.
//!
//! ## Dependency rules
//! - Part of rules/ — no dependencies on sim/, render/, ui/, etc.

/// FLH (Forward, Lateral, Height) lepton offset triplet.
///
/// Defines where a projectile visually originates relative to the unit's
/// turret pivot (or body center for turretless units).
///
/// Values are in leptons (256 leptons = 1 cell).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Flh {
    /// Distance along the unit's facing direction. Positive = forward.
    pub forward: i32,
    /// Distance perpendicular to facing. Positive = right of facing direction.
    pub lateral: i32,
    /// Vertical offset. Positive = up.
    pub height: i32,
}

/// The art read's `[forward, lateral, height]` fields
/// ([`IniSection::read_coord3`](crate::rules::ini_parser::IniSection::read_coord3),
/// `0x00529CA0`).
impl From<[i32; 3]> for Flh {
    fn from([forward, lateral, height]: [i32; 3]) -> Self {
        Self {
            forward,
            lateral,
            height,
        }
    }
}

impl From<Flh> for [i32; 3] {
    fn from(flh: Flh) -> Self {
        [flh.forward, flh.lateral, flh.height]
    }
}

/// Resolve the effective FLH for a weapon slot, considering veterancy.
///
/// Elite units (veterancy >= 200) use the elite FLH override if the art.ini
/// section defines one. Otherwise falls back to the normal FLH.
///
/// `is_primary`: true for primary weapon, false for secondary.
/// `veterancy`: entity veterancy level (0=rookie, 100=veteran, 200=elite).
pub fn resolve_flh(
    primary_flh: Flh,
    secondary_flh: Flh,
    elite_primary_flh: Option<Flh>,
    elite_secondary_flh: Option<Flh>,
    is_primary: bool,
    veterancy: u16,
) -> Flh {
    /// Veterancy level at which elite FLH overrides apply.
    const ELITE_VETERANCY_THRESHOLD: u16 = 200;

    let is_elite: bool = veterancy >= ELITE_VETERANCY_THRESHOLD;

    if is_primary {
        if is_elite {
            elite_primary_flh.unwrap_or(primary_flh)
        } else {
            primary_flh
        }
    } else if is_elite {
        elite_secondary_flh.unwrap_or(secondary_flh)
    } else {
        secondary_flh
    }
}
