use slt::Color;

use crate::protocol::NativeTuiState;

pub(crate) const BG: Color = Color::Rgb(0, 0, 0);
pub(crate) const SIDEBAR_BG: Color = Color::Rgb(15, 15, 15);
pub(crate) const COMPOSER_BG: Color = Color::Rgb(10, 10, 10);
pub(crate) const FG: Color = Color::Rgb(230, 230, 230);
pub(crate) const USER_FG: Color = Color::Rgb(255, 255, 255);
pub(crate) const ACCENT: Color = Color::Rgb(247, 167, 187);
pub(crate) const ACCENT_DIM: Color = Color::Rgb(160, 110, 125);
pub(crate) const SUCCESS: Color = Color::Rgb(120, 200, 140);
pub(crate) const ERROR: Color = Color::Rgb(255, 55, 55);
pub(crate) const MUTED: Color = Color::Rgb(80, 80, 80);
pub(crate) const TOOL_MUTED: Color = Color::Rgb(60, 60, 60);
pub(crate) const ORANGE: Color = Color::Rgb(230, 160, 90);
pub(crate) const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
pub(crate) const CONTEXT_BARS: [&str; 11] = [
    "░░░░░░░░░░",
    "█░░░░░░░░░",
    "██░░░░░░░░",
    "███░░░░░░░",
    "████░░░░░░",
    "█████░░░░░",
    "██████░░░░",
    "███████░░░",
    "████████░░",
    "█████████░",
    "██████████",
];
pub(crate) const THINKING_FRAMES: &[&str] = &["◉", "◎", "○", "◎"];
pub(crate) const SPLASH_FULL: &[&str] = &[
    "      d8b       d8b                d8b                    d8b       d8b                d8b",
    "      88P       88P                88P                    88P       88P                88P",
    "     d88       d88                d88                    d88       d88                d88",
    " d888888   d888888  ?88   d8P d888888  ?88   d8P     d888888   d888888  ?88   d8P d888888  ?88   d8P",
    "d8P' ?88  d8P' ?88  d88   88 d8P' ?88  d88   88     d8P' ?88  d8P' ?88  d88   88 d8P' ?88  d88   88",
    "88b  ,88b 88b  ,88b ?8(  d88 88b  ,88b ?8(  d88     88b  ,88b 88b  ,88b ?8(  d88 88b  ,88b ?8(  d88",
    "`?88P'`88b`?88P'`88b`?88P'?8b`?88P'`88b`?88P'?8b    `?88P'`88b`?88P'`88b`?88P'?8b`?88P'`88b`?88P'?8b",
];
pub(crate) const SPLASH_COMPACT: &[&str] = &[
    "      d8b       d8b                d8b",
    "      88P       88P                88P",
    "     d88       d88                d88",
    " d888888   d888888  ?88   d8P d888888  ?88   d8P",
    "d8P' ?88  d8P' ?88  d88   88 d8P' ?88  d88   88",
    "88b  ,88b 88b  ,88b ?8(  d88 88b  ,88b ?8(  d88",
    "`?88P'`88b`?88P'`88b`?88P'?8b`?88P'`88b`?88P'?8b",
];

pub(crate) fn current_mode_label(state: &NativeTuiState) -> String {
    state
        .modes
        .iter()
        .find(|mode| mode.active)
        .map(|mode| mode.label.clone())
        .unwrap_or_else(|| state.mode.to_uppercase())
}

pub(crate) fn ddudu_theme() -> slt::Theme {
    slt::Theme {
        primary: Color::Rgb(247, 167, 187),
        secondary: Color::Rgb(160, 110, 125),
        accent: Color::Rgb(247, 167, 187),
        text: Color::Rgb(230, 230, 230),
        text_dim: Color::Rgb(80, 80, 80),
        border: Color::Rgb(40, 40, 40),
        bg: Color::Rgb(0, 0, 0),
        success: Color::Rgb(46, 204, 64),
        warning: Color::Rgb(255, 165, 80),
        error: Color::Rgb(255, 55, 55),
        selected_bg: Color::Rgb(247, 167, 187),
        selected_fg: Color::Rgb(0, 0, 0),
        surface: Color::Rgb(15, 15, 15),
        surface_hover: Color::Rgb(25, 25, 25),
        surface_text: Color::Rgb(230, 230, 230),
        is_dark: true,
    }
}
