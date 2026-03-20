use std::time::{SystemTime, UNIX_EPOCH};

use slt::Style;

use crate::app::App;
use crate::theme::{ACCENT, ACCENT_DIM, BG, CONTEXT_BARS, ERROR, FG, MUTED, ORANGE};

use super::utils::{context_bar_color, shorten_model, truncate};

pub(crate) fn render_status_line(ui: &mut slt::Context, app: &mut App) {
    let state = &app.state;
    let mode = crate::theme::current_mode_label(state);
    let pct = state.context_percent.clamp(0.0, 100.0);
    let bar_color = context_bar_color(pct);

    let _ = ui.container().h(1).px(1).bg(BG).row(|ui| {
        let mode_resp = ui.container().row(|ui| {
            ui.styled(mode, Style::new().fg(ACCENT).bold());
        });
        if mode_resp.clicked {
            app.pending_cycle_mode = true;
        }
        ui.styled(" · ", Style::new().fg(MUTED));
        let model_resp = ui.container().row(|ui| {
            ui.styled(shorten_model(&state.model), Style::new().fg(ACCENT_DIM));
        });
        if model_resp.clicked {
            app.pending_cycle_mode = true;
        }

        if let Some(est) = &state.request_estimate {
            let cost = est.total as f64 / 1_000_000.0 * 15.0;
            ui.styled(" · ", Style::new().fg(MUTED));
            ui.styled(format!("${:.2}", cost), Style::new().fg(ACCENT_DIM));
        }

        ui.styled(" · ", Style::new().fg(MUTED));
        let filled = (pct / 10.0) as usize;
        ui.styled(CONTEXT_BARS[filled.min(10)], Style::new().fg(bar_color));
        ui.styled(format!("{:.0}%", pct), Style::new().fg(bar_color));

        if let Some(git_state) = &state.git {
            if let Some(branch) = &git_state.branch {
                ui.styled(" · ", Style::new().fg(MUTED));
                ui.styled(format!("⎇{}", branch), Style::new().fg(FG));
                if git_state.has_uncommitted {
                    ui.styled("●", Style::new().fg(ORANGE));
                }
            }
        }

        ui.spacer();

        if state.playing_with_fire {
            ui.text("🔥").fg(ERROR);
        } else {
            ui.styled(
                truncate(&state.permission_profile, 12),
                Style::new().fg(MUTED),
            );
        }
        if state.loading {
            ui.styled(" ", Style::new());
            ui.spinner(&app.spinner).fg(ACCENT);
            let mut label = String::new();
            if let Some(since) = state.loading_since {
                let now_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let elapsed_s = now_ms.saturating_sub(since) / 1000;
                if elapsed_s >= 2 {
                    label.push_str(&format!(" {}s", elapsed_s));
                }
            }
            if !state.loading_label.trim().is_empty() {
                label.push_str(&format!(" {}", state.loading_label.trim()));
            }
            if !label.is_empty() {
                ui.styled(label, Style::new().fg(ACCENT_DIM).italic());
            }
        }
    });
}
