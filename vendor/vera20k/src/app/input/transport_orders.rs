//! Deploy-key / self-click resolution for unloadable passenger containers.
//!
//! Mobile transports use `Type+0x5E0 Passengers > 0` and the aircraft unload
//! slot `0x004151E0`; garrisons use `CanBeOccupied`; InfantryAbsorb buildings
//! use their native absorber flag. Every input site routes through this one
//! resolver so the gates agree.

use crate::map::entities::EntityCategory;
use crate::rules::object_type::ObjectType;
use crate::sim::command::Command;
use crate::sim::game_entity::GameEntity;
use crate::sim::intern::InternedId;

/// One resolver for self-click, deploy-key and cursor unload admission.
/// Structures unload only when they are InfantryAbsorb buildings or
/// occupiable garrisons; mobile transports retain their passenger-count gate.
/// Production callers provide the local owner so an enemy building cannot
/// advertise an unload.
pub(crate) fn unload_command(
    entity: &GameEntity,
    obj: Option<&ObjectType>,
    local_owner: Option<InternedId>,
) -> Option<Command> {
    if local_owner.is_some_and(|owner| owner != entity.owner()) {
        return None;
    }
    let obj = obj?;
    let has_passengers = entity
        .passenger_role
        .cargo()
        .is_some_and(|cargo| !cargo.is_empty());
    let can_unload = match entity.category() {
        EntityCategory::Structure => (obj.can_be_occupied || obj.infantry_absorb) && has_passengers,
        EntityCategory::Unit | EntityCategory::Aircraft => obj.passengers > 0 && has_passengers,
        EntityCategory::Infantry => false,
    };
    if !can_unload {
        return None;
    }
    Some(Command::UnloadPassengers {
        transport_id: entity.stable_id(),
    })
}
