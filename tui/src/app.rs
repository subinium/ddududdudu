use std::collections::HashMap;

use slt::{ScrollState, SpinnerState, StreamingMarkdownState, TextInputState, ToastState};

use crate::hangul::HangulComposer;
use crate::protocol::*;
use crate::theme::current_mode_label;

pub(crate) const MAX_PROMPT_HISTORY: usize = 200;

pub(crate) struct App {
    pub(crate) state: NativeTuiState,
    pub(crate) composer: TextInputState,
    pub(crate) korean_mode: bool,
    pub(crate) pending_cycle_mode: bool,
    pub(crate) hangul: HangulComposer,
    pub(crate) hangul_preedit_len: usize,
    pub(crate) ask_user_input: TextInputState,
    pub(crate) ask_user_radio: slt::RadioState,
    pub(crate) transcript_scroll: ScrollState,
    pub(crate) sidebar_scroll: ScrollState,
    pub(crate) auto_scroll: bool,
    pub(crate) toast: ToastState,
    pub(crate) spinner: SpinnerState,
    pub(crate) fatal_error: Option<String>,
    pub(crate) streaming_message_id: Option<String>,
    pub(crate) streaming_markdown: HashMap<String, StreamingMarkdownState>,
    pub(crate) prompt_history: Vec<String>,
    pub(crate) history_index: Option<usize>,
    pub(crate) history_stash: Option<String>,
    pub(crate) last_mode: String,
    pub(crate) last_model: String,
    pub(crate) last_provider: String,
    pub(crate) last_job_statuses: HashMap<String, String>,
    pub(crate) last_verification_status: Option<String>,
}

impl App {
    pub(crate) fn new() -> Self {
        let state = initial_state();
        Self {
            composer: TextInputState::new(),
            korean_mode: false,
            hangul: HangulComposer::new(),
            hangul_preedit_len: 0,
            ask_user_input: TextInputState::new(),
            ask_user_radio: slt::RadioState::new(vec!["".to_string()]),
            transcript_scroll: ScrollState::new(),
            sidebar_scroll: ScrollState::new(),
            auto_scroll: true,
            toast: ToastState::new(),
            spinner: SpinnerState::dots(),
            fatal_error: None,
            streaming_message_id: None,
            streaming_markdown: HashMap::new(),
            prompt_history: Vec::new(),
            history_index: None,
            history_stash: None,
            last_mode: state.mode.clone(),
            last_model: state.model.clone(),
            last_provider: state.provider.clone(),
            last_job_statuses: HashMap::new(),
            pending_cycle_mode: false,
            last_verification_status: None,
            state,
        }
    }

    pub(crate) fn push_prompt_history(&mut self, prompt: &str) {
        if prompt.is_empty() {
            return;
        }
        if self.prompt_history.last().is_some_and(|p| p == prompt) {
            return;
        }
        self.prompt_history.push(prompt.to_string());
        if self.prompt_history.len() > MAX_PROMPT_HISTORY {
            let overflow = self.prompt_history.len().saturating_sub(MAX_PROMPT_HISTORY);
            self.prompt_history.drain(0..overflow);
        }
        self.history_index = None;
        self.history_stash = None;
    }

    pub(crate) fn on_bridge_event(&mut self, event: BridgeEvent, tick: u64) {
        match event {
            BridgeEvent::ContentDelta { id, delta } => {
                if let Some(msg) = self.state.messages.iter_mut().find(|m| m.id == id) {
                    msg.content.push_str(&delta);
                    msg.is_streaming = true;
                }
                let markdown = self
                    .streaming_markdown
                    .entry(id.clone())
                    .or_insert_with(StreamingMarkdownState::new);
                if markdown.content.is_empty() {
                    markdown.start();
                }
                markdown.push(&delta);
                self.streaming_message_id = Some(id);
                if self.auto_scroll {
                    self.transcript_scroll.offset = usize::MAX;
                }
            }
            BridgeEvent::ThinkingDelta {
                id,
                delta,
                is_thinking,
            } => {
                if let Some(msg) = self.state.messages.iter_mut().find(|m| m.id == id) {
                    if is_thinking {
                        msg.thinking
                            .get_or_insert_with(String::new)
                            .push_str(&delta);
                    }
                    msg.is_thinking = Some(is_thinking);
                }
            }
            BridgeEvent::StreamEnd { id } => {
                if let Some(msg) = self.state.messages.iter_mut().find(|m| m.id == id) {
                    msg.is_streaming = false;
                    msg.is_thinking = Some(false);
                }
                if let Some(markdown) = self.streaming_markdown.get_mut(&id) {
                    markdown.finish();
                }
                self.streaming_message_id = None;
            }
            BridgeEvent::State { state } => {
                self.apply_state(state, tick);
            }
            BridgeEvent::Fatal { message } => {
                self.fatal_error = Some(message);
            }
        }
    }

