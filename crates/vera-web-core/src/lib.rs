//! JSON boundary around the vendored VERA production runtime, shared by native and WASM.
//! Browser code owns transport, camera and drawing; it never writes simulation fields.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::BTreeSet;
use vera20k_core::assets::asset_manager::{AssetManager, MediaArchiveMode};
use vera20k_core::headless_scenario::{self, HeadlessScenario, SIM_TICK_MS};
use vera20k_core::sim::command::{Command, CommandEnvelope};
use vera20k_core::sim::intern::InternedId;
use vera20k_core::sim::production;
use vera20k_core::sim::scenario_bootstrap::normalized_launch_slots;
use vera20k_core::skirmish_launch::*;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlayerConfig {
    pub slot: u8,
    pub name: String,
    pub country: String,
    pub color: u8,
    #[serde(default = "random_start")]
    pub start: i16,
    #[serde(default)]
    pub team: i16,
    pub human: bool,
    #[serde(default = "normal_difficulty")]
    pub difficulty: String,
}
fn random_start() -> i16 {
    -1
}
fn normal_difficulty() -> String {
    "normal".into()
}
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub credits: Option<i32>,
    pub unit_count: Option<i32>,
    pub game_speed: Option<i32>,
    pub short_game: Option<bool>,
    pub super_weapons: Option<bool>,
    pub crates: Option<bool>,
    pub mcv_repacks: Option<bool>,
    pub build_off_ally: Option<bool>,
    pub destroyable_bridges: Option<bool>,
    pub fog_of_war: Option<bool>,
    pub shroud: Option<bool>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitConfig {
    pub map: String,
    pub seed: u32,
    pub players: Vec<PlayerConfig>,
    #[serde(default)]
    pub local_player: usize,
    pub view_player: Option<usize>,
    #[serde(default)]
    pub options: Options,
}

struct PlayerBinding {
    config: PlayerConfig,
    owner: InternedId,
    human_index: Option<usize>,
}
struct Session {
    scenario: HeadlessScenario,
    players: Vec<PlayerBinding>,
    view_player: usize,
    fatal_error: Option<String>,
}
#[derive(Default)]
pub struct Engine {
    files: Vec<(String, Vec<u8>)>,
    assets: Option<AssetManager>,
    session: Option<Session>,
}

