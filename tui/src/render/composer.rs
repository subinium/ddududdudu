use slt::Style;

use crate::app::App;
use crate::input::remove_hangul_preedit;
use crate::theme::{ACCENT, ACCENT_DIM, BG, COMPOSER_BG, FG, MUTED};

pub(crate) fn render_composer(ui: &mut slt::Context, app: &mut App) {
    let _ = ui.container().bg(COMPOSER_BG).px(1).pt(1).col(|ui| {
        if app.korean_mode {
            let focused = ui.register_focusable();

            let value = &app.composer.value;
            let cursor_pos = app.composer.cursor;

            if value.is_empty() && app.hangul.preedit().is_none() {
                if focused {
                    ui.styled("▎", Style::new().fg(ACCENT_DIM));
                } else {
                    ui.styled(" ", Style::new());
                }
            } else {
                let before: String = value.chars().take(cursor_pos).collect();
                let after: String = value.chars().skip(cursor_pos).collect();
                ui.line_wrap(|ui| {
                    if !before.is_empty() {
                        ui.styled(before, Style::new().fg(FG));
                    }
                    if let Some(p) = app.hangul.preedit() {
                        ui.styled(p.to_string(), Style::new().fg(BG).bg(ACCENT));
                        ui.styled("▎", Style::new().fg(COMPOSER_BG));
                    } else if focused {
                        ui.styled("▎", Style::new().fg(ACCENT_DIM));
                    }
                    if !after.is_empty() {
                        ui.styled(after, Style::new().fg(FG));
                    }
                });
            }
        } else {
            if app.hangul_preedit_len > 0 {
                remove_hangul_preedit(app);
            }
            let _ = ui.text_input(&mut app.composer);
        }

        if !app.state.queued_prompts.is_empty() {
            let preview = app
                .state
                .queued_prompts
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join(" · ");
            ui.styled(format!("queue: {preview}"), Style::new().fg(MUTED).dim());
        }
        let hint = if ui.width() >= 80 {
            if app.korean_mode {
                "[한] Enter submit | Esc abort/clear | Ctrl+Space EN | Shift+Tab mode | Ctrl+L clear"
            } else {
                "Enter submit | Esc abort/clear | Ctrl+Space 한 | Shift+Tab mode | Ctrl+L clear"
            }
        } else if app.korean_mode {
            "[한] Enter ⏎ | Esc ✕ | Ctrl+Space EN"
        } else {
            "Enter ⏎ | Esc ✕ | Ctrl+Space 한"
        };
        ui.styled(hint, Style::new().fg(MUTED));
    });
}
