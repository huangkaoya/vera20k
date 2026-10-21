//! Browser transport for the native command stream. This module owns only
//! admission, ordered turns and readiness; SimRuntime remains the sole world.
//! Select is a process-local input snapshot and never crosses the network.

use std::cell::RefCell;
use std::collections::VecDeque;

use anyhow::{Result, bail, ensure};
use serde::Deserialize;
use serde_json::{Value, json};

use super::AppState;
use crate::net::browser_command_admission::{Admission, validate_command};
use crate::sim::command::{Command, CommandEnvelope};
use crate::sim::intern::InternedId;

const MAX_COMMANDS: usize = 1024;
const SOURCE_REVISION: &str = match option_env!("VERA_WEB_SOURCE_REVISION") {
    Some(value) => value,
    None => "unrecorded",
};
const PATCH_HASH: &str = match option_env!("VERA_WEB_BROWSER_PATCH_HASH") {
    Some(value) => value,
    None => "unrecorded",
};
const RESOURCE_MANIFEST: &str = match option_env!("VERA_WEB_ASSET_MANIFEST_SHA256") {
    Some(value) => value,
    None => "",
};

thread_local! {
    static INCOMING: RefCell<VecDeque<Incoming>> = const { RefCell::new(VecDeque::new()) };
    static OUTGOING: RefCell<VecDeque<Value>> = const { RefCell::new(VecDeque::new()) };
    static STATUS: RefCell<Value> = RefCell::new(json!({"phase":"idle"}));
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Loading,
    Loaded,
    Running,
    Finishing,
    Finished,
    Stopped,
}

