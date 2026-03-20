use slt::Color;

use crate::theme::{ACCENT_DIM, ERROR, ORANGE};

pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{truncated}…")
}

pub(crate) fn capitalize_tool_name(name: &str) -> String {
    let base = name.trim_end_matches("_tool").trim_end_matches("Tool");
    let mut chars = base.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

pub(crate) fn extract_tool_detail(summary: &str) -> String {
    let s = summary.trim();
    if s.is_empty() {
        return String::new();
    }
    let mut parts = Vec::new();
    for word in s.split_whitespace() {
        if word.contains('/') || (word.contains('.') && word.len() > 2) {
            let path = word.trim_matches(|c: char| {
                !c.is_alphanumeric() && c != '/' && c != '.' && c != '_' && c != '-'
            });
            if let Some(fname) = path.rsplit('/').next() {
                if !fname.is_empty() {
                    parts.push(fname.to_string());
                    break;
                }
            }
        }
    }
    if parts.is_empty() {
        truncate(s, 50).to_string()
    } else {
        parts.join(" ")
    }
}

pub(crate) fn context_bar_color(pct: f64) -> Color {
    if pct < 60.0 {
        ACCENT_DIM
    } else if pct < 80.0 {
        ORANGE
    } else {
        ERROR
    }
}

pub(crate) fn format_tokens_short(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{}M", n / 1_000_000)
    } else if n >= 1_000 {
        format!("{}k", n / 1_000)
    } else {
        format!("{}", n)
    }
}

pub(crate) fn shorten_model(model: &str) -> &str {
    model
        .rsplit_once('/')
        .map(|(_, s)| s)
        .or_else(|| model.rsplit_once(':').map(|(_, s)| s))
        .unwrap_or(model)
}
