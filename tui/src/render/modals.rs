use slt::{Border, Style};

use crate::app::{sync_ask_user_radio, App};
use crate::theme::{ACCENT, ACCENT_DIM, BG, ERROR, FG, MUTED};

pub(crate) fn render_ask_user(ui: &mut slt::Context, app: &mut App) {
    let Some(prompt) = app.state.ask_user.as_ref() else {
        return;
    };

    let _ = ui.modal(|ui| {
        let _ = ui
            .container()
            .w_pct(75)
            .max_w(100)
            .bg(BG)
            .border(Border::Single)
            .p(1)
            .center()
            .col(|ui| {
                let title = match prompt.kind.as_str() {
                    "choice" | "select" => "Choose an Option",
                    "number" => "Enter a Number",
                    "confirm" => "Confirm",
                    _ => "Answer Required",
                };
                ui.styled(title, Style::new().fg(ACCENT).bold());
                ui.text_wrap(prompt.question.clone());
                if let Some(detail) = &prompt.detail {
                    ui.text_wrap(detail.clone()).fg(MUTED).dim();
                }

                if !prompt.options.is_empty() {
                    sync_ask_user_radio(&app.state.ask_user, &mut app.ask_user_radio);
                    let _ = ui.radio(&mut app.ask_user_radio);
                }

                if prompt.allow_custom_answer {
                    ui.styled("Custom answer", Style::new().fg(ACCENT_DIM));
                    let _ = ui.text_input(&mut app.ask_user_input);
                }

                let label = prompt
                    .submit_label
                    .clone()
                    .unwrap_or_else(|| "Submit".to_string());
                ui.styled(
                    format!("Press Enter to {label}, Esc to cancel"),
                    Style::new().fg(MUTED).italic(),
                );
            });
    });
}

pub(crate) fn render_fatal_error(ui: &mut slt::Context, app: &App) {
    let Some(message) = app.fatal_error.as_ref() else {
        return;
    };
    let _ = ui.modal(|ui| {
        let _ = ui
            .container()
            .w_pct(70)
            .max_w(90)
            .bg(BG)
            .border(Border::Single)
            .border_style(Style::new().fg(ERROR))
            .p(1)
            .center()
            .col(|ui| {
                ui.styled("⚠ Bridge Error", Style::new().fg(ERROR).bold());
                ui.text("");
                ui.text_wrap(message.clone()).fg(FG);
                ui.text("");
                ui.styled("Press Ctrl+C to exit", Style::new().fg(MUTED).italic());
            });
    });
}