fn country(name: &str) -> Result<LaunchCountry, String> {
    match name {
        "America" => Ok(LaunchCountry::America),
        "Korea" => Ok(LaunchCountry::Korea),
        "France" => Ok(LaunchCountry::France),
        "Germany" => Ok(LaunchCountry::Germany),
        "GreatBritain" => Ok(LaunchCountry::GreatBritain),
        "Libya" => Ok(LaunchCountry::Libya),
        "Iraq" => Ok(LaunchCountry::Iraq),
        "Cuba" => Ok(LaunchCountry::Cuba),
        "Russia" => Ok(LaunchCountry::Russia),
        "Yuri" => Ok(LaunchCountry::Yuri),
        _ => Err(format!(
            "unsupported country {name}; use an explicit VERA country name"
        )),
    }
}
fn start(value: i16) -> Result<LaunchStartPosition, String> {
    match value {
        -1 => Ok(LaunchStartPosition::Auto),
        0..=7 => Ok(LaunchStartPosition::Position(value as u8)),
        _ => Err("start must be -1 or 0..7".into()),
    }
}
fn team(value: i16) -> Result<LaunchTeam, String> {
    match value {
        -1 | 0 => Ok(LaunchTeam::None),
        1..=4 => Ok(LaunchTeam::Team(value as u8)),
        _ => Err("team must be -1, 0, or 1..4".into()),
    }
}
fn difficulty(value: &str) -> Result<AiDifficulty, String> {
    match value {
        "easy" => Ok(AiDifficulty::Easy),
        "normal" => Ok(AiDifficulty::Normal),
        "hard" => Ok(AiDifficulty::Hard),
        _ => Err(format!("unsupported AI difficulty {value}")),
    }
}
fn launch(config: &InitConfig) -> Result<SkirmishLaunchSession, String> {
    if config.players.is_empty() || config.players.len() > 8 {
        return Err("a match needs 1..8 active players".into());
    }
    let mut slots = BTreeSet::new();
    let mut colors = BTreeSet::new();
    let mut starts = BTreeSet::new();
    for p in &config.players {
        if p.slot > 7 || !slots.insert(p.slot) {
            return Err("active lobby slots must be distinct and within 0..7".into());
        }
        if p.color > 7 || !colors.insert(p.color) {
            return Err("active colors must be distinct and within 0..7".into());
        }
        if p.start >= 0 && !starts.insert(p.start) {
            return Err("fixed player starts must be distinct".into());
        }
        if p.name.trim().is_empty() {
            return Err("player names must not be empty".into());
        }
    }
    let mut players = config.players.clone();
    players.sort_by_key(|p| p.slot);
    let mut result = headless_scenario::battle_session(&config.map, &[]);
    result.humans.clear();
    result.opponents.clear();
    for p in players {
        let c = country(&p.country)?;
        let s = start(p.start)?;
        let t = team(p.team)?;
        if p.human {
            result.humans.push(SkirmishHumanSlot {
                raw_slot_index: Some(p.slot),
                name: p.name,
                slot: SkirmishLocalSlot {
                    country: c,
                    country_random: false,
                    color_index: p.color,
                    color_random: false,
                    start_position: s,
                    team: t,
                },
                role: LaunchHumanRole::default(),
            });
        } else {
            result.opponents.push(SkirmishAiSlot {
                raw_slot_index: p.slot,
                country: c,
                country_random: false,
                color_index: p.color,
                color_random: false,
                start_position: s,
                team: t,
                difficulty: difficulty(&p.difficulty)?,
            });
        }
    }
    if result.humans.is_empty() {
        return Err("at least one human player is required".into());
    }
    if config.local_player >= result.humans.len() {
        return Err("localPlayer is outside the compact human list".into());
    }
    // A canonical current house is part of match setup. The viewer is wrapper-only.
    result.local_player_index = 0;
    result.ai_player_count = result.opponents.len() as i32;
    let o = &config.options;
    let r = &mut result.options;
    if let Some(n) = o.credits {
        if !(0..=1000000).contains(&n) {
            return Err("credits outside 0..1000000".into());
        }
        r.starting_credits = n;
    }
    if let Some(n) = o.unit_count {
        if !(0..=100).contains(&n) {
            return Err("unitCount outside 0..100".into());
        }
        r.unit_count = n;
    }
    if let Some(n) = o.game_speed {
        if !(0..=6).contains(&n) {
            return Err("gameSpeed outside 0..6".into());
        }
        r.game_speed = n;
    }
    if let Some(v) = o.short_game {
        r.short_game = v;
    }
    if let Some(v) = o.super_weapons {
        r.super_weapons = v;
    }
    if let Some(v) = o.crates {
        r.crates = v;
    }
    if let Some(v) = o.mcv_repacks {
        r.mcv_redeploy = v;
    }
    if let Some(v) = o.build_off_ally {
        r.build_off_ally = v;
    }
    if let Some(v) = o.destroyable_bridges {
        r.bridges_destroyable = v;
    }
    if let Some(v) = o.fog_of_war {
        r.fog_of_war = v;
    }
    if let Some(v) = o.shroud {
        r.shroud = v;
    }
    result.rebuild_house_roster();
    Ok(result)
}
impl Engine {
    pub fn new() -> Self {
        Self::default()
    }
    /// Takes ownership of exactly one file buffer. Register all assets before init.
    pub fn asset(&mut self, name: String, bytes: Vec<u8>) -> Result<(), String> {
        if self.assets.is_some() || self.session.is_some() {
            return Err("dispose with clearAssets before changing registered files".into());
        }
        if name.is_empty() || name.contains(['/', '\\']) || name == ".." {
            return Err("asset names must be plain file names".into());
        }
        if self
            .files
            .iter()
            .any(|(n, _)| n.eq_ignore_ascii_case(&name))
        {
            return Err(format!("duplicate asset {name}"));
        }
        self.files.push((name, bytes));
        Ok(())
    }
    /// Native oracle can use identical disk archive resolution without transferring buffers.
    pub fn install_native_assets(&mut self, root: &std::path::Path) -> Result<(), String> {
        self.assets = Some(
            AssetManager::new(root, MediaArchiveMode::STOCK_DIGITAL).map_err(|e| e.to_string())?,
        );
        Ok(())
    }
    pub fn execute(&mut self, request: &Value) -> Result<Value, String> {
        let op = request
            .get("op")
            .and_then(Value::as_str)
            .ok_or("request needs op")?;
        match op {
            "init" => {
                self.session = None;
                let config: InitConfig = serde_json::from_value(
                    request.get("config").cloned().ok_or("init needs config")?,
                )
                .map_err(|e| e.to_string())?;
                let setup = launch(&config)?;
                let normalized = normalized_launch_slots(&setup);
                if self.assets.is_none() {
                    let files = std::mem::take(&mut self.files);
                    if files.is_empty() {
                        return Err("no retail asset files have been registered".into());
                    }
                    self.assets = Some(
                        AssetManager::from_memory_files(files, MediaArchiveMode::STOCK_DIGITAL)
                            .map_err(|e| e.to_string())?,
                    );
                }
                let scenario = headless_scenario::load_session_with_assets(
                    self.assets.as_ref().unwrap().clone(),
                    &config.map,
                    config.seed,
                    setup,
                )?;
                let mut ordered = config.players.clone();
                ordered.sort_by_key(|p| p.slot);
                let humans: Vec<_> = ordered.iter().filter(|p| p.human).collect();
                let ais: Vec<_> = ordered.iter().filter(|p| !p.human).collect();
                let mut bindings = Vec::new();
                for slot in normalized {
                    let p = if let Some(index) = slot.source_human_index {
                        (*humans[index]).clone()
                    } else {
                        let index = slot
                            .owner_name
                            .strip_prefix("Computer")
                            .and_then(|n| n.parse::<usize>().ok())
                            .ok_or("invalid normalized AI owner")?
                            - 1;
                        (*ais[index]).clone()
                    };
                    let owner = scenario
                        .sim()
                        .interner()
                        .get(&slot.owner_name)
                        .ok_or("initialized launch house missing")?;
                    bindings.push(PlayerBinding {
                        config: p,
                        owner,
                        human_index: slot.source_human_index,
                    });
                }
                let view = config.view_player.unwrap_or(config.local_player);
                if view >= humans.len() {
                    return Err("viewPlayer is outside the compact human list".into());
                }
                self.session = Some(Session {
                    scenario,
                    players: bindings,
                    view_player: view,
                    fatal_error: None,
                });
                Ok(json!({"ok":true,"snapshot":self.session.as_ref().unwrap().snapshot()?}))
            }
            "tick" => {
                let session = self.session.as_mut().ok_or("no active match")?;
                if let Some(error) = &session.fatal_error {
                    return Err(error.clone());
                }
                let count = match request.get("ticks") {
                    Some(v) => v.as_u64().ok_or("ticks must be an unsigned integer")?,
                    None => 1,
                };
                if count == 0 || count > 600 {
                    return Err("ticks must be 1..600".into());
                }
                let commands = match request.get("commands") {
                    Some(v) => v.as_array().ok_or("commands must be an array")?.clone(),
                    None => Vec::new(),
                };
                let envelopes = session.commands(&commands)?;
                for i in 0..count {
                    let runtime = &mut session.scenario.runtime;
                    if i == 0 {
                        runtime.simulation.queue_commands(envelopes.clone());
                    }
                    let due = runtime.simulation.take_due_commands();
                    // SimRuntime's admission prefix owns production publication and
                    // folds newly generated mobile PLACE into this frame exactly once.
                    if let Err(error) = runtime.advance_frame_for_tooling(&due, SIM_TICK_MS) {
                        let error = format!(
                            "fatal simulation frame error: {error}; reinitialize the match"
                        );
                        session.fatal_error = Some(error.clone());
                        return Err(error);
                    }
                }
                Ok(json!({"ok":true,"snapshot":session.snapshot()?}))
            }
            "diagnostics" => {
                let s = self.session.as_ref().ok_or("no active match")?;
                let sim = s.scenario.sim();
                let owners: std::collections::BTreeMap<_, _> = sim
                    .hash_owner_diagnostics_for_test()
                    .into_iter()
                    .map(|(key, value)| (key, format!("{value:016x}")))
                    .collect();
                let save = if request.get("includeSave").and_then(Value::as_bool) == Some(true) {
                    Some(
                        vera20k_core::sim::snapshot::GameSnapshot::save_validated_with_presentation(
                            sim,
                            0,
                            0,
                            "diagnostic",
                            0,
                            &[],
                            None,
                            None,
                            None,
                            None,
                        ),
                    )
                } else {
                    None
                };
                Ok(
                    json!({"ok":true,"diagnostics":{"owners":owners,"digest":sim.parity_digest(),"save":save}}),
                )
            }
            "snapshot" => {
                let s = self.session.as_mut().ok_or("no active match")?;
                if let Some(view) = request.get("viewPlayer") {
                    let view = view
                        .as_u64()
                        .ok_or("viewPlayer must be an unsigned integer")?;
                    s.owner_for_human(view as usize)?;
                    s.view_player = view as usize;
                }
                Ok(json!({"ok":true,"snapshot":s.snapshot()?}))
            }
            "placement" => {
                let s = self.session.as_ref().ok_or("no active match")?;
                let owner = s.owner_for_human(s.view_player)?;
                let sim = s.scenario.sim();
                let r = &s.scenario.runtime.resources;
                let type_id = text_field(request, "typeId")?;
                let rx = cell_field(request, "rx")?;
                let ry = cell_field(request, "ry")?;
                let preview = production::placement_preview_for_owner_with_overlays(
                    sim,
                    &r.rules,
                    sim.resolve(owner),
                    type_id,
                    rx,
                    ry,
                    Some(&r.overlay_registry),
                )
                .ok_or("unknown building type")?;
                Ok(
                    json!({"ok":true,"placement":{"rx":rx,"ry":ry,"width":preview.width,"height":preview.height,"valid":preview.valid,"inBuildArea":preview.in_build_area,"reason":preview.reason.map(|r|r.label().to_owned())}}),
                )
            }
            "dispose" => {
                self.session = None;
                if request.get("clearAssets").and_then(Value::as_bool) == Some(true) {
                    self.assets = None;
                    self.files.clear();
                }
                Ok(json!({"ok":true}))
            }
            _ => Err(format!("unknown operation {op}")),
        }
    }
    pub fn call(&mut self, input: &str) -> String {
        let result = serde_json::from_str(input)
            .map_err(|e| e.to_string())
            .and_then(|v| self.execute(&v));
        match result {
            Ok(value) => value.to_string(),
            Err(error) => json!({"ok":false,"error":error}).to_string(),
        }
    }
}
fn text_field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("command needs {key}"))
}
fn id_field(v: &Value, key: &str) -> Result<u64, String> {
    v.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("command needs unsigned {key}"))
}
fn cell_field(v: &Value, key: &str) -> Result<u16, String> {
    u16::try_from(id_field(v, key)?).map_err(|_| format!("{key} exceeds cell range"))
}
fn entity_ids(v: &Value) -> Result<Vec<u64>, String> {
    if let Some(values) = v.get("entityIds").and_then(Value::as_array) {
        values
            .iter()
            .map(|v| {
                v.as_u64()
                    .ok_or("entityIds must be unsigned integers".into())
            })
            .collect()
    } else {
        Ok(vec![id_field(v, "entityId")?])
    }
}
impl Session {
    fn owner_for_human(&self, index: usize) -> Result<InternedId, String> {
        self.players
            .iter()
            .find(|p| p.human_index == Some(index))
            .map(|p| p.owner)
            .ok_or_else(|| format!("unknown human player {index}"))
    }
    fn commands(&self, values: &[Value]) -> Result<Vec<CommandEnvelope>, String> {
        if values.len() > 1024 {
            return Err("at most 1024 commands per frame".into());
        }
        let sim = self.scenario.sim();
        let tick = sim.session().tick() + 1;
        let mut result = Vec::new();
        for v in values {
            let player = match v.get("player") {
                Some(v) => v
                    .as_u64()
                    .ok_or("player must be an unsigned compact human index")?
                    as usize,
                None => self.view_player,
            };
            let owner = self.owner_for_human(player)?;
            let kind = text_field(v, "kind")?;
            if !matches!(
                kind,
                "queue"
                    | "produce"
                    | "place"
                    | "cancel"
                    | "cancelProduction"
                    | "select"
                    | "move"
                    | "attack"
                    | "attackMove"
                    | "scatter"
                    | "forceAttack"
                    | "deploy"
                    | "stop"
                    | "guard"
                    | "sell"
                    | "repair"
            ) {
                return Err(format!("unknown command {kind}"));
            }
            if matches!(kind, "move" | "attackMove" | "forceAttack") {
                cell_field(v, "rx")?;
                cell_field(v, "ry")?;
            }
            if kind == "attack" {
                id_field(v, "targetId")?;
            }
            let mut append = |payload| result.push(CommandEnvelope::new(owner, tick, payload));
            if matches!(
                kind,
                "queue" | "produce" | "place" | "cancel" | "cancelProduction"
            ) {
                let name = text_field(v, "typeId")?;
                let type_id = sim
                    .interner()
                    .get(name)
                    .filter(|id| {
                        sim.object_type(*id, &self.scenario.runtime.resources.rules)
                            .is_some()
                    })
                    .ok_or_else(|| format!("unknown production type {name}"))?;
                append(if kind == "place" {
                    Command::PlaceReadyBuilding {
                        type_id,
                        rx: cell_field(v, "rx")?,
                        ry: cell_field(v, "ry")?,
                    }
                } else if matches!(kind, "cancel" | "cancelProduction") {
                    Command::CancelProductionByType {
                        type_id,
                        all: v.get("all").and_then(Value::as_bool).unwrap_or(false),
                    }
                } else {
                    Command::QueueProduction { type_id }
                });
                continue;
            }
            // Native expired pointers do not invalidate a committed network batch.
            // Live actors still enforce ownership, and malformed IDs remain errors.
            let ids: Vec<_> = entity_ids(v)?
                .into_iter()
                .filter(|id| sim.entities().get(*id).is_some())
                .collect();
            for id in &ids {
                let entity = sim.entities().get(*id).expect("retained live actor lookup");
                if entity.owner() != owner {
                    return Err(format!("entity {id} is not owned by player"));
                }
            }
            if kind == "select" {
                append(Command::Select {
                    entity_ids: ids,
                    additive: v.get("additive").and_then(Value::as_bool).unwrap_or(false),
                });
                continue;
            }
            for id in ids {
                append(match kind {
                    "move" => Command::Move {
                        entity_id: id,
                        target_rx: cell_field(v, "rx")?,
                        target_ry: cell_field(v, "ry")?,
                    },
                    "attackMove" => Command::AttackMove {
                        entity_id: id,
                        target: None,
                        destination: Some(vera20k_core::sim::combat::TargetKind::Cell(
                            cell_field(v, "rx")?,
                            cell_field(v, "ry")?,
                        )),
                    },
                    "scatter" => Command::Scatter { entity_id: id },
                    "forceAttack" => Command::ForceAttackCell {
                        attacker_id: id,
                        target_rx: cell_field(v, "rx")?,
                        target_ry: cell_field(v, "ry")?,
                    },
                    "attack" => Command::Attack {
                        attacker_id: id,
                        target_id: id_field(v, "targetId")?,
                    },
                    "deploy" => Command::DeployMcv { entity_id: id },
                    "stop" => Command::Stop { entity_id: id },
                    "guard" => Command::Guard {
                        entity_id: id,
                        target: None,
                    },
                    "sell" => Command::SellBuilding { entity_id: id },
                    "repair" => Command::ToggleRepair { entity_id: id },
                    _ => return Err(format!("unknown command {kind}")),
                });
            }
        }
        Ok(result)
    }
    fn snapshot(&self) -> Result<Value, String> {
        if let Some(error) = &self.fatal_error {
            return Err(error.clone());
        }
        let sim = self.scenario.sim();
        let rules = &self.scenario.runtime.resources.rules;
        let owner = self.owner_for_human(self.view_player)?;
        let owner_name = sim.resolve(owner);
        let frame = sim.session().binary_frame();
        let entities:Vec<_>=sim.entities().values_sorted().map(|e|{
            let p=e.position;
            let (sx,sy)=vera20k_core::util::lepton::lepton_to_screen_exact_z(p.rx(),p.ry(),p.sub_x(),p.sub_y(),p.exact_z_leptons().unwrap_or(i32::from(p.z() as i8)*vera20k_core::util::lepton::GROUND_LEVEL_HEIGHT_LEPTONS));
            let max_hp=sim.object_type(e.type_ref(),rules).map_or(e.health.current(),|o|o.strength);
            let category=match e.category(){vera20k_core::map::entities::EntityCategory::Infantry=>"infantry",vera20k_core::map::entities::EntityCategory::Unit=>"unit",vera20k_core::map::entities::EntityCategory::Aircraft=>"aircraft",vera20k_core::map::entities::EntityCategory::Structure=>"structure"};
            json!({"id":e.stable_id(),"typeId":sim.resolve(e.type_ref()),"owner":e.owner().index(),"rx":p.rx(),"ry":p.ry(),"subX":p.sub_x().to_num::<f64>(),"subY":p.sub_y().to_num::<f64>(),"z":p.z(),"sx":sx,"sy":sy,"facing":e.body_facing_byte(frame),"hp":e.health.current(),"maxHp":max_hp,"category":category,"limbo":e.in_limbo(),"alive":e.is_alive(),"visible":sim.fog().is_cell_visible(owner,p.rx(),p.ry())})
        }).collect();
        let players:Vec<_>=self.players.iter().map(|p|{
            let (power,drain)=production::power_balance_for_owner(sim,rules,sim.resolve(p.owner));
            let house=sim.houses().get(&p.owner);
            json!({"owner":p.owner.index(),"slot":p.config.slot,"humanIndex":p.human_index,"name":p.config.name,"country":p.config.country,"color":p.config.color,"human":p.config.human,"credits":production::credits_for_owner(sim,sim.resolve(p.owner)),"power":power,"drain":drain,"defeated":house.is_some_and(|h|h.is_defeated())})
        }).collect();
        let options:Vec<_>=production::build_options_for_owner(sim,rules,owner_name).into_iter().map(|o|json!({"typeId":sim.resolve(o.type_id),"displayName":o.display_name,"cost":o.cost,"category":format!("{:?}",o.queue_category).to_lowercase(),"enabled":o.enabled,"reason":o.reason.map(|r|format!("{r:?}"))})).collect();
        let queues:Vec<_>=production::queue_view_for_owner(sim,rules,owner_name).into_iter().map(|q|{
            let progress=sim.production().factories().view(owner,q.queue_category).map_or(0,|f|f.progress);
            json!({"typeId":sim.resolve(q.type_id),"displayName":q.display_name,"category":format!("{:?}",q.queue_category).to_lowercase(),"state":format!("{:?}",q.state).to_lowercase(),"progress":if q.state == production::BuildQueueState::Queued {0}else{progress},"total":production::PRODUCTION_STEPS})
        }).collect();
        let ready:Vec<_>=production::ready_buildings_for_owner(sim,rules,owner_name).into_iter().map(|r|json!({"typeId":sim.resolve(r.type_id),"displayName":r.display_name,"category":format!("{:?}",r.queue_category).to_lowercase()})).collect();
        let fog = sim.fog();
        let cells = if let Some(v) = fog.by_owner().get(&owner) {
            v.cells_raw().to_vec()
        } else {
            vec![0; usize::from(fog.width()) * usize::from(fog.height())]
        };
        let map = &self.scenario.map;
        let mut starts: Vec<_> = map
            .waypoints
            .values()
            .filter(|w| w.index < 8)
            .map(|w| json!({"index":w.index,"rx":w.rx,"ry":w.ry}))
            .collect();
        starts.sort_by_key(|w| w["index"].as_u64());
        Ok(
            json!({"tick":sim.session().tick(),"stateHash":format!("{:016x}",sim.state_hash()),"tickMs":SIM_TICK_MS,"localOwner":owner.index(),"viewPlayer":self.view_player,"entities":entities,"players":players,"buildOptions":options,"queues":queues,"ready":ready,"fog":{"width":fog.width(),"height":fog.height(),"cells":cells},"map":{"id":sim.session().map_name(),"width":map.header.width,"height":map.header.height,"localLeft":map.header.local_left,"localTop":map.header.local_top,"localWidth":map.header.local_width,"localHeight":map.header.local_height,"theater":map.header.theater,"starts":starts}}),
        )
    }
}

