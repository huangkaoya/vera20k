//! Validated room handoff into the existing native network loading owner.

use crate::app::{AppState, GameScreen};
use crate::skirmish_launch::{
    AiDifficulty, LaunchCountry, LaunchHumanRole, LaunchStartPosition, LaunchTeam,
    PreFillHouseRoster, SkirmishAiSlot, SkirmishHumanSlot, SkirmishLaunchMode,
    SkirmishLaunchOptions, SkirmishLaunchSession, SkirmishLocalSlot,
};
use serde::Deserialize;
use std::collections::BTreeSet;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NetworkStartConfig {
    pub(super) match_id: String,
    seed: u32,
    map: String,
    local_player: usize,
    players: Vec<Player>,
    options: Options,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Player {
    slot: u8,
    name: String,
    country: LaunchCountry,
    color: u8,
    start: i32,
    team: i32,
    human: bool,
    difficulty: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    credits: i32,
    unit_count: i32,
    game_speed: i32,
    short_game: bool,
    super_weapons: bool,
    crates: bool,
    mcv_repacks: bool,
    build_off_ally: bool,
    destroyable_bridges: bool,
}

pub(super) fn start(state: &mut AppState, config: NetworkStartConfig) -> anyhow::Result<()> {
    anyhow::ensure!(
        state.frontend.screen == GameScreen::MainMenu,
        "请先退出当前对局"
    );
    anyhow::ensure!(
        !crate::app::browser_network::active(state),
        "已有网络对局尚未退出"
    );
    anyhow::ensure!(
        !config.match_id.is_empty() && config.match_id.len() <= 128,
        "对局标识无效"
    );
    anyhow::ensure!(
        (2..=8).contains(&config.players.len()),
        "网络对局需要 2 至 8 个玩家"
    );
    anyhow::ensure!(
        config
            .players
            .windows(2)
            .all(|pair| pair[0].slot < pair[1].slot),
        "玩家顺序必须按房间位置固定"
    );
    let map = state
        .frontend
        .scenario_catalog
        .shell_maps()
        .iter()
        .find(|map| map.file_name.eq_ignore_ascii_case(&config.map))
        .ok_or_else(|| anyhow::anyhow!("本地没有房间选择的地图"))?;
    anyhow::ensure!(
        map.player_capacity >= config.players.len() as i32,
        "地图不能容纳所有玩家"
    );
    let selected_map_file = map.file_name.clone();
    let mode = state
        .frontend
        .skirmish_modes
        .iter()
        .find(|mode| mode.class == crate::skirmish_modes::MpModeClass::Battle)
        .ok_or_else(|| anyhow::anyhow!("原生对战模式不可用"))?;
    let mode = SkirmishLaunchMode::from_game_mode(mode);
    let mut humans = Vec::new();
    let mut opponents = Vec::new();
    let (mut names, mut colors, mut starts) = (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
    for player in config.players {
        anyhow::ensure!(
            player.slot < 8
                && player.color < 8
                && (0..8).contains(&player.start)
                && (-1..4).contains(&player.team),
            "玩家位置、颜色或队伍无效"
        );
        anyhow::ensure!(
            !player.name.trim().is_empty() && player.name.len() <= 128,
            "玩家名称无效"
        );
        anyhow::ensure!(
            names.insert(player.name.to_lowercase())
                && colors.insert(player.color)
                && starts.insert(player.start),
            "玩家名称、颜色与出生位置必须各不相同"
        );
        anyhow::ensure!(
            map.multiplayer_start_waypoints
                .iter()
                .any(|waypoint| waypoint.index == player.start as u32),
            "地图没有指定的出生位置"
        );
        let slot = SkirmishLocalSlot {
            country: player.country,
            country_random: false,
            color_index: player.color,
            color_random: false,
            start_position: LaunchStartPosition::Position(player.start as u8),
            team: LaunchTeam::from_shell_value(player.team),
        };
        if player.human {
            humans.push(SkirmishHumanSlot {
                raw_slot_index: Some(player.slot),
                name: player.name,
                slot,
                role: LaunchHumanRole::default(),
            });
        } else {
            let difficulty = match player.difficulty.as_str() {
                "easy" => AiDifficulty::Easy,
                "normal" => AiDifficulty::Normal,
                "hard" => AiDifficulty::Hard,
                _ => anyhow::bail!("电脑难度无效"),
            };
            opponents.push(SkirmishAiSlot {
                raw_slot_index: player.slot,
                country: slot.country,
                country_random: false,
                color_index: slot.color_index,
                color_random: false,
                start_position: slot.start_position,
                team: slot.team,
                difficulty,
            });
        }
    }
    anyhow::ensure!(
        humans.len() >= 2 && config.local_player < humans.len(),
        "本地玩家不属于该房间"
    );
    anyhow::ensure!(
        (0..=1_000_000).contains(&config.options.credits)
            && (0..=100).contains(&config.options.unit_count)
            && (0..=6).contains(&config.options.game_speed),
        "对局选项超出范围"
    );
    let mut options = SkirmishLaunchOptions::default();
    options.starting_credits = config.options.credits;
    options.unit_count = config.options.unit_count;
    options.game_speed = config.options.game_speed;
    options.short_game = config.options.short_game;
    options.super_weapons = config.options.super_weapons;
    options.crates = config.options.crates;
    options.mcv_redeploy = config.options.mcv_repacks;
    options.build_off_ally = config.options.build_off_ally;
    options.bridges_destroyable = config.options.destroyable_bridges;
    let mut launch = SkirmishLaunchSession {
        mode,
        selected_map_file: Some(selected_map_file),
        humans,
        local_player_index: config.local_player,
        ai_player_count: opponents.len() as i32,
        pre_fill_house_roster: PreFillHouseRoster::from_compact_skirmish(opponents.len()),
        opponents,
        options,
    };
    launch.rebuild_house_roster();
    state
        .frontend
        .multiplayer_shell_runtime
        .validate_network_countries(&launch)?;
    crate::sim::scenario_bootstrap::MatchLaunchDescriptor::from_resolved(launch.clone())
        .map_err(|error| anyhow::anyhow!("房间出生设置未完成：{error}"))?;
    state
        .match_state
        .session
        .enter_network(crate::app::match_runtime::session::NetworkReturnContext::LanLobby);
    state
        .match_state
        .session
        .accept_network_setup(launch, config.local_player == 0, None)?;
    // The web service has its own all-player turn barrier. Retain native's
    // required timing receipt; no fake LAN peer packets or local seed draws.
    state.match_state.session.prepare_network_timing(2, || 0)?;
    let startup = state
        .match_state
        .session
        .freeze_network_start(config.seed)?;
    crate::app::browser_network::begin(state, config.match_id, config.local_player)?;
    state.frontend.shell_route = crate::app::shell_route::ShellRoute::MainMenu;
    crate::app::frontend::main_menu_shell_render::clear_ra2ts_movie_session(state);
    crate::app::loading::pump::begin_loading(
        state,
        crate::app::loading::pump::LoadingRequest::network(startup),
    );
    state.platform.window.request_redraw();
    Ok(())
}