impl Phase {
    fn text(self) -> &'static str {
        match self {
            Self::Loading => "loading",
            Self::Loaded => "loaded",
            Self::Running => "running",
            Self::Finishing => "finishing",
            Self::Finished => "finished",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WireCommand {
    player: usize,
    envelope: CommandEnvelope,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Incoming {
    Progress {
        source: usize,
        percent: i32,
    },
    Ready {
        tick: u64,
        bootstrap: String,
    },
    Turn {
        tick: u64,
        commands: Vec<WireCommand>,
    },
    Chat {
        source: usize,
        text: String,
    },
    Taunt {
        source: usize,
        byte: u8,
    },
    Finished {
        tick: u64,
        checksum: String,
    },
    Stopped {
        reason: String,
    },
}

pub(crate) struct Session {
    match_id: String,
    local_player: usize,
    phase: Phase,
    owners: Vec<InternedId>,
    next_tick: u64,
    pending: Vec<CommandEnvelope>,
    submitted: bool,
    accepted: Option<Vec<CommandEnvelope>>,
    committing: bool,
    committing_frame: Option<u32>,
    finished_tick: Option<u64>,
    in_flight_turn: Option<u64>,
    error: Option<String>,
    last_hash: String,
    full_state_hash: String,
    full_state_tick: Option<u64>,
}

fn emit(value: Value) {
    OUTGOING.with(|outgoing| outgoing.borrow_mut().push_back(value));
}

fn publish(session: &Session) {
    STATUS.with(|status| *status.borrow_mut() = json!({
        "phase":session.phase.text(), "matchId":session.match_id,
        "localPlayer":session.local_player, "nextTick":session.next_tick,
        "submitted":session.submitted, "turnReady":session.accepted.is_some(), "finishedTick":session.finished_tick,
        "hash":session.last_hash, "hashAlgorithm":if session.last_hash.starts_with("retail:") { "retail-multiplayer-v1" } else if session.last_hash.starts_with("launch:") { "launch-receipt-v1" } else { "diagnostic-full-state-v1" },
        "diagnosticFullStateHash":session.full_state_hash,"diagnosticFullStateTick":session.full_state_tick, "owners":session.owners.iter().map(|id| id.index()).collect::<Vec<_>>(),
        "error":session.error,
        "sourceRevision":SOURCE_REVISION,"patchHash":PATCH_HASH,"resourceManifest":RESOURCE_MANIFEST,
    }));
}

/// Called only by the native accepted-network-start owner, after freezing the
/// shared roster/seed/map. JavaScript cannot create an arbitrary live world.
pub(crate) fn begin(state: &mut AppState, match_id: String, local_player: usize) -> Result<()> {
    ensure!(
        !match_id.is_empty() && match_id.len() <= 128,
        "invalid network match identity"
    );
    ensure!(
        state
            .match_state
            .browser_network
            .as_ref()
            .is_none_or(|s| s.phase == Phase::Stopped),
        "a browser network match is already active"
    );
    let launch = state
        .match_state
        .session
        .network_setup()
        .ok_or_else(|| anyhow::anyhow!("native network setup is missing"))?;
    ensure!(
        launch.humans.len() >= 2 && launch.humans.len() <= 8,
        "network match requires 2 to 8 humans"
    );
    ensure!(
        local_player == launch.local_player_index && local_player < launch.humans.len(),
        "local player differs from native accepted setup"
    );
    INCOMING.with(|incoming| incoming.borrow_mut().clear());
    OUTGOING.with(|outgoing| outgoing.borrow_mut().clear());
    let session = Session {
        match_id,
        local_player,
        phase: Phase::Loading,
        owners: Vec::new(),
        next_tick: 0,
        pending: Vec::new(),
        submitted: false,
        accepted: None,
        committing: false,
        committing_frame: None,
        finished_tick: None,
        in_flight_turn: None,
        error: None,
        last_hash: String::new(),
        full_state_hash: String::new(),
        full_state_tick: None,
    };
    publish(&session);
    state.match_state.browser_network = Some(session);
    state.platform.browser_online = true;
    Ok(())
}

fn fail(session: &mut Session, reason: String, notify: bool) {
    if session.phase == Phase::Stopped {
        return;
    }
    session.phase = Phase::Stopped;
    session.pending.clear();
    session.accepted = None;
    session.committing = false;
    session.committing_frame = None;
    session.error = Some(reason.clone());
    OUTGOING.with(|outgoing| outgoing.borrow_mut().clear());
    if notify {
        emit(json!({"type":"leave", "matchId":session.match_id,"reason":reason}));
    }
    log::error!("Native network match stopped: {reason}");
}

pub(crate) fn stop(state: &mut AppState, reason: &str) {
    if let Some(session) = state.match_state.browser_network.as_mut() {
        if matches!(session.phase, Phase::Finishing | Phase::Finished) {
            // Continue uses the existing leave route after the native result
            // page. A completed result is not a network error.
            session.phase = Phase::Stopped;
            session.error = None;
            session.pending.clear();
            session.accepted = None;
            emit(json!({"type":"leave", "matchId":session.match_id,"reason":reason}));
        } else {
            fail(session, reason.to_owned(), true);
        }
        publish(session);
    }
    INCOMING.with(|incoming| incoming.borrow_mut().clear());
    state.platform.browser_online = false;
}

pub fn status() -> Value {
    STATUS.with(|status| status.borrow().clone())
}
pub fn drain_outbox() -> Value {
    OUTGOING.with(|outgoing| Value::Array(outgoing.borrow_mut().drain(..).collect()))
}

/// Only a message for the active admitted match can enter the mailbox. Native
/// state validation occurs in poll on the app's ordinary execution thread.
pub fn receive(match_id: &str, message: &str) -> Result<()> {
    ensure!(
        message.len() <= 1024 * 1024,
        "network message exceeds one MiB"
    );
    let allowed = STATUS.with(|status| {
        let status = status.borrow();
        status["matchId"].as_str() == Some(match_id) && status["phase"].as_str() != Some("stopped")
    });
    ensure!(allowed, "message does not belong to an active native match");
    let message: Incoming = serde_json::from_str(message)?;
    if let Incoming::Turn { commands, .. } = &message {
        ensure!(
            commands.len() <= MAX_COMMANDS,
            "too many native commands in one turn"
        );
    }
    INCOMING.with(|incoming| {
        let mut incoming = incoming.borrow_mut();
        ensure!(incoming.len() < 256, "network inbox overflow");
        incoming.push_back(message);
        Ok(())
    })?;
    crate::app::browser::wake();
    Ok(())
}

/// Shared gameplay input leaves through this owner. The command has already
/// passed native click resolution/record round-trips, never TS action mapping.
pub(crate) fn enqueue(state: &mut AppState, mut commands: Vec<CommandEnvelope>) -> bool {
    let Some(session) = state.match_state.browser_network.as_mut() else {
        return false;
    };
    if matches!(
        session.phase,
        Phase::Finishing | Phase::Finished | Phase::Stopped
    ) {
        return false;
    }
    let Some(runtime) = state.match_state.sim_runtime.as_ref() else {
        return false;
    };
    let Some(owner) = runtime.simulation.session().current_house() else {
        return false;
    };
    if commands
        .iter()
        .any(|command| command.owner != owner || matches!(command.payload, Command::Select { .. }))
    {
        fail(
            session,
            "local native command has an invalid owner or selection payload".into(),
            true,
        );
        publish(session);
        return false;
    }
    if session.pending.len() + commands.len() > 256 {
        fail(
            session,
            "native input queue exceeds 256 commands per turn".into(),
            true,
        );
        publish(session);
        return false;
    }
    // Wire execution stamps are assigned when the complete next input is sent.
    session.pending.append(&mut commands);
    true
}

/// Reuse the native local House's accepted SavourDelay/voice-wait edge.
/// This observes presentation termination; it never manufactures an outcome.
fn native_outcome_ready(state: &AppState) -> bool {
    state.match_state.scenario_outcome.is_some()
        || state
            .match_state
            .sim_runtime
            .as_ref()
            .is_some_and(|runtime| {
                state
                    .match_state
                    .local_player_owner()
                    .and_then(|name| runtime.simulation.interner().get(name))
                    .and_then(|owner| runtime.simulation.ready_outcome_for_owner(owner))
                    .is_some()
            })
}

fn begin_finishing_if_ready(state: &AppState, session: &mut Session) -> Result<()> {
    if session.phase != Phase::Running || session.committing || !native_outcome_ready(state) {
        return Ok(());
    }
    let tick = state
        .match_state
        .sim_runtime
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("finished native world is missing"))?
        .simulation
        .session()
        .tick();
    ensure!(
        tick.checked_add(1) == Some(session.next_tick),
        "finished native tick is not the last committed turn"
    );
    ensure!(
        session.last_hash.starts_with("retail:"),
        "finished native world has no committed Queue_AI checksum"
    );
    session.finished_tick = Some(tick);
    // A turn already broadcast before the server learns this terminal edge
    // may still arrive. Authenticate and discard at most that one turn.
    session.in_flight_turn =
        (session.submitted && session.accepted.is_none()).then_some(session.next_tick);
    session.phase = Phase::Finishing;
    session.pending.clear();
    session.accepted = None;
    session.submitted = false;
    emit(json!({"type":"finished", "matchId":session.match_id,
        "tick":tick, "checksum":session.last_hash}));
    Ok(())
}

fn poll_session(state: &mut AppState, session: &mut Session) -> Result<()> {
    begin_finishing_if_ready(state, session)?;
    use crate::app::match_runtime::session::NetworkLoadingRequest;
    for request in state.match_state.session.take_network_loading_requests() {
        match request {
            NetworkLoadingRequest::ReportProgress(percent) => {
                ensure!(
                    (0..=100).contains(&percent),
                    "network standard-map progress outside 0..100"
                );
                emit(json!({"type":"progress","matchId":session.match_id,"percent":percent}));
            }
            NetworkLoadingRequest::Disconnect { .. }
            | NetworkLoadingRequest::ProposeKick { .. } => {
                bail!("native peer disconnected while loading or waiting");
            }
            NetworkLoadingRequest::Chat { recipients, text } => {
                if matches!(session.phase, Phase::Finishing | Phase::Finished) {
                    continue;
                }
                ensure!(
                    session.phase == Phase::Running,
                    "chat requires a running native match"
                );
                emit(
                    json!({"type":"chat","matchId":session.match_id,"recipients":recipients,"text":text}),
                );
            }
            NetworkLoadingRequest::Taunt { recipients, byte } => {
                if matches!(session.phase, Phase::Finishing | Phase::Finished) {
                    continue;
                }
                ensure!(
                    session.phase == Phase::Running,
                    "taunt requires a running native match"
                );
                emit(
                    json!({"type":"taunt","matchId":session.match_id,"recipients":recipients,"byte":byte}),
                );
            }
        }
    }
    let incoming = INCOMING.with(|incoming| incoming.borrow_mut().drain(..).collect::<Vec<_>>());
    for message in incoming {
        match message {
            Incoming::Progress { source, percent } => {
                ensure!(
                    (0..=100).contains(&percent),
                    "invalid peer loading progress"
                );
                crate::app::loading::pump::accept_network_loading_progress(state, source, percent);
            }
            Incoming::Ready { tick, bootstrap } => {
                ensure!(
                    session.phase == Phase::Loaded && tick == session.next_tick,
                    "unexpected native ready tick"
                );
                ensure!(
                    bootstrap == session.match_id,
                    "native launch receipt belongs to another match"
                );
                // This is the server's frozen launch receipt, not an initial
                // shared-world digest. The first real Queue_AI checksum is
                // compared immediately after the first committed world frame.
                session.last_hash = format!("launch:{}", session.match_id);
                session.phase = Phase::Running;
            }
            Incoming::Turn { tick, commands } => {
                let retiring_in_flight =
                    session.phase == Phase::Finishing && session.in_flight_turn == Some(tick);
                ensure!(
                    ((session.phase == Phase::Running && session.submitted) || retiring_in_flight)
                        && session.accepted.is_none()
                        && !session.committing
                        && tick == session.next_tick,
                    "duplicate, stale or future native turn"
                );
                let sim = &state
                    .match_state
                    .sim_runtime
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("native world is missing"))?
                    .simulation;
                ensure!(
                    tick == sim.session().tick() + 1,
                    "native turn is not the world's next tick"
                );
                let mut admitted = Vec::with_capacity(commands.len());
                let mut previous_player = 0;
                for wire in commands {
                    let owner = *session
                        .owners
                        .get(wire.player)
                        .ok_or_else(|| anyhow::anyhow!("invalid native source participant"))?;
                    ensure!(
                        wire.player >= previous_player,
                        "native turn is not in participant order"
                    );
                    previous_player = wire.player;
                    if validate_command(sim, owner, &wire.envelope, tick)? == Admission::Apply {
                        admitted.push(wire.envelope);
                    }
                }
                if retiring_in_flight {
                    session.in_flight_turn = None;
                } else {
                    session.accepted = Some(admitted);
                }
            }
            Incoming::Finished { tick, checksum } => {
                ensure!(
                    session.phase == Phase::Finishing
                        && session.finished_tick == Some(tick)
                        && checksum == session.last_hash,
                    "native finished acknowledgement differs from the committed result"
                );
                session.phase = Phase::Finished;
                session.in_flight_turn = None;
                session.pending.clear();
                session.accepted = None;
                log::info!("Native network match finished at committed tick {tick}");
            }
            Incoming::Stopped { reason } => {
                fail(session, reason, false);
                return Ok(());
            }
            Incoming::Chat { source, text } => {
                ensure!(
                    matches!(session.phase, Phase::Running | Phase::Finishing)
                        && source < session.owners.len()
                        && text.len() <= 4096,
                    "invalid native chat sender or text"
                );
                crate::app::match_runtime::network_match::service_event(
                    state,
                    crate::app::match_runtime::network_match::NetworkMatchEvent::Chat {
                        source_index: source,
                        text,
                    },
                )?;
            }
            Incoming::Taunt { source, byte } => {
                ensure!(
                    matches!(session.phase, Phase::Running | Phase::Finishing)
                        && source < session.owners.len(),
                    "invalid native taunt sender"
                );
                crate::app::match_runtime::network_match::service_event(
                    state,
                    crate::app::match_runtime::network_match::NetworkMatchEvent::Taunt { byte },
                )?;
            }
        }
    }
    let Some(runtime) = state.match_state.sim_runtime.as_ref() else {
        return Ok(());
    };
    let sim = &runtime.simulation;
    if session.phase == Phase::Loading
        && state.frontend.screen == crate::ui::game_screen::GameScreen::InGame
    {
        let count = state
            .match_state
            .session
            .network_setup()
            .ok_or_else(|| anyhow::anyhow!("native frozen launch disappeared"))?
            .humans
            .len();
        session.owners = (0..count)
            .map(|source| {
                let name = state
                    .match_state
                    .session
                    .network_source_owner(source)
                    .ok_or_else(|| anyhow::anyhow!("native source has no House"))?;
                sim.interner()
                    .get(&name)
                    .ok_or_else(|| anyhow::anyhow!("native source House is not interned"))
            })
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            session.owners.get(session.local_player) == sim.session().current_house().as_ref(),
            "native current House differs from admitted local participant"
        );
        session.next_tick = sim
            .session()
            .tick()
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("native tick overflow"))?;
        session.full_state_hash = format!("{:016x}", sim.state_hash());
        session.full_state_tick = Some(sim.session().tick());
        session.last_hash = format!("full:{}", session.full_state_hash);
        session.phase = Phase::Loaded;
        emit(
            json!({"type":"loaded", "matchId":session.match_id, "tick":sim.session().tick(),
            "hash":session.full_state_hash,"owners":session.owners.iter().map(|id| id.index()).collect::<Vec<_>>(),
            "build":format!("{SOURCE_REVISION}:{PATCH_HASH}"),"resourceManifest":RESOURCE_MANIFEST }),
        );
    }
    if session.phase == Phase::Running
        && !session.submitted
        && session.accepted.is_none()
        && !session.committing
    {
        ensure!(
            sim.session().tick() + 1 == session.next_tick,
            "native world advanced outside ordered turn"
        );
        // The preceding native Queue_AI already produced the sync checksum.
        // Recomputing it would consume two extra Scenario RNG draws. Full state
        // hashes include process-local presentation/defeat state, so they are
        // retained only as diagnostics; the loaded barrier authenticates the
        // frozen launch/build/assets rather than local presentation state.
        let mut commands = std::mem::take(&mut session.pending);
        for command in &mut commands {
            command.execute_tick = session.next_tick;
        }
        emit(
            json!({"type":"input","matchId":session.match_id,"tick":session.next_tick,
            "prevHash":session.last_hash,"commands":commands}),
        );
        session.submitted = true;
    }
    Ok(())
}

