//! The native lobby is a presentation of server-admitted room configuration.
use super::model::LobbySnapshot;
use super::{Choice, Control, EditField, Label, Panel, RectPx};
use serde_json::{Value, json};

const COUNTRIES: [(&str, &str); 10] = [
    ("America", "美国"),
    ("Korea", "韩国"),
    ("France", "法国"),
    ("Germany", "德国"),
    ("GreatBritain", "英国"),
    ("Libya", "利比亚"),
    ("Iraq", "伊拉克"),
    ("Cuba", "古巴"),
    ("Russia", "苏俄"),
    ("Yuri", "尤里"),
];
const COLORS: [&str; 8] = [
    "黄色", "红色", "蓝色", "绿色", "橙色", "青色", "紫色", "粉色",
];

fn player_choices(slot: i32, key: &str, values: Vec<(Value, String)>) -> Vec<Choice> {
    values
        .into_iter()
        .map(|(value, label)| Choice {
            label,
            action: json!({"action":"updatePlayer","slot":slot,"player":{key:value}}),
        })
        .collect()
}
fn settings_choices(key: &str, values: &[(i32, &str)]) -> Vec<Choice> {
    values
        .iter()
        .map(|(value, label)| Choice {
            label: (*label).into(),
            action: json!({"action":"updateSettings","settings":{key:value}}),
        })
        .collect()
}
fn number_label(value: i32, values: &[(i32, &str)]) -> String {
    values
        .iter()
        .find(|(n, _)| *n == value)
        .map_or_else(|| value.to_string(), |(_, label)| (*label).into())
}

