//! Presentation receipts from the browser content and lobby owners.
//!
//! These DTOs never author downloads, rooms, or simulation state. Missing
//! presentation fields retain defaults so older browser hosts remain readable.

use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ContentSnapshot {
    pub profile: String,
    pub addons: Vec<String>,
    pub profiles: Vec<ContentItem>,
    pub packs: Vec<ContentItem>,
    pub selection: ContentSelection,
    pub job: Option<ContentJob>,
    pub message: String,
    pub error: bool,
    pub downloading: bool,
    pub activating: bool,
    pub activation_allowed: bool,
    pub can_activate: bool,
    pub open: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ContentItem {
    pub id: String,
    pub title: String,
    pub description: String,
    pub bytes: u64,
    pub raw_bytes: u64,
    pub cached: String,
    pub included: bool,
    pub checked: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ContentSelection {
    pub bytes: u64,
    pub raw_bytes: u64,
    pub files: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ContentJob {
    pub title: String,
    pub file: String,
    pub completed_files: u32,
    pub total_files: u32,
    pub wire_bytes: u64,
    pub wire_total_bytes: u64,
    pub total_wire_bytes: u64,
    pub transferred_wire_bytes: u64,
    pub stage: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct LobbySnapshot {
    pub schema: u32,
    pub open: bool,
    pub name: String,
    pub code: String,
    pub connected: bool,
    pub busy: bool,
    pub status: String,
    pub error: String,
    pub match_id: Option<String>,
    pub starting: bool,
    pub stopped: bool,
    pub native_started: bool,
    pub phase: String,
    pub room: Option<LobbyRoom>,
}

impl Default for LobbySnapshot {
    fn default() -> Self {
        Self {
            schema: 1,
            open: false,
            name: String::new(),
            code: String::new(),
            connected: false,
            busy: false,
            status: String::new(),
            error: String::new(),
            match_id: None,
            starting: false,
            stopped: false,
            native_started: false,
            phase: "entry".to_owned(),
            room: None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct LobbyRoom {
    pub code: String,
    pub is_host: bool,
    pub local_member_id: String,
    pub members: Vec<LobbyMember>,
    pub can_start: bool,
    pub phase: String,
    pub config: LobbyConfig,
    pub status: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct LobbyMember {
    pub id: String,
    pub name: String,
    pub ready: bool,
    pub host: bool,
    pub slot: i32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct LobbyConfig {
    pub map: String,
    pub seed: u32,
    pub players: Vec<LobbyPlayer>,
    pub options: LobbyOptions,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct LobbyPlayer {
    pub slot: i32,
    pub name: String,
    pub country: String,
    pub color: i32,
    pub start: i32,
    pub team: i32,
    pub human: bool,
    pub difficulty: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct LobbyOptions {
    pub credits: u32,
    pub unit_count: u32,
    pub game_speed: u32,
    pub short_game: bool,
    pub super_weapons: bool,
    pub crates: bool,
    pub mcv_repacks: bool,
    pub build_off_ally: bool,
    pub destroyable_bridges: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_content_receipts_keep_safe_disabled_defaults() {
        let snapshot: ContentSnapshot = serde_json::from_str(
            r#"{"profile":"skirmish","profiles":[{"id":"skirmish","cached":"已校验缓存"}],"selection":{"files":26,"rawBytes":602239457},"job":{"wireTotalBytes":4110830,"stage":"verify"}}"#,
        )
        .unwrap();
        assert_eq!(snapshot.selection.files, 26);
        assert_eq!(snapshot.selection.raw_bytes, 602239457);
        assert_eq!(snapshot.profiles[0].cached, "已校验缓存");
        assert_eq!(snapshot.job.unwrap().wire_total_bytes, 4110830);
        assert!(!snapshot.can_activate);
        assert!(!snapshot.activation_allowed);
        assert!(!snapshot.error);
        assert!(snapshot.packs.is_empty());
    }

    #[test]
    fn lobby_receipts_preserve_signed_player_settings_and_maximum_seed() {
        let snapshot: LobbySnapshot = serde_json::from_str(
            r#"{"open":true,"matchId":null,"phase":"room","room":{"code":"ABCDEF","isHost":true,"localMemberId":"host-id","members":[{"id":"host-id","slot":0,"host":true,"ready":true}],"config":{"seed":4294967295,"players":[{"slot":0,"country":"Yuri","start":-1,"team":-1}],"options":{"unitCount":10,"mcvRepacks":true,"buildOffAlly":false}}}}"#,
        )
        .unwrap();
        assert_eq!(snapshot.schema, 1);
        assert_eq!(snapshot.phase, "room");
        assert!(snapshot.match_id.is_none());
        let room = snapshot.room.unwrap();
        assert!(room.is_host);
        assert_eq!(room.local_member_id, "host-id");
        assert_eq!(room.config.seed, u32::MAX);
        assert_eq!(room.config.players[0].start, -1);
        assert_eq!(room.config.players[0].team, -1);
        assert!(room.config.options.mcv_repacks);
        assert!(
            !room.can_start,
            "absent readiness never enables the start button"
        );
        let initial: LobbySnapshot = serde_json::from_str("{}").unwrap();
        assert_eq!(initial.phase, "entry");
        assert!(!initial.busy);
        assert!(initial.room.is_none());
    }
}
