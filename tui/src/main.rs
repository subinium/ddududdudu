use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};
use slt::{
    Border, Color, KeyCode, KeyModifiers, RunConfig, ScrollState, SpinnerState, Style,
    TextInputState, ToastState,
};

const BG: Color = Color::Rgb(18, 18, 24);
const SIDEBAR_BG: Color = Color::Rgb(14, 14, 20);
const COMPOSER_BG: Color = Color::Rgb(22, 22, 30);
const FG: Color = Color::Rgb(248, 248, 242);
const USER_FG: Color = Color::Rgb(255, 255, 255);
const ACCENT: Color = Color::Rgb(247, 167, 187);
const ACCENT_DIM: Color = Color::Rgb(160, 110, 125);
const SUCCESS: Color = Color::Rgb(80, 250, 123);
const ERROR: Color = Color::Rgb(255, 85, 85);
const MUTED: Color = Color::Rgb(110, 100, 105);
const TOOL_MUTED: Color = Color::Rgb(90, 82, 88);
const ORANGE: Color = Color::Rgb(255, 184, 108);
const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const THINKING_FRAMES: &[&str] = &["◉", "◎", "○", "◎"];
const BRIDGE_EVENT_PREFIX: &str = "__DDUDU_BRIDGE__ ";
const MAX_PROMPT_HISTORY: usize = 200;
const SPLASH_FULL: &[&str] = &[
    "      d8b       d8b                d8b                    d8b       d8b                d8b",
    "      88P       88P                88P                    88P       88P                88P",
    "     d88       d88                d88                    d88       d88                d88",
    " d888888   d888888  ?88   d8P d888888  ?88   d8P     d888888   d888888  ?88   d8P d888888  ?88   d8P",
    "d8P' ?88  d8P' ?88  d88   88 d8P' ?88  d88   88     d8P' ?88  d8P' ?88  d88   88 d8P' ?88  d88   88",
    "88b  ,88b 88b  ,88b ?8(  d88 88b  ,88b ?8(  d88     88b  ,88b 88b  ,88b ?8(  d88 88b  ,88b ?8(  d88",
    "`?88P'`88b`?88P'`88b`?88P'?8b`?88P'`88b`?88P'?8b    `?88P'`88b`?88P'`88b`?88P'?8b`?88P'`88b`?88P'?8b",
];
const SPLASH_COMPACT: &[&str] = &[
    "      d8b       d8b                d8b",
    "      88P       88P                88P",
    "     d88       d88                d88",
    " d888888   d888888  ?88   d8P d888888  ?88   d8P",
    "d8P' ?88  d8P' ?88  d88   88 d8P' ?88  d88   88",
    "88b  ,88b 88b  ,88b ?8(  d88 88b  ,88b ?8(  d88",
    "`?88P'`88b`?88P'`88b`?88P'?8b`?88P'`88b`?88P'?8b",
];

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeSlashCommand {
    label: String,
    description: String,
    value: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeToolCallState {
    id: String,
    name: String,
    args: String,
    summary: String,
    result: Option<String>,
    status: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeMessageState {
    id: String,
    role: String,
    content: String,
    timestamp: u64,
    #[serde(default)]
    is_streaming: bool,
    #[serde(default)]
    thinking: Option<String>,
    #[serde(default)]
    is_thinking: Option<bool>,
    #[serde(default)]
    tool_calls: Vec<NativeToolCallState>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
struct NativeModeState {
    name: String,
    label: String,
    tagline: String,
    provider: String,
    model: String,
    active: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
struct NativeProviderState {
    name: String,
    available: bool,
    source: Option<String>,
    token_type: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeMcpState {
    configured_servers: u64,
    connected_servers: u64,
    tool_count: u64,
    server_names: Vec<String>,
    connected_names: Vec<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeLspState {
    available_servers: u64,
    connected_servers: u64,
    server_labels: Vec<String>,
    connected_labels: Vec<String>,
}

fn default_true() -> bool {
    true
}

fn default_ask_user_kind() -> String {
    "input".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAskUserOptionState {
    value: String,
    label: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    recommended: bool,
    #[serde(default)]
    danger: bool,
    #[serde(default)]
    shortcut: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAskUserValidationState {
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    min_length: Option<u64>,
    #[serde(default)]
    max_length: Option<u64>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAskUserState {
    question: String,
    #[serde(default = "default_ask_user_kind")]
    kind: String,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    placeholder: Option<String>,
    #[serde(default)]
    submit_label: Option<String>,
    #[serde(default = "default_true")]
    allow_custom_answer: bool,
    #[serde(default = "default_true")]
    required: bool,
    #[serde(default)]
    default_value: Option<String>,
    #[serde(default)]
    default_option_index: Option<usize>,
    #[serde(default)]
    validation: Option<NativeAskUserValidationState>,
    #[serde(default)]
    options: Vec<NativeAskUserOptionState>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AskUserAnswerPayload {
    value: String,
    source: String,
    option_index: Option<usize>,
    option_label: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativePlanItemState {
    id: String,
    step: String,
    status: String,
    owner: Option<String>,
    updated_at: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAgentActivityState {
    id: String,
    label: String,
    mode: Option<String>,
    purpose: Option<String>,
    checklist_id: Option<String>,
    status: String,
    detail: Option<String>,
    workspace_path: Option<String>,
    updated_at: u64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeBackgroundJobState {
    id: String,
    kind: String,
    label: String,
    status: String,
    detail: Option<String>,
    started_at: u64,
    updated_at: u64,
    finished_at: Option<u64>,
    purpose: Option<String>,
    preferred_mode: Option<String>,
    strategy: Option<String>,
    attempt: Option<u64>,
    has_result: Option<bool>,
    result_preview: Option<String>,
    workspace_path: Option<String>,
    prompt_preview: Option<String>,
    checklist: Vec<NativeJobChecklistItem>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeJobChecklistItem {
    id: String,
    label: String,
    owner: Option<String>,
    status: String,
    detail: Option<String>,
    depends_on: Option<Vec<String>>,
    handoff_to: Option<String>,
    updated_at: u64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeArtifactState {
    id: String,
    kind: String,
    title: String,
    summary: String,
    source: String,
    mode: Option<String>,
    created_at: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeGitState {
    branch: Option<String>,
    changed_file_count: u64,
    staged_file_count: u64,
    has_uncommitted: bool,
    changed_files: Vec<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeWorkspaceState {
    label: String,
    path: String,
    kind: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeVerificationState {
    status: String,
    summary: Option<String>,
    cwd: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeRequestEstimateState {
    system: u64,
    history: u64,
    tools: u64,
    prompt: u64,
    total: u64,
    mode: String,
    note: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeTuiState {
    ready: bool,
    version: String,
    cwd: String,
    mode: String,
    modes: Vec<NativeModeState>,
    provider: String,
    model: String,
    models: Vec<String>,
    auth_type: Option<String>,
    auth_source: Option<String>,
    permission_profile: String,
    loading: bool,
    loading_label: String,
    loading_since: Option<u64>,
    playing_with_fire: bool,
    context_percent: f64,
    context_tokens: u64,
    context_limit: u64,
    context_preview: Option<String>,
    request_estimate: Option<NativeRequestEstimateState>,
    queued_prompts: Vec<String>,
    providers: Vec<NativeProviderState>,
    mcp: Option<NativeMcpState>,
    lsp: Option<NativeLspState>,
    messages: Vec<NativeMessageState>,
    ask_user: Option<NativeAskUserState>,
    slash_commands: Vec<NativeSlashCommand>,
    session_id: Option<String>,
    remote_session_id: Option<String>,
    remote_session_count: u64,
    team_run_strategy: Option<String>,
    team_run_task: Option<String>,
    team_run_since: Option<u64>,
    todos: Vec<NativePlanItemState>,
    agent_activities: Vec<NativeAgentActivityState>,
    background_jobs: Vec<NativeBackgroundJobState>,
    artifacts: Vec<NativeArtifactState>,
    git: Option<NativeGitState>,
    workspace: Option<NativeWorkspaceState>,
    verification: Option<NativeVerificationState>,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BridgeEvent {
    #[serde(rename = "content_delta")]
    ContentDelta {
        id: String,
        delta: String,
    },
    #[serde(rename = "thinking_delta")]
    ThinkingDelta {
        id: String,
        delta: String,
        #[serde(rename = "isThinking")]
        is_thinking: bool,
    },
    #[serde(rename = "stream_end")]
    StreamEnd {
        id: String,
    },
    State {
        state: NativeTuiState,
    },
    Fatal {
        message: String,
    },
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BridgeCommand {
    Submit { content: String },
    PrefetchContext { content: String },
    Abort,
    ClearMessages,
    RunSlash { command: String },
    SetMode { mode: String },
    CycleMode { direction: i8 },
    SetModel { model: String },
    AnswerAskUser { answer: AskUserAnswerPayload },
}

struct App {
    state: NativeTuiState,
    composer: TextInputState,
    ask_user_input: TextInputState,
    ask_user_radio: slt::RadioState,
    transcript_scroll: ScrollState,
    sidebar_scroll: ScrollState,
    auto_scroll: bool,
    toast: ToastState,
    spinner: SpinnerState,
    fatal_error: Option<String>,
    streaming_message_id: Option<String>,
    prompt_history: Vec<String>,
    history_index: Option<usize>,
    history_stash: Option<String>,
    last_mode: String,
    last_model: String,
    last_provider: String,
    last_job_statuses: HashMap<String, String>,
    last_verification_status: Option<String>,
}

impl App {
    fn new() -> Self {
        let state = initial_state();
        Self {
            composer: TextInputState::with_placeholder("Ask ddudu... (/ for command)"),
            ask_user_input: TextInputState::new(),
            ask_user_radio: slt::RadioState::new(vec!["".to_string()]),
            transcript_scroll: ScrollState::new(),
            sidebar_scroll: ScrollState::new(),
            auto_scroll: true,
            toast: ToastState::new(),
            spinner: SpinnerState::dots(),
            fatal_error: None,
            streaming_message_id: None,
            prompt_history: Vec::new(),
            history_index: None,
            history_stash: None,
            last_mode: state.mode.clone(),
            last_model: state.model.clone(),
            last_provider: state.provider.clone(),
            last_job_statuses: HashMap::new(),
            last_verification_status: None,
            state,
        }
    }

    fn push_prompt_history(&mut self, prompt: &str) {
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

    fn on_bridge_event(&mut self, event: BridgeEvent, tick: u64) {
        match event {
            BridgeEvent::ContentDelta { id, delta } => {
                if let Some(msg) = self.state.messages.iter_mut().find(|m| m.id == id) {
                    msg.content.push_str(&delta);
                    msg.is_streaming = true;
                }
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

    fn apply_state(&mut self, next_state: NativeTuiState, tick: u64) {
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

fn initial_state() -> NativeTuiState {
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

fn spawn_bridge(
    node_path: &str,
    bridge_path: &str,
) -> Result<(Child, ChildStdin, Receiver<Result<BridgeEvent>>)> {
    let mut child = Command::new(node_path)
        .arg(bridge_path)
        .arg("bridge")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("failed to start bridge: {bridge_path}"))?;

    let stdin = child.stdin.take().context("bridge stdin unavailable")?;
    let stdout = child.stdout.take().context("bridge stdout unavailable")?;
    let (tx, rx) = mpsc::channel::<Result<BridgeEvent>>();

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let outcome = match line {
                Ok(raw) => {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let payload = if let Some(rest) = trimmed.strip_prefix(BRIDGE_EVENT_PREFIX) {
                        rest
                    } else if trimmed.starts_with('{') {
                        trimmed
                    } else {
                        continue;
                    };

                    (|| -> Result<BridgeEvent> {
                        let decoded = if payload.starts_with('{') {
                            payload.to_string()
                        } else {
                            let bytes = BASE64_STANDARD.decode(payload).map_err(|error| {
                                anyhow!("failed to decode bridge event: {error}")
                            })?;
                            String::from_utf8(bytes).map_err(|error| {
                                anyhow!("failed to decode bridge event utf8: {error}")
                            })?
                        };

                        serde_json::from_str::<BridgeEvent>(&decoded)
                            .map_err(|error| anyhow!("failed to parse bridge event: {error}"))
                    })()
                }
                Err(error) => Err(anyhow!("failed to read bridge event: {error}")),
            };

            if tx.send(outcome).is_err() {
                return;
            }
        }

        let _ = tx.send(Err(anyhow!("bridge process closed stdout")));
    });

    Ok((child, stdin, rx))
}

fn send_command(stdin: &mut ChildStdin, command: BridgeCommand) -> Result<()> {
    let raw = serde_json::to_string(&command)?;
    writeln!(stdin, "{raw}")?;
    stdin.flush()?;
    Ok(())
}

fn poll_bridge(receiver: &Receiver<Result<BridgeEvent>>, app: &mut App, ui: &mut slt::Context) {
    while let Ok(event) = receiver.try_recv() {
        match event {
            Ok(ev) => app.on_bridge_event(ev, ui.tick()),
            Err(error) => {
                app.fatal_error = Some(error.to_string());
                break;
            }
        }
    }
}

fn handle_input(ui: &mut slt::Context, app: &mut App, stdin: &mut ChildStdin) -> Result<()> {
    if ui.key_mod('q', KeyModifiers::CONTROL) {
        ui.quit();
    }

    if ui.key_mod('l', KeyModifiers::CONTROL) {
        send_command(stdin, BridgeCommand::ClearMessages)?;
        app.auto_scroll = true;
        app.transcript_scroll.offset = usize::MAX;
    }

    if ui.key_code(KeyCode::BackTab) {
        send_command(stdin, BridgeCommand::CycleMode { direction: 1 })?;
    }

    if ui.key_code(KeyCode::PageUp) {
        app.auto_scroll = false;
        app.transcript_scroll.scroll_up(8);
    }
    if ui.key_code(KeyCode::PageDown) {
        app.transcript_scroll.scroll_down(8);
    }
    if ui.key_code(KeyCode::End) {
        app.auto_scroll = true;
        app.transcript_scroll.offset = usize::MAX;
    }
    if ui.scroll_up() {
        app.auto_scroll = false;
    }

    if ui.key_code(KeyCode::Up) && app.state.ask_user.is_none() && app.composer.value.is_empty() {
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
            app.history_index = None;
            app.history_stash = None;
        }
    }

    if ui.key_code(KeyCode::Enter) {
        if app.state.ask_user.is_some() {
            submit_ask_user(app, stdin)?;
            return Ok(());
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
        app.history_index = None;
        app.history_stash = None;
        app.auto_scroll = true;
        app.transcript_scroll.offset = usize::MAX;
    }

    Ok(())
}

fn submit_ask_user(app: &mut App, stdin: &mut ChildStdin) -> Result<()> {
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

fn validate_ask_user_input(prompt: &NativeAskUserState, value: &str) -> Option<String> {
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

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{truncated}…")
}

fn render_app(ui: &mut slt::Context, app: &mut App) {
    let show_sidebar = ui.width() >= 88;
    let sidebar_width = if ui.width() >= 124 {
        44
    } else if ui.width() >= 104 {
        40
    } else {
        34
    };

    ui.container().bg(BG).w_pct(100).h_pct(100).row(|ui| {
        ui.container().grow(1).bg(BG).col(|ui| {
            ui.error_boundary(|ui| {
                render_transcript(ui, app);
            });
            render_status_line(ui, app);
            render_composer(ui, app);
        });

        if show_sidebar {
            ui.container()
                .w(sidebar_width)
                .bg(SIDEBAR_BG)
                .border(Border::Rounded)
                .border_left(true)
                .border_top(false)
                .border_bottom(false)
                .border_right(false)
                .border_style(Style::new().fg(MUTED))
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

fn render_transcript(ui: &mut slt::Context, app: &mut App) {
    if app.auto_scroll {
        app.transcript_scroll.offset = usize::MAX;
    }

    let tick = ui.tick();
    let messages = &app.state.messages;
    let streaming = app.streaming_message_id.as_deref();
    let scroll = &mut app.transcript_scroll;

    ui.scrollable(scroll).grow(1).p(1).col(|ui| {
        if messages.is_empty() {
            render_welcome(ui, &app.state);
            return;
        }

        for msg in messages {
            render_message(ui, msg, tick, streaming);
        }
    });
}

fn render_message(
    ui: &mut slt::Context,
    msg: &NativeMessageState,
    tick: u64,
    streaming_id: Option<&str>,
) {
    let streaming_cursor = (tick / 30).is_multiple_of(2);
    match msg.role.as_str() {
        "user" => {
            ui.container().pb(1).col(|ui| {
                ui.styled("❯", Style::new().fg(ACCENT).bold());
                ui.text_wrap(&msg.content).bold().fg(USER_FG);
            });
        }
        "assistant" => {
            ui.container().pb(1).col(|ui| {
                ui.styled("▌ assistant", Style::new().fg(ACCENT).bold());
                ui.markdown(&msg.content);

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
                    let summary = if tool.summary.trim().is_empty() {
                        tool.name.clone()
                    } else {
                        format!("{}: {}", tool.name, truncate(&tool.summary, 70))
                    };
                    ui.styled(
                        format!("  {} {}", icon, summary),
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
            ui.container().pb(1).col(|ui| {
                ui.text_wrap(format!("⚙ {}", msg.content)).fg(MUTED).dim();
            });
        }
    }
}

fn render_welcome(ui: &mut slt::Context, state: &NativeTuiState) {
    ui.spacer();
    let splash = if ui.width() >= 100 {
        SPLASH_FULL
    } else if ui.width() >= 56 {
        SPLASH_COMPACT
    } else {
        &[]
    };
    ui.container().center().col(|ui| {
        for line in splash {
            ui.styled((*line).to_string(), Style::new().fg(ACCENT_DIM));
        }
        if !splash.is_empty() {
            ui.text("");
        }
        ui.styled(
            format!("ddudu v{}", state.version),
            Style::new().fg(ACCENT).bold(),
        );
        ui.styled(
            "Type a prompt and press Enter. / for commands.",
            Style::new().fg(MUTED).italic(),
        );
        if let Some(cwd) = state.cwd.rsplit('/').next() {
            ui.styled(format!("📁 {}", cwd), Style::new().fg(MUTED).dim());
        }
    });
    ui.spacer();
}

fn render_status_line(ui: &mut slt::Context, app: &App) {
    let state = &app.state;
    let mode = current_mode_label(state);
    let context = format!("{:.0}%", state.context_percent.clamp(0.0, 100.0));

    ui.container().h(1).px(1).bg(BG).row(|ui| {
        ui.styled(mode, Style::new().fg(ACCENT).bold());
        ui.styled(" · ", Style::new().fg(MUTED));
        ui.styled(state.provider.clone(), Style::new().fg(FG));
        ui.styled(" · ", Style::new().fg(MUTED));
        ui.styled(state.model.clone(), Style::new().fg(ACCENT_DIM));
        ui.spacer();
        ui.styled(format!("ctx {}", context), Style::new().fg(ORANGE));
        ui.styled(" · ", Style::new().fg(MUTED));
        if state.playing_with_fire {
            ui.text("🔥").fg(ERROR);
        } else {
            ui.styled(
                truncate(&state.permission_profile, 12),
                Style::new().fg(MUTED),
            );
        }
        if state.loading {
            ui.styled(" ", Style::new());
            ui.spinner(&app.spinner).fg(ACCENT);
            let mut label = String::new();
            if let Some(since) = state.loading_since {
                let now_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let elapsed_s = now_ms.saturating_sub(since) / 1000;
                if elapsed_s >= 2 {
                    label.push_str(&format!(" {}s", elapsed_s));
                }
            }
            if !state.loading_label.trim().is_empty() {
                label.push_str(&format!(" {}", state.loading_label.trim()));
            }
            if !label.is_empty() {
                ui.styled(label, Style::new().fg(ACCENT_DIM).italic());
            }
        }
    });
}

fn render_composer(ui: &mut slt::Context, app: &mut App) {
    ui.container().bg(COMPOSER_BG).px(1).pt(1).col(|ui| {
        ui.text_input(&mut app.composer);
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
            "Enter submit | Esc abort/clear | Shift+Tab mode | Ctrl+L clear"
        } else {
            "Enter ⏎ | Esc ✕ | ⇧Tab mode"
        };
        ui.styled(hint, Style::new().fg(MUTED));
    });
}

fn render_sidebar(ui: &mut slt::Context, app: &mut App, max_width: usize) {
    let sidebar_max = max_width.max(16);
    let jobs = &app.state.background_jobs;
    let todos = &app.state.todos;
    let agent_activities = &app.state.agent_activities;
    let artifacts = &app.state.artifacts;
    let context_preview = app
        .state
        .context_preview
        .as_deref()
        .unwrap_or("(no context preview)");
    let providers = &app.state.providers;
    let mcp = &app.state.mcp;
    let lsp = &app.state.lsp;
    let git = &app.state.git;
    let workspace = &app.state.workspace;
    let verification = &app.state.verification;
    let team_strategy = &app.state.team_run_strategy;
    let team_task = &app.state.team_run_task;

    let scroll = &mut app.sidebar_scroll;
    ui.scrollable(scroll).p(1).col(|ui| {
        ui.col_gap(1, |ui| {
            ui.container()
                .border(Border::Rounded)
                .title_styled("JOBS", Style::new().fg(ACCENT).bold())
                .p(1)
                .col(|ui| {
                    if jobs.is_empty() {
                        ui.styled("(no background jobs)", Style::new().fg(MUTED).dim());
                    } else {
                        for job in jobs.iter().take(8) {
                            let icon = match job.status.as_str() {
                                "done" => "✓",
                                "error" => "✗",
                                "cancelled" => "•",
                                _ => {
                                    SPINNER_FRAMES
                                        [((ui.tick() / 6) as usize) % SPINNER_FRAMES.len()]
                                }
                            };
                            ui.styled(
                                truncate(&format!("{} {}", icon, job.label), sidebar_max),
                                Style::new().fg(FG),
                            );
                        }
                    }
                });

            ui.container()
                .border(Border::Rounded)
                .title_styled("PLAN", Style::new().fg(ACCENT).bold())
                .p(1)
                .col(|ui| {
                    if todos.is_empty() {
                        ui.styled("(no todo items)", Style::new().fg(MUTED).dim());
                    } else {
                        for item in todos.iter().take(8) {
                            let icon = match item.status.as_str() {
                                "completed" | "done" => "✓",
                                "in_progress" => "▸",
                                "cancelled" => "×",
                                _ => "·",
                            };
                            ui.styled(
                                truncate(&format!("{} {}", icon, item.step), sidebar_max),
                                Style::new().fg(FG),
                            );
                        }
                    }
                });

            if !agent_activities.is_empty() {
                ui.container()
                    .border(Border::Rounded)
                    .title_styled("AGENTS", Style::new().fg(ACCENT).bold())
                    .p(1)
                    .col(|ui| {
                        for agent in agent_activities.iter().take(6) {
                            let icon = match agent.status.as_str() {
                                "done" | "completed" => "✓",
                                "running" => {
                                    SPINNER_FRAMES
                                        [((ui.tick() / 6) as usize) % SPINNER_FRAMES.len()]
                                }
                                "error" | "failed" => "✗",
                                _ => "·",
                            };
                            ui.styled(
                                truncate(&format!("{} {}", icon, agent.label), sidebar_max),
                                Style::new().fg(FG),
                            );
                        }
                    });
            }

            if !artifacts.is_empty() {
                ui.container()
                    .border(Border::Rounded)
                    .title_styled("ARTIFACTS", Style::new().fg(ACCENT).bold())
                    .p(1)
                    .col(|ui| {
                        for art in artifacts.iter().take(4) {
                            ui.styled(
                                truncate(&format!("{}: {}", art.kind, art.title), sidebar_max),
                                Style::new().fg(FG),
                            );
                        }
                    });
            }

            ui.container()
                .border(Border::Rounded)
                .title_styled("CONTEXT", Style::new().fg(ACCENT).bold())
                .p(1)
                .col(|ui| {
                    ui.styled(
                        truncate(
                            &format!(
                                "tokens {}/{} ({:.1}%)",
                                app.state.context_tokens,
                                app.state.context_limit,
                                app.state.context_percent
                            ),
                            sidebar_max,
                        ),
                        Style::new().fg(ORANGE),
                    );
                    ui.styled(
                        truncate(context_preview, sidebar_max.saturating_mul(2)),
                        Style::new().fg(MUTED).dim(),
                    )
                    .wrap();
                });

            ui.container()
                .border(Border::Rounded)
                .title_styled("SYSTEMS", Style::new().fg(ACCENT).bold())
                .p(1)
                .col(|ui| {
                    if let Some(ws) = workspace {
                        ui.styled(truncate(&ws.label, sidebar_max), Style::new().fg(FG));
                        ui.styled(
                            truncate(&ws.path, sidebar_max),
                            Style::new().fg(MUTED).dim(),
                        );
                    }
                    if !providers.is_empty() {
                        for provider in providers {
                            let icon = if provider.available { "●" } else { "○" };
                            let color = if provider.available { SUCCESS } else { MUTED };
                            ui.styled(
                                truncate(&format!("{} {}", icon, provider.name), sidebar_max),
                                Style::new().fg(color),
                            );
                        }
                    }
                    if let Some(mcp_state) = mcp {
                        ui.styled(
                            truncate(
                                &format!(
                                    "mcp: {}/{} servers, {} tools",
                                    mcp_state.connected_servers,
                                    mcp_state.configured_servers,
                                    mcp_state.tool_count
                                ),
                                sidebar_max,
                            ),
                            Style::new().fg(FG),
                        );
                    }
                    if let Some(lsp_state) = lsp {
                        ui.styled(
                            truncate(
                                &format!(
                                    "lsp: {}/{}",
                                    lsp_state.connected_servers, lsp_state.available_servers
                                ),
                                sidebar_max,
                            ),
                            Style::new().fg(FG),
                        );
                    }
                    if let Some(git_state) = git {
                        if let Some(branch) = &git_state.branch {
                            ui.styled(
                                truncate(&format!("git: {}", branch), sidebar_max),
                                Style::new().fg(FG),
                            );
                        }
                        ui.styled(
                            truncate(
                                &format!(
                                    "  {} changed, {} staged",
                                    git_state.changed_file_count, git_state.staged_file_count
                                ),
                                sidebar_max,
                            ),
                            Style::new().fg(MUTED),
                        );
                    }
                    if let Some(v) = verification {
                        let color = if v.status == "passed" {
                            SUCCESS
                        } else if v.status == "failed" {
                            ERROR
                        } else {
                            ORANGE
                        };
                        ui.styled(
                            truncate(&format!("verify: {}", v.status), sidebar_max),
                            Style::new().fg(color),
                        );
                    }
                });

            if let Some(strategy) = team_strategy {
                ui.container()
                    .border(Border::Rounded)
                    .title_styled("TEAM RUN", Style::new().fg(ACCENT).bold())
                    .p(1)
                    .col(|ui| {
                        ui.styled(
                            truncate(&format!("strategy: {}", strategy), sidebar_max),
                            Style::new().fg(FG),
                        );
                        if let Some(task) = team_task {
                            ui.text_wrap(truncate(task, sidebar_max)).fg(MUTED).dim();
                        }
                    });
            }
        });
    });
}

fn render_ask_user(ui: &mut slt::Context, app: &mut App) {
    let Some(prompt) = app.state.ask_user.as_ref() else {
        return;
    };

    ui.modal(|ui| {
        ui.container()
            .w_pct(75)
            .max_w(100)
            .bg(BG)
            .border(Border::Rounded)
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
                    ui.radio(&mut app.ask_user_radio);
                }

                if prompt.allow_custom_answer {
                    ui.styled("Custom answer", Style::new().fg(ACCENT_DIM));
                    ui.text_input(&mut app.ask_user_input);
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

fn render_fatal_error(ui: &mut slt::Context, app: &App) {
    let Some(message) = app.fatal_error.as_ref() else {
        return;
    };
    ui.modal(|ui| {
        ui.container()
            .w_pct(70)
            .max_w(90)
            .bg(BG)
            .border(Border::Rounded)
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

fn sync_ask_user_radio(ask_user: &Option<NativeAskUserState>, radio: &mut slt::RadioState) {
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

fn current_mode_label(state: &NativeTuiState) -> String {
    state
        .modes
        .iter()
        .find(|mode| mode.active)
        .map(|mode| mode.label.clone())
        .unwrap_or_else(|| state.mode.to_uppercase())
}

fn ddudu_theme() -> slt::Theme {
    slt::Theme {
        primary: Color::Rgb(247, 167, 187),
        secondary: Color::Rgb(160, 110, 125),
        accent: Color::Rgb(247, 167, 187),
        text: Color::Rgb(248, 248, 242),
        text_dim: Color::Rgb(110, 100, 105),
        border: Color::Rgb(110, 100, 105),
        bg: Color::Rgb(18, 18, 24),
        success: Color::Rgb(80, 250, 123),
        warning: Color::Rgb(255, 184, 108),
        error: Color::Rgb(255, 85, 85),
        selected_bg: Color::Rgb(247, 167, 187),
        selected_fg: Color::Rgb(18, 18, 24),
        surface: Color::Rgb(22, 22, 30),
        surface_hover: Color::Rgb(30, 30, 40),
        surface_text: Color::Rgb(248, 248, 242),
    }
}

fn parse_args() -> Result<(String, String)> {
    let mut node_path = None;
    let mut bridge_path = None;
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--node" => node_path = args.next(),
            "--bridge" => bridge_path = args.next(),
            _ => {}
        }
    }

    let node_path = node_path.context("missing --node")?;
    let bridge_path = bridge_path.context("missing --bridge")?;
    Ok((node_path, bridge_path))
}

fn main() -> Result<()> {
    let (node_path, bridge_path) = parse_args()?;
    let (mut child, mut stdin, receiver) = spawn_bridge(&node_path, &bridge_path)?;
    let mut app = App::new();

    let config = RunConfig {
        tick_rate: Duration::from_millis(16),
        mouse: true,
        theme: ddudu_theme(),
        max_fps: Some(60),
    };

    let run_result = slt::run_with(config, |ui| {
        poll_bridge(&receiver, &mut app, ui);
        // Render first so text_input processes Char events before handle_input
        // checks Enter. This prevents the IME race condition where a composed
        // CJK character and Enter arrive in the same frame — text_input inserts
        // the character into the value first, then handle_input submits the
        // updated value.
        render_app(ui, &mut app);
        if let Err(error) = handle_input(ui, &mut app, &mut stdin) {
            app.fatal_error = Some(error.to_string());
        }
    });

    let _ = child.kill();
    let _ = child.wait();
    run_result.map_err(|error| anyhow!(error))
}