/// Called on loading and gameplay passes. No async callback borrows AppState.
pub(crate) fn poll(state: &mut AppState) {
    let Some(mut session) = state.match_state.browser_network.take() else {
        return;
    };
    if !matches!(session.phase, Phase::Stopped | Phase::Finished) {
        if let Err(error) = poll_session(state, &mut session) {
            fail(&mut session, error.to_string(), true);
        }
    }
    publish(&session);
    state.platform.browser_online = !matches!(session.phase, Phase::Stopped | Phase::Finished);
    state.match_state.browser_network = Some(session);
}

pub(crate) fn allows_frame(state: &AppState) -> bool {
    if !state.match_state.session_mode().is_network() {
        return true;
    }
    state
        .match_state
        .browser_network
        .as_ref()
        .is_none_or(|session| {
            session.phase == Phase::Running && session.accepted.is_some() && !session.committing
        })
}

pub(crate) fn active(state: &AppState) -> bool {
    state.match_state.session_mode().is_network()
        && state
            .match_state
            .browser_network
            .as_ref()
            .is_some_and(|session| !matches!(session.phase, Phase::Stopped | Phase::Finished))
}

pub(crate) fn take_turn_commands(state: &mut AppState) -> Option<Vec<CommandEnvelope>> {
    if !state.match_state.session_mode().is_network() {
        return None;
    }
    let frame = state
        .match_state
        .sim_runtime
        .as_ref()?
        .simulation
        .session()
        .binary_frame();
    let session = state.match_state.browser_network.as_mut()?;
    if session.phase != Phase::Running {
        return None;
    }
    let commands = session.accepted.take()?;
    session.committing = true;
    session.committing_frame = Some(frame);
    Some(commands)
}

