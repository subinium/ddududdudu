use slt::Style;

use crate::app::App;
use crate::protocol::{NativeMessageState, NativeTuiState};
use crate::theme::{
    ACCENT, ACCENT_DIM, ERROR, MUTED, SPINNER_FRAMES, SPLASH_COMPACT, SPLASH_FULL, SUCCESS,
    THINKING_FRAMES, TOOL_MUTED, USER_FG,
};

use super::utils::{capitalize_tool_name, extract_tool_detail, truncate};

pub(crate) fn render_content(ui: &mut slt::Context, text: &str) {
    let _ = ui.markdown(text);
}

pub(crate) fn render_content_plain(ui: &mut slt::Context, text: &str) {
    ui.text_wrap(text);
}

pub(crate) fn render_transcript(ui: &mut slt::Context, app: &mut App) {
    if app.auto_scroll {
        app.transcript_scroll.offset = usize::MAX;
    }

    let tick = ui.tick();
    let messages = app.state.messages.clone();
    let streaming = app.streaming_message_id.clone();
    let scroll = &mut app.transcript_scroll;
    let msg_count = messages.len();
    let md_threshold = msg_count.saturating_sub(6);

    let _ = ui.scrollable(scroll).grow(1).p(1).col(|ui| {
        if messages.is_empty() {
            render_welcome(ui, &app.state);
            return;
        }

        for (i, msg) in messages.iter().enumerate() {
            let is_streaming_msg =
                msg.is_streaming || streaming.as_deref() == Some(msg.id.as_str());
            let use_markdown = i >= md_threshold && !is_streaming_msg;
            render_message(ui, app, msg, tick, streaming.as_deref(), use_markdown);
        }
    });
}

pub(crate) fn render_message(
    ui: &mut slt::Context,
    app: &mut App,
    msg: &NativeMessageState,
    tick: u64,
    streaming_id: Option<&str>,
    use_markdown: bool,
) {
    let streaming_cursor = (tick / 30).is_multiple_of(2);
    match msg.role.as_str() {
        "user" => {
            let _ = ui.container().pb(1).col(|ui| {
                ui.styled("❯", Style::new().fg(ACCENT).bold());
                ui.text_wrap(&msg.content).bold().fg(USER_FG);
            });
        }
        "assistant" => {
            let _ = ui.container().pb(1).col(|ui| {
                ui.styled("▌ assistant", Style::new().fg(ACCENT).bold());
                let is_streaming_msg = msg.is_streaming || streaming_id == Some(msg.id.as_str());
                if is_streaming_msg {
                    if let Some(markdown) = app.streaming_markdown.get_mut(&msg.id) {
                        let _ = ui.streaming_markdown(markdown);
                    } else {
                        render_content_plain(ui, &msg.content);
                    }
                } else if use_markdown {
                    render_content(ui, &msg.content);
                } else {
                    render_content_plain(ui, &msg.content);
                }

                for tool in &msg.tool_calls {
                    let icon = match tool.status.as_str() {
                        "ok" | "done" | "success" => "✓",
                        "error" | "failed" => "✗",
                        _ => SPINNER_FRAMES[((tick / 6) as usize) % SPINNER_FRAMES.len()],
                    };
                    let color = match tool.status.as_str() {
                        "ok" | "done" | "success" => SUCCESS,
                        "error" | "failed" => ERROR,
                        _ => TOOL_MUTED,
                    };
                    let tool_display = capitalize_tool_name(&tool.name);
                    let detail = extract_tool_detail(&tool.summary);
                    let label = if detail.is_empty() {
                        tool_display
                    } else {
                        format!("{} {}", tool_display, detail)
                    };
                    ui.styled(
                        truncate(&format!("  {} {}", icon, label), 70),
                        Style::new().fg(color).dim(),
                    );
                }

                if msg.is_thinking.unwrap_or(false) {
                    let symbol = THINKING_FRAMES[((tick / 6) as usize) % THINKING_FRAMES.len()];
                    if let Some(thinking) = &msg.thinking {
                        let preview =
                            truncate(thinking.lines().last().unwrap_or("thinking..."), 60);
                        ui.styled(
                            format!("{} {}", symbol, preview),
                            Style::new().fg(ACCENT_DIM).italic(),
                        );
                    } else {
                        ui.styled(
                            format!("{} thinking...", symbol),
                            Style::new().fg(ACCENT_DIM).italic(),
                        );
                    }
                }

                if (msg.is_streaming || streaming_id == Some(msg.id.as_str())) && streaming_cursor {
                    ui.styled("▌", Style::new().fg(ACCENT));
                }
            });
        }
        _ => {
            let _ = ui.container().pb(1).col(|ui| {
                ui.text_wrap(format!("⚙ {}", msg.content)).fg(MUTED).dim();
            });
        }
    }
}

pub(crate) fn render_welcome(ui: &mut slt::Context, state: &NativeTuiState) {
    ui.spacer();
    let term_w = ui.width() as usize;
    let sidebar_w = if term_w >= 124 {
        44
    } else if term_w >= 104 {
        40
    } else if term_w >= 88 {
        34
    } else {
        0
    };
    let avail = term_w.saturating_sub(sidebar_w + 4);
    let splash = if avail >= 102 {
        SPLASH_FULL
    } else if avail >= 52 {
        SPLASH_COMPACT
    } else {
        &[]
    };
    let splash_w = splash.iter().map(|l| l.len()).max().unwrap_or(0);
    let pad = if splash_w > 0 {
        avail.saturating_sub(splash_w) / 2
    } else {
        0
    };
    let prefix: String = " ".repeat(pad);

    if !splash.is_empty() {
        for line in splash {
            ui.styled(format!("{}{}", prefix, line), Style::new().fg(ACCENT_DIM));
        }
        ui.text("");
    }

    let ver = format!("ddudu v{}", state.version);
    let ver_pad = " ".repeat(avail.saturating_sub(ver.len()) / 2);
    ui.styled(
        format!("{}{}", ver_pad, ver),
        Style::new().fg(ACCENT).bold(),
    );

    if let Some(cwd) = state.cwd.rsplit('/').next() {
        let cwd_str = format!("📁 {}", cwd);
        let cwd_pad = " ".repeat(avail.saturating_sub(cwd_str.chars().count()) / 2);
        ui.styled(
            format!("{}{}", cwd_pad, cwd_str),
            Style::new().fg(MUTED).dim(),
        );
    }
    ui.spacer();
}
