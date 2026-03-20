use std::process::ChildStdin;

use anyhow::Result;
use regex::Regex;

use crate::app::App;
use crate::bridge::send_command;
use crate::protocol::*;

pub(crate) fn submit_ask_user(app: &mut App, stdin: &mut ChildStdin) -> Result<()> {
    let Some(prompt) = app.state.ask_user.as_ref() else {
        return Ok(());
    };

    if !prompt.options.is_empty() {
        if let Some(index) = prompt.default_option_index {
            if app.ask_user_radio.items.len() == prompt.options.len() {
                app.ask_user_radio.selected = app
                    .ask_user_radio
                    .selected
                    .min(prompt.options.len().saturating_sub(1));
            } else {
                app.ask_user_radio.selected = index.min(prompt.options.len().saturating_sub(1));
            }
        }
    }

    if prompt.allow_custom_answer {
        let value = app.ask_user_input.value.trim().to_string();
        if let Some(error) = validate_ask_user_input(prompt, &value) {
            app.toast.warning(error, 0);
            return Ok(());
        }

        if !value.is_empty() {
            send_command(
                stdin,
                BridgeCommand::AnswerAskUser {
                    answer: AskUserAnswerPayload {
                        value,
                        source: "custom".to_string(),
                        option_index: None,
                        option_label: None,
                    },
                },
            )?;
            return Ok(());
        }
    }

    if !prompt.options.is_empty() {
        let index = app
            .ask_user_radio
            .selected
            .min(prompt.options.len().saturating_sub(1));
        let choice = &prompt.options[index];
        send_command(
            stdin,
            BridgeCommand::AnswerAskUser {
                answer: AskUserAnswerPayload {
                    value: choice.value.clone(),
                    source: "choice".to_string(),
                    option_index: Some(index),
                    option_label: Some(choice.label.clone()),
                },
            },
        )?;
        return Ok(());
    }

    if let Some(default_value) = &prompt.default_value {
        send_command(
            stdin,
            BridgeCommand::AnswerAskUser {
                answer: AskUserAnswerPayload {
                    value: default_value.clone(),
                    source: "default".to_string(),
                    option_index: None,
                    option_label: None,
                },
            },
        )?;
    }

    Ok(())
}

pub(crate) fn validate_ask_user_input(prompt: &NativeAskUserState, value: &str) -> Option<String> {
    let trimmed = value.trim();
    if prompt.required
        && trimmed.is_empty()
        && prompt.default_value.is_none()
        && prompt.options.is_empty()
    {
        return Some("answer required".to_string());
    }

    if prompt.kind == "number" && !trimmed.is_empty() && trimmed.parse::<f64>().is_err() {
        return Some(
            prompt
                .validation
                .as_ref()
                .and_then(|v| v.message.clone())
                .unwrap_or_else(|| "enter a valid number".to_string()),
        );
    }

    if let Some(validation) = &prompt.validation {
        if let Some(min) = validation.min_length {
            if trimmed.len() < min as usize {
                return Some(
                    validation
                        .message
                        .clone()
                        .unwrap_or_else(|| format!("enter at least {min} characters")),
                );
            }
        }
        if let Some(max) = validation.max_length {
            if trimmed.len() > max as usize {
                return Some(
                    validation
                        .message
                        .clone()
                        .unwrap_or_else(|| format!("keep the answer under {max} characters")),
                );
            }
        }
        if let Some(pattern) = &validation.pattern {
            if let Ok(regex) = Regex::new(pattern) {
                if !regex.is_match(trimmed) {
                    return Some(validation.message.clone().unwrap_or_else(|| {
                        "answer format does not match the requirement".to_string()
                    }));
                }
            }
        }
    }

    None
}
