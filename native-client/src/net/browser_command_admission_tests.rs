use super::*;
use crate::sim::command::{CommandRecord, MegaMissionOrder};
use crate::sim::game_entity::GameEntity;
use crate::sim::house_state::HouseState;

fn world() -> (Simulation, InternedId, InternedId) {
    let mut sim = Simulation::with_seed(42);
    let local = sim.intern("Local");
    let peer = sim.intern("Peer");
    for owner in [local, peer] {
        sim.houses
            .register(HouseState::new(owner, 0, None, true, 0, 10));
    }
    for (id, owner) in [(1, local), (2, peer)] {
        let mut entity = GameEntity::test_default(id, "TEST", "Local", 10, 10);
        entity.set_owner_for_test(owner);
        sim.substrate.entities.insert(entity);
    }
    (sim, local, peer)
}

#[test]
fn browser_command_admission_ownership_race_ignores_order_but_identity_forgery_errors() {
    let (mut sim, local, peer) = world();
    let input = CommandEnvelope::new(local, 1, Command::Stop { entity_id: 1 });
    assert_eq!(
        validate_command(&sim, local, &input, 1).unwrap(),
        Admission::Apply
    );
    sim.substrate
        .entities
        .get_mut(1)
        .unwrap()
        .lifecycle
        .set_object_alive_for_test(false);
    assert_eq!(
        validate_command(&sim, local, &input, 1).unwrap(),
        Admission::Apply,
        "the native receiver retains ownership of lifetime admission"
    );
    sim.substrate
        .entities
        .get_mut(1)
        .unwrap()
        .set_owner_for_test(peer);
    let before = sim.state_hash();
    assert_eq!(
        validate_command(&sim, local, &input, 1).unwrap(),
        Admission::Ignore
    );
    assert_eq!(
        sim.state_hash(),
        before,
        "admission cannot mutate the shared world"
    );
    assert!(
        validate_command(&sim, peer, &input, 1).is_err(),
        "authenticated source still controls the envelope header"
    );
    assert!(
        validate_command(&sim, local, &input, 2).is_err(),
        "stale actors cannot bypass strict execution stamps"
    );
    let missing = CommandEnvelope::new(local, 1, Command::Stop { entity_id: 999 });
    assert_eq!(
        validate_command(&sim, local, &missing, 1).unwrap(),
        Admission::Ignore
    );
}

fn planning_append(actor: i32) -> CommandRecord {
    let mut record = CommandRecord::encode(4, 0, 0, &[]).unwrap();
    MegaMissionRecord {
        house_id: 0,
        frame: 0,
        source_id: actor,
        order: MegaMissionOrder::Move {
            target_x: 5,
            target_y: 6,
        },
    }
    .write_into(&mut record)
    .unwrap();
    record.payload_mut()[22] = 1;
    record
}

fn planning_connect(actor: i32) -> CommandRecord {
    let mut record = CommandRecord::encode(0x2a, 0, 0, &[]).unwrap();
    let (value, kind) = MegaMissionTarget::Object { id: actor }.token().unwrap();
    record.payload_mut()[..4].copy_from_slice(&value.to_le_bytes());
    record.payload_mut()[4] = kind;
    record
}

#[test]
fn browser_command_admission_planning_header_cannot_authorize_foreign_embedded_actor() {
    let (mut sim, local, peer) = world();
    for encode in [
        planning_append as fn(i32) -> CommandRecord,
        planning_connect,
    ] {
        let owned = CommandEnvelope::new(local, 1, Command::PlanningRecord { record: encode(1) });
        assert_eq!(
            validate_command(&sim, local, &owned, 1).unwrap(),
            Admission::Apply
        );
        for actor in [2, 999, -1] {
            let foreign = CommandEnvelope::new(
                local,
                1,
                Command::PlanningRecord {
                    record: encode(actor),
                },
            );
            assert_eq!(
                validate_command(&sim, local, &foreign, 1).unwrap(),
                Admission::Ignore
            );
        }
        let mut forged = encode(1);
        forged.set_house_id(1);
        assert!(
            validate_command(
                &sim,
                local,
                &CommandEnvelope::new(local, 1, Command::PlanningRecord { record: forged }),
                1
            )
            .is_err()
        );
    }
    let pending = CommandEnvelope::new(
        local,
        1,
        Command::PlanningRecord {
            record: planning_append(1),
        },
    );
    sim.substrate
        .entities
        .get_mut(1)
        .unwrap()
        .set_owner_for_test(peer);
    assert_eq!(
        validate_command(&sim, local, &pending, 1).unwrap(),
        Admission::Ignore
    );
}

#[test]
fn browser_command_admission_local_selection_and_peer_removal_are_protocol_errors() {
    let (sim, local, _) = world();
    let selection = CommandEnvelope::new(
        local,
        1,
        Command::Select {
            entity_ids: vec![1],
            additive: false,
        },
    );
    assert!(validate_command(&sim, local, &selection, 1).is_err());
    let removal = CommandEnvelope::new(local, 1, Command::RemovePlayer { house_index: 1 });
    assert!(validate_command(&sim, local, &removal, 1).is_err());
}
