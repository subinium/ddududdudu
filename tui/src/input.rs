use std::process::ChildStdin;

use anyhow::Result;
use slt::{KeyCode, KeyModifiers, TextInputState};

use crate::app::App;
use crate::ask_user::submit_ask_user;
use crate::bridge::send_command;
use crate::hangul::*;
use crate::protocol::BridgeCommand;

pub(crate) fn handle_input(
    ui: &mut slt::Context,
    app: &mut App,
    stdin: &mut ChildStdin,
) -> Result<()> {
    if ui.key_mod('q', KeyModifiers::CONTROL) || ui.key_mod('c', KeyModifiers::CONTROL) {
        ui.quit();
    }

    if ui.key_mod('l', KeyModifiers::CONTROL) {
        send_command(stdin, BridgeCommand::ClearMessages)?;
        app.auto_scroll = true;
        app.transcript_scroll.offset = usize::MAX;
    }

    if ui.key_mod(' ', KeyModifiers::CONTROL) {
        if app.korean_mode {
            app.korean_mode = false;
            commit_hangul_composition(app);
        } else {
            app.korean_mode = true;
            app.hangul.reset();
            app.hangul_preedit_len = 0;
        }
    }

    if app.korean_mode && app.state.ask_user.is_none() {
        for c in ' '..='~' {
            if ui.key_code(KeyCode::Char(c)) {
                if let Some(jamo) = qwerty_to_jamo(c) {
                    app.hangul.feed_jamo(jamo);
                    flush_hangul_committed(app);
                } else {
                    app.hangul.commit_current();
                    flush_hangul_committed(app);
                    insert_char_at_cursor(&mut app.composer, c);
                }
            }
        }

        if ui.key_code(KeyCode::Backspace) {
            if !app.hangul.backspace() {
                delete_char_before_cursor(&mut app.composer);
            }
        }

        if ui.key_code(KeyCode::Delete) {
            app.hangul.commit_current();
            flush_hangul_committed(app);
            let len = app.composer.value.chars().count();
            if app.composer.cursor < len {
                let start = char_to_byte_index(&app.composer.value, app.composer.cursor);
                let end = char_to_byte_index(&app.composer.value, app.composer.cursor + 1);
                app.composer.value.replace_range(start..end, "");
            }
        }

        if ui.key_code(KeyCode::Left) {
            app.hangul.commit_current();
            flush_hangul_committed(app);
            app.composer.cursor = app.composer.cursor.saturating_sub(1);
        }

        if ui.key_code(KeyCode::Right) {
            app.hangul.commit_current();
            flush_hangul_committed(app);
            app.composer.cursor = (app.composer.cursor + 1).min(app.composer.value.chars().count());
        }

        if ui.key_code(KeyCode::Home) {
            app.hangul.commit_current();
            flush_hangul_committed(app);
            app.composer.cursor = 0;
        }

        if ui.key_code(KeyCode::End) {
            app.hangul.commit_current();
            flush_hangul_committed(app);
            app.composer.cursor = app.composer.value.chars().count();
        }

        if let Some(text) = ui.paste().map(|s| s.to_string()) {
            app.hangul.commit_current();
            flush_hangul_committed(app);
            insert_str_at_cursor(&mut app.composer, &text);
        }
    }

    if ui.key_code(KeyCode::PageUp) {
        app.auto_scroll = false;
        app.transcript_scroll.scroll_up(8);
    }
    if ui.key_code(KeyCode::PageDown) {
        app.transcript_scroll.scroll_down(8);
    }
    if !app.korean_mode && ui.key_code(KeyCode::End) {
        app.auto_scroll = true;
        app.transcript_scroll.offset = usize::MAX;
    }
    if ui.scroll_up() {
        app.auto_scroll = false;
    }

    if ui.key_code(KeyCode::Up)
        && app.state.ask_user.is_none()
        && app.composer.value.is_empty()
        && app.hangul.preedit().is_none()
    {
        if !app.prompt_history.is_empty() {
            if app.history_stash.is_none() {
                app.history_stash = Some(app.composer.value.clone());
            }
            let next = match app.history_index {
                None => app.prompt_history.len().saturating_sub(1),
                Some(index) => index.saturating_sub(1),
            };
            app.history_index = Some(next);
            app.composer.value = app.prompt_history[next].clone();
            app.composer.cursor = app.composer.value.chars().count();
        }
    } else if ui.key_code(KeyCode::Down) && app.state.ask_user.is_none() {
        if let Some(index) = app.history_index {
            if index + 1 < app.prompt_history.len() {
                let next = index + 1;
                app.history_index = Some(next);
                app.composer.value = app.prompt_history[next].clone();
            } else {
                app.history_index = None;
                app.composer.value = app.history_stash.take().unwrap_or_default();
            }
            app.composer.cursor = app.composer.value.chars().count();
        }
    }

    if ui.key_code(KeyCode::Esc) {
        if app.state.loading {
            send_command(stdin, BridgeCommand::Abort)?;
        } else {
            app.composer.value.clear();
            app.composer.cursor = 0;
            app.hangul.reset();
            app.hangul_preedit_len = 0;
            app.history_index = None;
            app.history_stash = None;
        }
    }

    if ui.key_code(KeyCode::Enter) {
        if app.state.ask_user.is_some() {
            submit_ask_user(app, stdin)?;
            return Ok(());
        }

        if app.korean_mode {
            commit_hangul_composition(app);
        }

        let prompt = app.composer.value.trim().to_string();
        if prompt.is_empty() {
            return Ok(());
        }

        if prompt.starts_with('/') {
            send_command(
                stdin,
                BridgeCommand::RunSlash {
                    command: prompt.clone(),
                },
            )?;
        } else {
            send_command(
                stdin,
                BridgeCommand::Submit {
                    content: prompt.clone(),
                },
            )?;
            send_command(
                stdin,
                BridgeCommand::PrefetchContext {
                    content: prompt.clone(),
                },
            )?;
        }
        app.push_prompt_history(&prompt);
        app.composer.value.clear();
        app.composer.cursor = 0;
        app.hangul.reset();
        app.hangul_preedit_len = 0;
        app.history_index = None;
        app.history_stash = None;
        app.auto_scroll = true;
        app.transcript_scroll.offset = usize::MAX;
    }

    Ok(())
}

