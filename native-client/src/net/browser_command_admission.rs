//! Authentication of browser-native commands before their native receivers.
//! This transport boundary checks identity, not gameplay eligibility.
use anyhow::{Result, bail, ensure};

use crate::sim::command::{Command, CommandEnvelope, MegaMissionRecord, MegaMissionTarget};
use crate::sim::intern::InternedId;
use crate::sim::world::Simulation;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    Apply,
    Ignore,
}

pub fn validate_command(
    sim: &Simulation,
    owner: InternedId,
    envelope: &CommandEnvelope,
    tick: u64,
) -> Result<Admission> {
    ensure!(
        envelope.owner == owner,
        "native command owner is not the authenticated participant"
    );
    ensure!(
        envelope.execute_tick == tick,
        "native command execute tick differs from ordered turn"
    );
    let actor = match &envelope.payload {
        Command::Move { entity_id, .. }
        | Command::MoveToObject { entity_id, .. }
        | Command::Stop { entity_id }
        | Command::AttackMove { entity_id, .. }
        | Command::Guard { entity_id, .. }
        | Command::DeployMcv { entity_id }
        | Command::UndeployBuilding { entity_id }
        | Command::SellBuilding { entity_id }
        | Command::ToggleRepair { entity_id }
        | Command::ToggleInfantryDeploy { entity_id }
        | Command::Scatter { entity_id }
        | Command::TogglePrimaryFactory { entity_id }
        | Command::MegaMission { entity_id, .. }
        | Command::SetBuildingOnLine { entity_id, .. }
        | Command::ArchiveObject { entity_id, .. } => Some(*entity_id),
        Command::Attack { attacker_id, .. }
        | Command::PlantC4 { attacker_id, .. }
        | Command::ForceAttackCell { attacker_id, .. } => Some(*attacker_id),
        Command::CaptureBuilding { engineer_id, .. } => Some(*engineer_id),
        Command::EjectBunker { bunker_id } => Some(*bunker_id),
        Command::UnloadPassengers { transport_id } => Some(*transport_id),
        Command::Select { .. } => bail!("local selection snapshots must not cross the network"),
        Command::RemovePlayer { .. } => bail!("participant removal is a transport decision"),
        _ => None,
    };
    // Ownership may legitimately change after input was authored. Drop that
    // obsolete order deterministically; forged participant/header/tick above
    // remains a protocol error. Other native lifetime gates stay in sim.
    if let Some(id) = actor
        && sim
            .entities()
            .get(id)
            .is_none_or(|actor| actor.owner() != owner)
    {
        return Ok(Admission::Ignore);
    }
    match &envelope.payload {
        // SetRally's native receiver independently authorizes each producer,
        // so a captured producer does not invalidate the remaining selection.
        Command::QueueProduction { type_id }
        | Command::PlaceReadyBuilding { type_id, .. }
        | Command::CancelProductionByType { type_id, .. } => {
            ensure!(
                sim.interner().try_resolve(*type_id).is_some(),
                "unknown native production type ID"
            );
        }
        Command::LaunchSuperWeapon { sw_type_id, .. } => {
            ensure!(
                sim.interner().try_resolve(*sw_type_id).is_some(),
                "unknown native superweapon ID"
            );
        }
        Command::PlanningRecord { record } => {
            let index = usize::try_from(record.house_id())
                .map_err(|_| anyhow::anyhow!("negative planning house"))?;
            ensure!(
                sim.houses().order().get(index) == Some(&owner),
                "planning record header has a foreign House"
            );
            let actor = match record.opcode() {
                // Reuse the ordinary MegaMission codec just as PlanMgr's
                // append receiver does, after removing its planning flag.
                4 if record.payload()[22] == 1 => {
                    let mut ordinary = record.clone();
                    ordinary.payload_mut()[22] = 0;
                    MegaMissionRecord::decode(&ordinary)
                        .and_then(|order| u64::try_from(order.source_id).ok())
                }
                0x2a => {
                    let payload = record.payload();
                    match MegaMissionTarget::from_token(
                        i32::from_le_bytes(payload[0..4].try_into().unwrap()),
                        payload[4],
                    ) {
                        Some(MegaMissionTarget::Object { id }) => u64::try_from(id).ok(),
                        _ => None,
                    }
                }
                _ => return Ok(Admission::Apply),
            };
            // The native planning editor intentionally defers ordinary actor
            // admission. A transport must authorize the embedded actor before
            // permitting an edit to the shared planning graph.
            if actor
                .and_then(|id| sim.entities().get(id))
                .is_none_or(|actor| actor.owner() != owner)
            {
                return Ok(Admission::Ignore);
            }
        }
        Command::BeginPaidSuperWeapon { selection, .. }
        | Command::CompletePaidSuperWeapon { selection, .. }
        | Command::CancelPaidSuperWeapon { selection } => {
            ensure!(
                sim.interner().try_resolve(selection.source).is_some()
                    && sim.interner().try_resolve(selection.destination).is_some(),
                "unknown paid superweapon source"
            );
        }
        _ => {}
    }
    Ok(Admission::Apply)
}

#[cfg(test)]
#[path = "browser_command_admission_tests.rs"]
mod tests;
