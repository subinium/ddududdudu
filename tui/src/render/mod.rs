use slt::{Border, Style};

use crate::app::App;
use crate::theme::{ACCENT_DIM, BG, SIDEBAR_BG};

pub mod composer;
pub mod modals;
pub mod sidebar;
pub mod status;
pub mod transcript;
pub mod utils;

use composer::render_composer;
use modals::{render_ask_user, render_fatal_error};
use sidebar::render_sidebar;
use status::render_status_line;
use transcript::render_transcript;

pub(crate) fn render_app(ui: &mut slt::Context, app: &mut App) {
    let show_sidebar = ui.width() >= 88;
    let sidebar_width = if ui.width() >= 124 {
        44
    } else if ui.width() >= 104 {
        40
    } else {
        34
    };

    let _ = ui.container().bg(BG).w_pct(100).h_pct(100).row(|ui| {
        let _ = ui.container().grow(1).bg(BG).col(|ui| {
            ui.error_boundary(|ui| {
                render_transcript(ui, app);
            });
            render_status_line(ui, app);
            render_composer(ui, app);
        });

        if show_sidebar {
            let _ = ui
                .container()
                .w(sidebar_width)
                .bg(SIDEBAR_BG)
                .border(Border::Single)
                .border_left(true)
                .border_top(false)
                .border_bottom(false)
                .border_right(false)
                .border_style(Style::new().fg(ACCENT_DIM))
                .col(|ui| {
                    render_sidebar(ui, app, (sidebar_width as usize).saturating_sub(4));
                });
        }
    });

    if app.state.ask_user.is_some() {
        render_ask_user(ui, app);
    }
    if app.fatal_error.is_some() {
        render_fatal_error(ui, app);
    }
    ui.toast(&mut app.toast);
}