pub(super) fn view(state: &LobbySnapshot, name: &str, code: &str) -> Panel {
    let mut panel = Panel {
        title: "联机作战大厅".into(),
        subtitle: "王二火大 · 火线冲突 (2) · 与战友一起，再战一局".into(),
        ..Default::default()
    };
    panel.controls.push(Control::button(
        "lobby.close",
        "返回主菜单",
        RectPx::new(32, 550, 175, 32),
        true,
        json!({"action":"close"}),
    ));
    let busy = state.busy || state.starting || state.match_id.is_some();
    if let Some(room) = state.room.as_ref() {
        panel.labels.push(Label::new(
            format!(
                "房间 {}    {} / 2    {}",
                room.code,
                room.members.len(),
                if room.is_host {
                    "你是房主"
                } else {
                    "等待房主配置"
                }
            ),
            RectPx::new(34, 94, 730, 23),
        ));
        for (label, x, w) in [
            ("指挥官", 40, 170),
            ("国家", 215, 135),
            ("颜色", 360, 115),
            ("出生点", 485, 115),
            ("队伍", 610, 145),
        ] {
            panel
                .labels
                .push(Label::new(label, RectPx::new(x, 125, w, 21)));
        }
        let editable = room.is_host && !busy;
        for (index, member) in room.members.iter().take(2).enumerate() {
            let y = 151 + index as i32 * 58;
            let player = room.config.players.iter().find(|p| p.slot == member.slot);
            panel.labels.push(Label::new(
                format!(
                    "{}{}\n{}",
                    member.name,
                    if member.host { " · 房主" } else { "" },
                    if member.ready {
                        "已准备"
                    } else {
                        "未准备"
                    }
                ),
                RectPx::new(40, y, 170, 46),
            ));
            let country = player.map_or("America", |p| p.country.as_str());
            let country_label = COUNTRIES
                .iter()
                .find(|(id, _)| *id == country)
                .map_or(country, |(_, label)| *label);
            panel.controls.push(Control::select(
                format!("lobby.player.{}.country", member.slot),
                country_label,
                RectPx::new(215, y, 135, 32),
                editable,
                player_choices(
                    member.slot,
                    "country",
                    COUNTRIES
                        .iter()
                        .map(|(id, label)| (json!(id), (*label).into()))
                        .collect(),
                ),
            ));
            let color = player.map_or(member.slot, |p| p.color);
            panel.controls.push(Control::select(
                format!("lobby.player.{}.color", member.slot),
                COLORS.get(color.max(0) as usize).copied().unwrap_or("随机"),
                RectPx::new(360, y, 115, 32),
                editable,
                player_choices(
                    member.slot,
                    "color",
                    COLORS
                        .iter()
                        .enumerate()
                        .map(|(i, label)| (json!(i), (*label).into()))
                        .collect(),
                ),
            ));
            let start = player.map_or(member.slot, |p| p.start);
            panel.controls.push(Control::select(
                format!("lobby.player.{}.start", member.slot),
                format!("{}", start + 1),
                RectPx::new(485, y, 115, 32),
                editable,
                player_choices(
                    member.slot,
                    "start",
                    vec![(json!(0), "1".into()), (json!(1), "2".into())],
                ),
            ));
            let team = player.map_or(-1, |p| p.team);
            panel.controls.push(Control::select(
                format!("lobby.player.{}.team", member.slot),
                number_label(team, &[(-1, "无"), (0, "A"), (1, "B"), (2, "C"), (3, "D")]),
                RectPx::new(610, y, 145, 32),
                editable,
                player_choices(
                    member.slot,
                    "team",
                    vec![
                        (json!(-1), "无".into()),
                        (json!(0), "A".into()),
                        (json!(1), "B".into()),
                        (json!(2), "C".into()),
                        (json!(3), "D".into()),
                    ],
                ),
            ));
        }
        if room.members.len() < 2 {
            panel.labels.push(Label::new(
                "等待另一位指挥官加入…",
                RectPx::new(215, 212, 540, 30),
            ));
        }
        let settings = &room.config.options;
        for (key, label, value, x, choices) in [
            (
                "credits",
                "初始资金",
                settings.credits as i32,
                40,
                vec![
                    (5000, "5,000"),
                    (10000, "10,000"),
                    (20000, "20,000"),
                    (30000, "30,000"),
                ],
            ),
            (
                "unitCount",
                "初始部队",
                settings.unit_count as i32,
                285,
                vec![(0, "无"), (5, "5"), (10, "10")],
            ),
            (
                "gameSpeed",
                "游戏速度",
                settings.game_speed as i32,
                530,
                vec![
                    (0, "极速"),
                    (1, "很快"),
                    (2, "较快"),
                    (3, "正常"),
                    (4, "较慢"),
                    (5, "慢速"),
                    (6, "最慢"),
                ],
            ),
        ] {
            panel
                .labels
                .push(Label::new(label, RectPx::new(x, 269, 220, 22)));
            panel.controls.push(Control::select(
                format!("lobby.settings.{key}"),
                number_label(value, &choices),
                RectPx::new(x, 296, 220, 32),
                editable,
                settings_choices(key, &choices),
            ));
        }
        for (index, (key, label, checked)) in [
            ("shortGame", "快速游戏", settings.short_game),
            ("superWeapons", "超级武器", settings.super_weapons),
            ("crates", "随机工具箱", settings.crates),
            ("mcvRepacks", "基地重新部署", settings.mcv_repacks),
            ("buildOffAlly", "盟友旁建造", settings.build_off_ally),
            (
                "destroyableBridges",
                "可摧毁桥梁",
                settings.destroyable_bridges,
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let x = 40 + (index % 2) as i32 * 370;
            let y = 346 + (index / 2) as i32 * 34;
            panel.controls.push(Control::check(
                format!("lobby.settings.{key}"),
                label,
                RectPx::new(x, y, 350, 29),
                editable,
                checked,
                json!({"action":"updateSettings","settings":{key:!checked}}),
            ));
        }
        panel.controls.push(Control::button(
            "lobby.leave",
            "离开房间",
            RectPx::new(233, 550, 175, 32),
            !state.busy,
            json!({"action":"leave"}),
        ));
        if room.is_host {
            panel.controls.push(Control::button(
                "lobby.start",
                "开始作战",
                RectPx::new(548, 550, 220, 32),
                room.can_start && !busy,
                json!({"action":"start"}),
            ));
        } else {
            let ready = room
                .members
                .iter()
                .find(|m| m.id == room.local_member_id)
                .is_some_and(|m| m.ready);
            panel.controls.push(Control::button(
                "lobby.ready",
                if ready {
                    "取消准备"
                } else {
                    "准备就绪"
                },
                RectPx::new(548, 550, 220, 32),
                !busy,
                json!({"action":"ready"}),
            ));
        }
    } else if state.stopped || state.phase == "stopped" {
        panel
            .labels
            .push(Label::new("对局已停止", RectPx::new(70, 150, 660, 32)));
        panel.labels.push(Label::new(
            "请返回主菜单，再开始下一场作战。",
            RectPx::new(70, 204, 660, 50),
        ));
    } else {
        panel
            .labels
            .push(Label::new("指挥官名称", RectPx::new(60, 114, 170, 28)));
        panel.controls.push(Control::edit(
            "lobby.name",
            name,
            RectPx::new(245, 110, 490, 34),
            !busy,
            EditField::Name,
        ));
        panel
            .labels
            .push(Label::new("建立作战房间", RectPx::new(62, 192, 305, 27)));
        panel.labels.push(Label::new(
            "创建后，将房间代码告诉另一位指挥官。",
            RectPx::new(62, 236, 305, 64),
        ));
        panel.controls.push(Control::button(
            "lobby.create",
            "创建房间",
            RectPx::new(62, 324, 305, 36),
            !busy,
            json!({"action":"create","name":name}),
        ));
        panel
            .labels
            .push(Label::new("加入战友", RectPx::new(430, 192, 305, 27)));
        panel
            .labels
            .push(Label::new("房间代码", RectPx::new(430, 236, 305, 25)));
        panel.controls.push(Control::edit(
            "lobby.code",
            code,
            RectPx::new(430, 270, 305, 34),
            !busy,
            EditField::Code,
        ));
        panel.controls.push(Control::button(
            "lobby.join",
            "加入房间",
            RectPx::new(430, 324, 305, 36),
            !busy && !code.trim().is_empty(),
            json!({"action":"join","code":code,"name":name}),
        ));
        panel.labels.push(Label::new(
            "选定国家、颜色、出生点和队伍，双方准备后由房主开战。",
            RectPx::new(62, 399, 673, 45),
        ));
    }
    let status = if !state.error.is_empty() {
        &state.error
    } else if !state.status.is_empty() {
        &state.status
    } else if state.starting {
        "双方正在载入原生战场…"
    } else if state.busy {
        "正在联络…"
    } else if state.connected {
        "联机服务已连接"
    } else {
        "创建或加入房间后连接联机服务"
    };
    let mut label = Label::new(status, RectPx::new(40, 466, 714, 62));
    if !state.error.is_empty() {
        label.rgb = [1.0, 0.38, 0.28];
    }
    panel.labels.push(label);
    panel
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entry_join_requires_a_code_and_forwards_native_edit_values() {
        let panel = view(&LobbySnapshot::default(), "指挥官", "ABC123");
        let join = panel
            .controls
            .iter()
            .find(|c| c.id == "lobby.join")
            .unwrap();
        assert!(join.enabled);
        assert_eq!(join.action["code"], "ABC123");
        assert_eq!(join.action["name"], "指挥官");
        let empty = view(&LobbySnapshot::default(), "指挥官", "");
        assert!(
            !empty
                .controls
                .iter()
                .find(|c| c.id == "lobby.join")
                .unwrap()
                .enabled
        );
    }
    #[test]
    fn guests_cannot_edit_host_settings_or_start() {
        let state:LobbySnapshot=serde_json::from_value(json!({"room":{"isHost":false,"members":[{"id":"guest","slot":1}],"config":{"players":[{"slot":1,"country":"Yuri"}],"options":{}}}})).unwrap();
        let panel = view(&state, "", "");
        assert!(panel.controls.iter().filter(|c|c.id.starts_with("lobby.settings.")||c.id.starts_with("lobby.player.")).all(|c|!c.enabled));
        assert!(panel.controls.iter().any(|c| c.id == "lobby.ready"));
        assert!(!panel.controls.iter().any(|c| c.id == "lobby.start"));
    }
    #[test]
    fn host_readiness_and_busy_gate_start() {
        for (can_start, busy, enabled) in [
            (true, false, true),
            (false, false, false),
            (true, true, false),
        ] {
            let state: LobbySnapshot = serde_json::from_value(
                json!({"busy":busy,"room":{"isHost":true,"canStart":can_start,"members":[]}}),
            )
            .unwrap();
            assert_eq!(
                view(&state, "", "")
                    .controls
                    .iter()
                    .find(|c| c.id == "lobby.start")
                    .unwrap()
                    .enabled,
                enabled
            );
        }
    }
}