pub(crate) fn frame_finished(state: &mut AppState, committed: bool, checksum: Option<(u32, u32)>) {
    let Some(mut session) = state.match_state.browser_network.take() else {
        return;
    };
    if session.committing {
        let tick = state
            .match_state
            .sim_runtime
            .as_ref()
            .map(|runtime| runtime.simulation.session().tick());
        // Native Main_Tick computes Queue_AI's checksum, then returns on a
        // ready local outcome before committing its frame counter. This is a
        // successful terminal call, not a lost ordered turn. Keep the ordinal
        // unchanged and consume that call's already-produced checksum so both
        // peers acknowledge the same final native frame.
        if !committed
            && tick.and_then(|tick| tick.checked_add(1)) == Some(session.next_tick)
            && native_outcome_ready(state)
            && let Some((frame, value)) = checksum
            && session.committing_frame == Some(frame)
        {
            session.last_hash = format!("retail:{frame}:{value:08x}");
            session.submitted = false;
            session.committing = false;
            session.committing_frame = None;
        } else if !committed || tick != Some(session.next_tick) {
            fail(
                &mut session,
                "native ordered turn failed to commit exactly once".into(),
                true,
            );
        } else if let Some((frame, value)) = checksum
            && session.committing_frame == Some(frame)
        {
            session.last_hash = format!("retail:{frame}:{value:08x}");
            session.next_tick += 1;
            session.submitted = false;
            session.committing = false;
            session.committing_frame = None;
        } else {
            fail(
                &mut session,
                "native committed turn has no matching Queue_AI checksum".into(),
                true,
            );
        }
    }
    if let Err(error) = begin_finishing_if_ready(state, &mut session) {
        fail(&mut session, error.to_string(), true);
    }
    publish(&session);
    state.platform.browser_online = !matches!(session.phase, Phase::Stopped | Phase::Finished);
    state.match_state.browser_network = Some(session);
}