    pub(crate) fn apply_state(&mut self, next_state: NativeTuiState, tick: u64) {
        let mode_changed = self.last_mode != next_state.mode
            || self.last_model != next_state.model
            || self.last_provider != next_state.provider;
        if mode_changed && next_state.ready {
            self.toast.info(
                format!(
                    "{} · {} · {}",
                    current_mode_label(&next_state),
                    next_state.provider,
                    next_state.model
                ),
                tick,
            );
        }

        let current_jobs: HashMap<String, String> = next_state
            .background_jobs
            .iter()
            .map(|job| (job.id.clone(), job.status.clone()))
            .collect();
        for job in &next_state.background_jobs {
            if let Some(prev) = self.last_job_statuses.get(&job.id) {
                if prev == "running" && job.status == "done" {
                    self.toast.success(format!("{} finished", job.label), tick);
                } else if (prev == "running" || prev == "done") && job.status == "cancelled" {
                    self.toast.info(format!("{} cancelled", job.label), tick);
                } else if (prev == "running" || prev == "done") && job.status == "error" {
                    self.toast.error(format!("{} failed", job.label), tick);
                }
            }
        }

        let verification_status = next_state.verification.as_ref().map(|v| v.status.clone());
        if self.last_verification_status.as_deref() != verification_status.as_deref() {
            if let Some(status) = verification_status.as_deref() {
                if status == "passed" {
                    self.toast.success("verification passed", tick);
                } else if status == "failed" {
                    self.toast.error("verification failed", tick);
                }
            }
        }

        let had_ask_user = self.state.ask_user.is_some();
        let has_ask_user = next_state.ask_user.is_some();
        self.state = next_state;

        let active_streaming_ids = self
            .state
            .messages
            .iter()
            .filter(|msg| msg.is_streaming)
            .map(|msg| msg.id.clone())
            .collect::<Vec<_>>();
        for msg in self.state.messages.iter().filter(|msg| msg.is_streaming) {
            self.streaming_markdown
                .entry(msg.id.clone())
                .or_insert_with(|| {
                    let mut markdown = StreamingMarkdownState::new();
                    markdown.start();
                    markdown.push(&msg.content);
                    markdown
                });
        }
        self.streaming_markdown
            .retain(|id, _| active_streaming_ids.iter().any(|active| active == id));

        if !had_ask_user && has_ask_user {
            self.ask_user_input = TextInputState::with_placeholder(
                self.state
                    .ask_user
                    .as_ref()
                    .and_then(|a| a.placeholder.clone())
                    .unwrap_or_else(|| "answer".to_string()),
            );
            self.ask_user_input.value = self
                .state
                .ask_user
                .as_ref()
                .and_then(|a| a.default_value.clone())
                .unwrap_or_default();
            self.ask_user_input.cursor = self.ask_user_input.value.chars().count();
            sync_ask_user_radio(&self.state.ask_user, &mut self.ask_user_radio);
        }

        self.last_mode = self.state.mode.clone();
        self.last_model = self.state.model.clone();
        self.last_provider = self.state.provider.clone();
        self.last_job_statuses = current_jobs;
        self.last_verification_status = verification_status;

        if self.auto_scroll {
            self.transcript_scroll.offset = usize::MAX;
        }
    }
}

pub(crate) fn initial_state() -> NativeTuiState {
    NativeTuiState {
        ready: false,
        version: env!("CARGO_PKG_VERSION").to_string(),
        cwd: String::new(),
        mode: "jennie".to_string(),
        modes: Vec::new(),
        provider: "anthropic".to_string(),
        model: "claude-opus-4-6".to_string(),
        models: Vec::new(),
        auth_type: None,
        auth_source: None,
        permission_profile: "workspace-write".to_string(),
        loading: false,
        loading_label: String::new(),
        loading_since: None,
        playing_with_fire: false,
        context_percent: 0.0,
        context_tokens: 0,
        context_limit: 0,
        context_preview: None,
        request_estimate: None,
        queued_prompts: Vec::new(),
        providers: Vec::new(),
        mcp: None,
        lsp: None,
        messages: Vec::new(),
        ask_user: None,
        slash_commands: Vec::new(),
        session_id: None,
        remote_session_id: None,
        remote_session_count: 0,
        team_run_strategy: None,
        team_run_task: None,
        team_run_since: None,
        todos: Vec::new(),
        agent_activities: Vec::new(),
        background_jobs: Vec::new(),
        artifacts: Vec::new(),
        git: None,
        workspace: None,
        verification: None,
        error: None,
    }
}

pub(crate) fn sync_ask_user_radio(
    ask_user: &Option<NativeAskUserState>,
    radio: &mut slt::RadioState,
) {
    let Some(prompt) = ask_user.as_ref() else {
        return;
    };
    let items = prompt
        .options
        .iter()
        .map(|opt| {
            let mut label = opt.label.clone();
            if opt.recommended {
                label.push_str(" (recommended)");
            }
            label
        })
        .collect::<Vec<_>>();

    if items.is_empty() {
        return;
    }
    if radio.items != items {
        *radio = slt::RadioState::new(items);
        if let Some(default_index) = prompt.default_option_index {
            radio.selected = default_index.min(prompt.options.len().saturating_sub(1));
        }
    }
}
