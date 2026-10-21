//! Rust boundary regressions, not a native gamemd networking parity claim.
use super::*;

fn world() -> (Simulation, InternedId, InternedId) {
    let mut sim = Simulation::with_seed(42);
    let local = sim.intern("Local");
    let peer = sim.intern("Peer");
    for owner in [local, peer] {
        sim.houses
            .register(crate::sim::house_state::HouseState::new(
                owner, 0, None, true, 0, 10,
            ));
    }
    (sim, local, peer)
}

#[test]
fn input_capture_retains_world_queue_and_transfers_only_new_native_records() {
    let (mut sim, local, _) = world();
    let future = CommandEnvelope::new(local, 9, Command::Cheer);
    sim.queue_command(future.clone());
    let input = CommandEnvelope::new(local, 0, Command::Stop { entity_id: 7 });
    let (result, captured) = sim.capture_queued_commands(|sim| {
        sim.queue_command(input.clone());
        123
    });
    assert_eq!(result, 123);
    assert_eq!(captured, [input]);
    assert_eq!(sim.pending_command_snapshot(), [future]);
}

#[test]
fn ordered_wire_next_tick_executes_in_the_immediately_following_world_frame() {
    let (mut sim, local, _) = world();
    let expected_tick = sim.session().tick() + 1;
    sim.queue_command(CommandEnvelope::new(
        local,
        expected_tick,
        Command::SetGameSpeed { speed: 4 },
    ));
    let due = sim.take_due_commands();
    assert_eq!(due.len(), 1, "wire N+1 is due before that frame advances");
    let result = sim.advance_tick(&due, Some(RuleSet::empty_for_test()), None, None, 66);
    assert!(result.frame_committed);
    assert_eq!(sim.session().tick(), expected_tick);
    assert_eq!(sim.session().game_options().game_speed, 4);
    assert!(
        sim.take_due_commands().is_empty(),
        "the same input cannot execute twice"
    );
}

#[test]
fn two_peer_current_houses_and_local_selection_share_the_same_world_hash() {
    fn selected_world(viewer: usize) -> Simulation {
        let (mut sim, local, peer) = world();
        let kind = sim.intern("TEST");
        for (id, owner) in [(1, local), (2, peer)] {
            let mut entity =
                crate::sim::game_entity::GameEntity::test_default(id, "TEST", "Local", 10, 10);
            entity.set_owner_for_test(owner);
            entity.set_type_ref_for_test(kind);
            entity.set_category_for_test(EntityCategory::Unit);
            entity.lifecycle.set_object_alive_for_test(true);
            entity.lifecycle.set_in_limbo_for_test(false);
            sim.substrate.entities.insert(entity);
        }
        let owner = [local, peer][viewer];
        sim.session.install_current_house(Some(owner));
        sim.apply_command(
            if viewer == 0 { "Local" } else { "Peer" },
            &Command::Select {
                entity_ids: vec![viewer as u64 + 1],
                additive: false,
            },
            Some(RuleSet::empty_for_test()),
        );
        assert!(
            sim.entities()
                .get(viewer as u64 + 1)
                .unwrap()
                .selection
                .is_selected()
        );
        assert!(
            !sim.entities()
                .get(2 - viewer as u64)
                .unwrap()
                .selection
                .is_selected()
        );
        sim
    }
    let first = selected_world(0);
    let second = selected_world(1);
    assert_ne!(
        first.session().current_house(),
        second.session().current_house()
    );
    assert_eq!(first.state_hash(), second.state_hash());
}
