//! Native resource-management view over browser-owned content receipts.
//!
//! Actions are intents only. The content host owns dependency resolution,
//! download cancellation, cache verification, and the final activation gate.

use serde_json::json;

use super::model::{ContentItem, ContentJob, ContentSnapshot};
use super::{Control, Label, Panel, ProgressBar, RectPx};

fn size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

fn title(item: &ContentItem) -> &str {
    if !item.title.is_empty() {
        return &item.title;
    }
    match item.id.as_str() {
        "skirmish" => "默认遭遇战",
        "full" => "完整内容",
        "campaign" => "战役资源",
        "cinematics" => "过场影片",
        "music" => "原版音乐",
        "brandingAnimation" => "菜单动画",
        _ => &item.id,
    }
}

fn progress(job: &ContentJob) -> f32 {
    if job.total_files == 0 {
        return 0.0;
    }
    // Completed files include cache hits. Wire progress is only the current
    // unfinished file, capped below one until its SHA verification finishes.
    let partial = if job.stage != "complete" && job.wire_total_bytes > 0 {
        (job.wire_bytes as f64 / job.wire_total_bytes as f64).clamp(0.0, 0.98)
    } else {
        0.0
    };
    ((f64::from(job.completed_files) + partial) / f64::from(job.total_files)).clamp(0.0, 1.0) as f32
}

