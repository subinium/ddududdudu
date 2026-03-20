use slt::Style;

use crate::app::App;
use crate::theme::{ACCENT, ERROR, FG, MUTED, ORANGE, SPINNER_FRAMES, SUCCESS};

use super::utils::{context_bar_color, format_tokens_short, truncate};

pub(crate) fn render_sidebar(ui: &mut slt::Context, app: &mut App, max_width: usize) {
    let sidebar_max = max_width.max(16);
    let pct = app.state.context_percent.clamp(0.0, 100.0);
    let bar_w = sidebar_max.saturating_sub(8);
    let filled = ((pct / 100.0) * bar_w as f64) as usize;
    let bar_color = context_bar_color(pct);

    let scroll = &mut app.sidebar_scroll;
    let _ = ui.scrollable(scroll).p(1).col(|ui| {
        ui.styled("• CONTEXT", Style::new().fg(ACCENT).bold());
        let bar: String = "█".repeat(filled) + &"░".repeat(bar_w.saturating_sub(filled));
        ui.styled(format!("  {} {:.0}%", bar, pct), Style::new().fg(bar_color));
        ui.styled(
            truncate(
                &format!(
                    "  {} / {} tokens",
                    format_tokens_short(app.state.context_tokens),
                    format_tokens_short(app.state.context_limit)
                ),
                sidebar_max,
            ),
            Style::new().fg(MUTED),
        );
        if let Some(est) = &app.state.request_estimate {
            ui.styled(
                truncate(
                    &format!(
                        "  sys:{}  hist:{}  tools:{}",
                        format_tokens_short(est.system),
                        format_tokens_short(est.history),
                        format_tokens_short(est.tools)
                    ),
                    sidebar_max,
                ),
                Style::new().fg(MUTED).dim(),
            );
        }
        ui.text("");

        if let Some(git_state) = &app.state.git {
            if !git_state.changed_files.is_empty() {
                ui.styled(
                    format!("• FILES ({})", git_state.changed_files.len()),
                    Style::new().fg(ACCENT).bold(),
                );
                for file in git_state.changed_files.iter().take(8) {
                    ui.styled(
                        truncate(&format!("  │ {}", file), sidebar_max),
                        Style::new().fg(FG),
                    );
                }
                let remaining = git_state.changed_files.len().saturating_sub(8);
                if remaining > 0 {
                    ui.styled(
                        format!("  │ +{} more", remaining),
                        Style::new().fg(MUTED).dim(),
                    );
                }
                ui.text("");
            }
        }

        if !app.state.todos.is_empty() {
            ui.styled("• PLAN", Style::new().fg(ACCENT).bold());
            for item in app.state.todos.iter().take(8) {
                let icon = match item.status.as_str() {
                    "completed" | "done" => "✓",
                    "in_progress" => "▸",
                    "cancelled" => "×",
                    _ => "·",
                };
                ui.styled(
                    truncate(&format!("  │ {} {}", icon, item.step), sidebar_max),
                    Style::new().fg(FG),
                );
            }
            ui.text("");
        }

        let has_agents =
            !app.state.agent_activities.is_empty() || !app.state.background_jobs.is_empty();
        if has_agents {
            ui.styled("• AGENTS", Style::new().fg(ACCENT).bold());
            let tick = ui.tick();
            for agent in app.state.agent_activities.iter().take(4) {
                let icon = match agent.status.as_str() {
                    "done" | "completed" => "✓",
                    "running" => SPINNER_FRAMES[((tick / 6) as usize) % SPINNER_FRAMES.len()],
                    "error" | "failed" => "✗",
                    _ => "·",
                };
                ui.styled(
                    truncate(&format!("  │ {} {}", icon, agent.label), sidebar_max),
                    Style::new().fg(FG),
                );
            }
            for job in app.state.background_jobs.iter().take(4) {
                let icon = match job.status.as_str() {
                    "done" => "✓",
                    "error" => "✗",
                    "cancelled" => "•",
                    _ => SPINNER_FRAMES[((tick / 6) as usize) % SPINNER_FRAMES.len()],
                };
                ui.styled(
                    truncate(
                        &format!("  │ {} [{}] {}", icon, job.kind, job.label),
                        sidebar_max,
                    ),
                    Style::new().fg(FG),
                );
            }
            ui.text("");
        }

        ui.styled("• SYSTEMS", Style::new().fg(ACCENT).bold());
        for provider in &app.state.providers {
            let icon = if provider.available { "●" } else { "○" };
            let color = if provider.available { SUCCESS } else { MUTED };
            ui.styled(
                truncate(&format!("  │ {} {}", icon, provider.name), sidebar_max),
                Style::new().fg(color),
            );
        }
        let mut sys_parts: Vec<String> = Vec::new();
        if let Some(mcp_state) = &app.state.mcp {
            sys_parts.push(format!(
                "mcp {}/{}",
                mcp_state.connected_servers, mcp_state.configured_servers
            ));
        }
        if let Some(lsp_state) = &app.state.lsp {
            sys_parts.push(format!(
                "lsp {}/{}",
                lsp_state.connected_servers, lsp_state.available_servers
            ));
        }
        if !sys_parts.is_empty() {
            ui.styled(
                truncate(&format!("  │ {}", sys_parts.join(" · ")), sidebar_max),
                Style::new().fg(FG),
            );
        }
        if let Some(v) = &app.state.verification {
            let (color, icon) = match v.status.as_str() {
                "passed" => (SUCCESS, "✓"),
                "failed" => (ERROR, "✗"),
                _ => (ORANGE, "⠋"),
            };
            ui.styled(
                truncate(&format!("  │ verify: {} {}", v.status, icon), sidebar_max),
                Style::new().fg(color),
            );
        }

        if let Some(strategy) = &app.state.team_run_strategy {
            ui.text("");
            ui.styled("• TEAM", Style::new().fg(ACCENT).bold());
            ui.styled(
                truncate(&format!("  │ {}", strategy), sidebar_max),
                Style::new().fg(FG),
            );
            if let Some(task) = &app.state.team_run_task {
                ui.styled(
                    truncate(&format!("  │ {}", task), sidebar_max),
                    Style::new().fg(MUTED),
                );
            }
        }

        ui.text("");
        ui.styled(
            format!("  v{}", app.state.version),
            Style::new().fg(MUTED).dim(),
        );
    });
}