pub(crate) fn char_to_byte_index(s: &str, char_idx: usize) -> usize {
    s.char_indices()
        .nth(char_idx)
        .map(|(byte_idx, _)| byte_idx)
        .unwrap_or(s.len())
}

pub(crate) fn insert_char_at_cursor(input: &mut TextInputState, ch: char) {
    let byte_pos = char_to_byte_index(&input.value, input.cursor);
    input.value.insert(byte_pos, ch);
    input.cursor += 1;
}

pub(crate) fn insert_str_at_cursor(input: &mut TextInputState, text: &str) {
    if text.is_empty() {
        return;
    }
    let byte_pos = char_to_byte_index(&input.value, input.cursor);
    input.value.insert_str(byte_pos, text);
    input.cursor += text.chars().count();
}

pub(crate) fn delete_char_before_cursor(input: &mut TextInputState) {
    if input.cursor == 0 {
        return;
    }

    let start = char_to_byte_index(&input.value, input.cursor - 1);
    let end = char_to_byte_index(&input.value, input.cursor);
    input.value.replace_range(start..end, "");
    input.cursor -= 1;
}

pub(crate) fn remove_hangul_preedit(app: &mut App) {
    if app.hangul_preedit_len == 0 {
        return;
    }

    let start = char_to_byte_index(&app.composer.value, app.composer.cursor);
    let end = char_to_byte_index(
        &app.composer.value,
        app.composer.cursor + app.hangul_preedit_len,
    );
    if start < end {
        app.composer.value.replace_range(start..end, "");
    }
    app.hangul_preedit_len = 0;
}

pub(crate) fn flush_hangul_committed(app: &mut App) {
    let committed = std::mem::take(&mut app.hangul.committed);
    insert_str_at_cursor(&mut app.composer, &committed);
}

pub(crate) fn commit_hangul_composition(app: &mut App) {
    app.hangul.commit_current();
    flush_hangul_committed(app);
    app.hangul.reset();
    app.hangul_preedit_len = 0;
}