thread_local! {static ENGINE:RefCell<Engine>=RefCell::new(Engine::new());static RESULT:RefCell<Vec<u8>>=const{RefCell::new(Vec::new())};}
fn set_result(value: String) -> *const u8 {
    RESULT.with(|r| {
        *r.borrow_mut() = value.into_bytes();
        r.borrow().as_ptr()
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn vw_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}
/// # Safety: pointer must come from vw_alloc with exactly this length and must not have been consumed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vw_dealloc(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        unsafe {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
        }
    }
}
/// Consumes BOTH allocations, including on error. Never deallocate them after this call.
/// # Safety: both pointers must come from vw_alloc with exact lengths and non-overlapping ownership.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vw_asset(
    name: *mut u8,
    name_len: usize,
    data: *mut u8,
    data_len: usize,
) -> i32 {
    let name =
        unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(name, name_len)) }.into_vec();
    let bytes =
        unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(data, data_len)) }.into_vec();
    let result = String::from_utf8(name)
        .map_err(|e| e.to_string())
        .and_then(|n| ENGINE.with(|e| e.borrow_mut().asset(n, bytes)));
    match result {
        Ok(()) => {
            set_result("{\"ok\":true}".into());
            0
        }
        Err(error) => {
            set_result(json!({"ok":false,"error":error}).to_string());
            -1
        }
    }
}
/// Borrows input until return. Result is borrowed and remains valid until the next call/asset.
/// # Safety: input must be a readable UTF-8 buffer of len bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vw_call(input: *const u8, len: usize) -> *const u8 {
    let bytes = unsafe { std::slice::from_raw_parts(input, len) };
    let result = match std::str::from_utf8(bytes) {
        Ok(input) => ENGINE.with(|e| e.borrow_mut().call(input)),
        Err(e) => json!({"ok":false,"error":e.to_string()}).to_string(),
    };
    set_result(result)
}
#[unsafe(no_mangle)]
pub extern "C" fn vw_result_len() -> usize {
    RESULT.with(|r| r.borrow().len())
}
#[unsafe(no_mangle)]
pub extern "C" fn vw_result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_config_rejects_duplicate_slots_and_werhd_country_sentinels() {
        let mut c:InitConfig=serde_json::from_value(json!({"map":"XMP29U2.MAP","seed":1,"players":[{"slot":0,"name":"Player","country":"America","color":0,"human":true}]})).unwrap();
        assert_eq!(launch(&c).unwrap().local_player_index, 0);
        c.players[0].country = "-2".into();
        assert!(launch(&c).is_err());
    }
    #[test]
    fn invalid_calls_never_fake_a_running_simulation() {
        let mut e = Engine::new();
        assert!(e.call("{\"op\":\"tick\"}").contains("no active match"));
        assert!(e.call("not json").contains("\"ok\":false"));
    }
}