pub(super) fn view(snapshot: &ContentSnapshot) -> Panel {
    let busy = snapshot.downloading || snapshot.activating || snapshot.job.is_some();
    let mut panel = Panel {
        title: "资源管理".to_owned(),
        subtitle: "默认遭遇战 · 可选完整内容 · 下载校验后启用".to_owned(),
        controls: Vec::new(),
        labels: vec![
            Label::new("游戏内容", RectPx::new(28, 100, 344, 24)),
            Label::new("可选资源包", RectPx::new(400, 100, 372, 24)),
        ],
        bars: Vec::new(),
    };

    for (index, item) in snapshot.profiles.iter().take(2).enumerate() {
        let y = 132 + index as i32 * 132;
        panel.controls.push(Control::check(
            format!("content.profile.{}", item.id),
            title(item),
            RectPx::new(28, y, 344, 28),
            !busy && !item.id.is_empty(),
            item.checked || snapshot.profile == item.id,
            json!({"action": "selectProfile", "profile": item.id}),
        ));
        panel.labels.push(Label::new(
            item.description.clone(),
            RectPx::new(44, y + 32, 320, 36),
        ));
        panel.labels.push(Label::new(
            format!("下载 {} · 原始 {}", size(item.bytes), size(item.raw_bytes)),
            RectPx::new(44, y + 72, 320, 20),
        ));
        panel.labels.push(Label::new(
            item.cached.clone(),
            RectPx::new(44, y + 96, 198, 24),
        ));
        panel.controls.push(Control::button(
            format!("content.download.profile.{}", item.id),
            "下载／校验",
            RectPx::new(248, y + 94, 116, 28),
            !busy && !item.id.is_empty() && item.raw_bytes > 0,
            json!({"action": "download", "id": format!("profile:{}", item.id)}),
        ));
    }

    for (index, item) in snapshot.packs.iter().take(4).enumerate() {
        let y = 132 + index as i32 * 68;
        panel.controls.push(Control::check(
            format!("content.pack.{}", item.id),
            title(item),
            RectPx::new(400, y, 242, 28),
            !busy && !item.included && !item.id.is_empty(),
            item.included || item.checked || snapshot.addons.contains(&item.id),
            json!({"action": "selectPack", "id": item.id, "checked": !(item.included || item.checked || snapshot.addons.contains(&item.id))}),
        ));
        panel.controls.push(Control::button(
            format!("content.download.pack.{}", item.id),
            "下载／校验",
            RectPx::new(652, y, 120, 28),
            !busy && !item.id.is_empty() && item.raw_bytes > 0,
            json!({"action": "download", "id": item.id}),
        ));
        panel.labels.push(Label::new(
            item.description.clone(),
            RectPx::new(400, y + 30, 372, 20),
        ));
        panel.labels.push(Label::new(
            format!("下载 {} · 原始 {}", size(item.bytes), size(item.raw_bytes)),
            RectPx::new(400, y + 50, 220, 18),
        ));
        panel.labels.push(Label::new(
            if item.included {
                "方案已包含".to_owned()
            } else {
                item.cached.clone()
            },
            RectPx::new(624, y + 50, 148, 18),
        ));
    }

    panel.labels.push(Label::new(
        format!(
            "所选 {} 个文件 · 下载 {} · 原始 {}",
            snapshot.selection.files,
            size(snapshot.selection.bytes),
            size(snapshot.selection.raw_bytes)
        ),
        RectPx::new(28, 414, 744, 24),
    ));
    if let Some(job) = snapshot.job.as_ref() {
        let file = if job.file.is_empty() {
            "正在检查缓存…"
        } else {
            &job.file
        };
        panel.labels.push(Label::new(
            format!("{} · {file}", job.title),
            RectPx::new(28, 442, 744, 20),
        ));
        panel.bars.push(ProgressBar {
            rect: RectPx::new(28, 466, 744, 8),
            fraction: progress(job),
        });
        panel.labels.push(Label::new(
            format!(
                "已完成 {}/{} · 当前 {} / {} · 总传输 {} / {}{}",
                job.completed_files,
                job.total_files,
                size(job.wire_bytes),
                size(job.wire_total_bytes),
                size(job.transferred_wire_bytes),
                size(job.total_wire_bytes),
                if job.stage == "verify" {
                    " · 正在校验"
                } else {
                    ""
                }
            ),
            RectPx::new(28, 480, 744, 20),
        ));
    } else {
        panel.labels.push(Label::new(
            "缓存命中会跳过下载；可选内容在重新载入后启用。",
            RectPx::new(28, 442, 744, 22),
        ));
        if !snapshot.activation_allowed {
            panel.labels.push(Label::new(
                "对局或载入期间可以下载，返回主菜单后才能启用。",
                RectPx::new(28, 470, 744, 22),
            ));
        }
    }
    if !snapshot.message.is_empty() || snapshot.error {
        let message = if snapshot.error {
            format!(
                "错误：{}",
                if snapshot.message.is_empty() {
                    "资源处理失败，请重试。"
                } else {
                    &snapshot.message
                }
            )
        } else {
            snapshot.message.clone()
        };
        panel
            .labels
            .push(Label::new(message, RectPx::new(28, 506, 744, 30)));
    }

    panel.controls.extend([
        Control::button(
            "content.download.selection",
            "下载并校验所选",
            RectPx::new(28, 548, 176, 34),
            !busy && snapshot.selection.files > 0,
            json!({"action": "download", "id": "selection"}),
        ),
        Control::button(
            "content.activate",
            "启用并重新载入",
            RectPx::new(216, 548, 208, 34),
            !busy
                && snapshot.activation_allowed
                && snapshot.can_activate
                && snapshot.selection.files > 0,
            json!({"action": "activate"}),
        ),
        Control::button(
            "content.cancel",
            "取消下载",
            RectPx::new(436, 548, 136, 34),
            snapshot.downloading || snapshot.job.is_some(),
            json!({"action": "cancel"}),
        ),
        Control::button(
            "content.close",
            "返回",
            RectPx::new(668, 548, 104, 34),
            true,
            json!({"action": "close"}),
        ),
    ]);
    panel
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> ContentSnapshot {
        serde_json::from_value(json!({
            "profile": "skirmish", "activationAllowed": true, "canActivate": true,
            "profiles": [{"id": "skirmish", "rawBytes": 2048}, {"id": "full", "rawBytes": 4096}],
            "packs": [{"id": "campaign", "rawBytes": 1024}, {"id": "music", "included": true, "rawBytes": 2048}],
            "selection": {"files": 2, "bytes": 1024, "rawBytes": 2048}
        }))
        .unwrap()
    }

    fn control<'a>(panel: &'a Panel, id: &str) -> &'a Control {
        panel.controls.iter().find(|item| item.id == id).unwrap()
    }

    #[test]
    fn downloads_disable_mutation_and_activation_but_keep_cancel_and_return() {
        let mut state = snapshot();
        state.downloading = true;
        let panel = view(&state);
        for item in &panel.controls {
            assert_eq!(
                item.enabled,
                matches!(item.id.as_str(), "content.cancel" | "content.close"),
                "{}",
                item.id
            );
        }
        state.downloading = false;
        state.job = Some(ContentJob::default());
        assert!(!control(&view(&state), "content.activate").enabled);
    }

    #[test]
    fn activation_requires_verified_selection_and_an_allowed_native_lifecycle() {
        let mut state = snapshot();
        assert!(control(&view(&state), "content.activate").enabled);
        state.activation_allowed = false;
        assert!(!control(&view(&state), "content.activate").enabled);
        state.activation_allowed = true;
        state.can_activate = false;
        assert!(!control(&view(&state), "content.activate").enabled);
        state.can_activate = true;
        state.selection.files = 0;
        assert!(!control(&view(&state), "content.activate").enabled);
        assert!(!control(&view(&state), "content.download.selection").enabled);
    }

    #[test]
    fn view_intents_preserve_dependency_ownership_and_stay_inside_logical_screen() {
        let panel = view(&snapshot());
        assert!(!control(&panel, "content.pack.music").enabled);
        assert_eq!(
            control(&panel, "content.pack.campaign").action,
            json!({"action":"selectPack","id":"campaign","checked":true})
        );
        assert_eq!(
            control(&panel, "content.download.profile.full").action,
            json!({"action":"download","id":"profile:full"})
        );
        for item in &panel.controls {
            assert!(item.rect.x >= 0 && item.rect.y >= 0);
            assert!(item.rect.x + item.rect.w <= 800 && item.rect.y + item.rect.h <= 600);
            assert!(item.action.get("surface").is_none());
        }
    }

    #[test]
    fn progress_distinguishes_wire_completion_from_verified_files_and_cache_hits() {
        let mut job = ContentJob {
            total_files: 2,
            completed_files: 1,
            wire_bytes: 100,
            wire_total_bytes: 100,
            ..ContentJob::default()
        };
        assert!((progress(&job) - 0.99).abs() < 0.0001);
        job.stage = "complete".to_owned();
        assert_eq!(progress(&job), 0.5);
        job.completed_files = 2;
        assert_eq!(progress(&job), 1.0);
        job.completed_files = u32::MAX;
        assert_eq!(progress(&job), 1.0);
        job.total_files = 0;
        assert_eq!(progress(&job), 0.0);
    }
}
