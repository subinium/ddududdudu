use std::cmp::min;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use crossterm::execute;
use crossterm::event::{
    self, Event, KeyCode, KeyEvent, KeyModifiers, KeyboardEnhancementFlags,
    MouseEventKind, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::{DefaultTerminal, Frame};
use serde::{Deserialize, Serialize};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

const BG: Color = Color::Black;
const FG: Color = Color::Rgb(250, 246, 248);
const ACCENT: Color = Color::Rgb(247, 167, 187);
const ACCENT_DIM: Color = Color::Rgb(190, 120, 140);
const SUCCESS: Color = Color::Rgb(80, 220, 120);
const ERROR: Color = Color::Rgb(255, 90, 110);
const MUTED: Color = Color::Rgb(128, 96, 108);
const TOOL_MUTED: Color = Color::Rgb(144, 140, 146);
const TOOL_RUNNING: Color = Color::Rgb(166, 160, 168);
const LINK: Color = Color::Rgb(132, 203, 255);
const PATH: Color = Color::Rgb(255, 208, 120);
const PANEL_TOP_PADDING: u16 = 2;
const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BRIDGE_EVENT_PREFIX: &str = "__DDUDU_BRIDGE__ ";
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAskUserState {
    question: String,
    options: Vec<String>,
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
    workspace: Option<NativeWorkspaceState>,
    verification: Option<NativeVerificationState>,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BridgeEvent {
    State { state: NativeTuiState },
    Fatal { message: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BridgeCommand {
    Submit { content: String },
    Abort,
    ClearMessages,
    RunSlash { command: String },
    SetMode { mode: String },
    CycleMode { direction: i8 },
    SetModel { model: String },
    AnswerAskUser { answer: String },
}

#[derive(Debug, Clone)]
enum SuggestionKind {
    Slash,
    Mode,
    Model,
}

#[derive(Debug, Clone)]
struct Suggestion {
    kind: SuggestionKind,
    value: String,
    description: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SidebarTab {
    Jobs,
    Plan,
    Context,
    Systems,
}

impl SidebarTab {
    fn all() -> [Self; 4] {
        [Self::Jobs, Self::Plan, Self::Context, Self::Systems]
    }

    fn label(self) -> &'static str {
        match self {
            Self::Jobs => "Jobs",
            Self::Plan => "Plan",
            Self::Context => "Context",
            Self::Systems => "Systems",
        }
    }
}

#[derive(Debug, Clone)]
enum SidebarTarget {
    Agent(usize),
    Job(usize),
    Queue(usize),
    Plan(usize),
    ContextOverview,
    ContextEstimate,
    ContextPreview,
    ContextDiff,
    McpSummary,
    LspSummary,
}

#[derive(Debug, Clone, Copy)]
enum NoticeTone {
    Info,
    Success,
    Error,
}

struct TransientNotice {
    text: String,
    tone: NoticeTone,
    created_at: Instant,
}

struct PaletteState {
    query: String,
    selected: usize,
}

#[derive(Clone)]
enum PaletteAction {
    InsertSlash(String),
    SwitchTab(SidebarTab),
    OpenTarget(SidebarTarget),
    OpenContext,
    OpenDiff(Option<String>),
}

#[derive(Clone)]
struct PaletteItem {
    label: String,
    description: String,
    action: PaletteAction,
}

#[derive(Clone)]
enum InspectorKind {
    Agent(usize),
    Job(String),
    Queue(usize),
    Plan(usize),
    Context,
    McpSummary,
    McpServer(usize),
    LspSummary,
    LspServer(usize),
    Tool(usize, usize),
    Diff { title: String, cwd: Option<String> },
}

struct InspectorState {
    title: String,
    body: Vec<String>,
    footer: Option<String>,
    scroll: usize,
    kind: InspectorKind,
}

#[derive(Debug, Default)]
struct ComposerState {
    text: String,
    cursor: usize,
}

impl ComposerState {
    fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
    }

    fn graphemes(&self) -> Vec<String> {
        UnicodeSegmentation::graphemes(self.text.as_str(), true)
            .map(|g| g.to_string())
            .collect()
    }

    fn set_text(&mut self, text: String) {
        self.text = text;
        self.cursor = self.graphemes().len();
    }

    fn insert_text(&mut self, value: &str) {
        let mut parts = self.graphemes();
        let insert_parts: Vec<String> = UnicodeSegmentation::graphemes(value, true)
            .map(|g| g.to_string())
            .collect();
        let insert_len = insert_parts.len();
        parts.splice(self.cursor..self.cursor, insert_parts);
        self.text = parts.concat();
        self.cursor += insert_len;
    }

    fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }

        let mut parts = self.graphemes();
        parts.remove(self.cursor - 1);
        self.text = parts.concat();
        self.cursor -= 1;
    }

    fn delete(&mut self) {
        let mut parts = self.graphemes();
        if self.cursor >= parts.len() {
            return;
        }

        parts.remove(self.cursor);
        self.text = parts.concat();
    }

    fn move_left(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
        }
    }

    fn move_right(&mut self) {
        let len = self.graphemes().len();
        if self.cursor < len {
            self.cursor += 1;
        }
    }

    fn move_home(&mut self) {
        self.cursor = 0;
    }

    fn move_end(&mut self) {
        self.cursor = self.graphemes().len();
    }

    fn trim(&self) -> String {
        self.text.trim().to_string()
    }
}

struct BridgeClient {
    child: Child,
    stdin: ChildStdin,
    receiver: Receiver<Result<BridgeEvent>>,
}

impl BridgeClient {
    fn spawn(node_path: &str, bridge_path: &str) -> Result<Self> {
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

                        let payload = if let Some(rest) = trimmed.strip_prefix(BRIDGE_EVENT_PREFIX)
                        {
                            rest
                        } else if trimmed.starts_with('{') {
                            trimmed
                        } else {
                            continue;
                        };

                        (|| -> Result<BridgeEvent> {
                            let decoded = if payload.starts_with('{') {
                                payload.to_owned()
                            } else {
                                let bytes = BASE64_STANDARD
                                    .decode(payload)
                                    .map_err(|error| anyhow!("failed to decode bridge event: {error}"))?;
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

        Ok(Self {
            child,
            stdin,
            receiver: rx,
        })
    }

    fn send(&mut self, command: BridgeCommand) -> Result<()> {
        let raw = serde_json::to_string(&command)?;
        writeln!(self.stdin, "{raw}")?;
        self.stdin.flush()?;
        Ok(())
    }

    fn try_recv(&self) -> Option<Result<BridgeEvent>> {
        self.receiver.try_recv().ok()
    }

    fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct App {
    bridge: BridgeClient,
    state: NativeTuiState,
    composer: ComposerState,
    scroll: usize,
    auto_scroll: bool,
    spinner_index: usize,
    splash_phase: usize,
    selected_suggestion: usize,
    ask_user_selection: usize,
    sidebar_tab: SidebarTab,
    sidebar_selection: usize,
    palette: Option<PaletteState>,
    inspector: Option<InspectorState>,
    fold_tool_calls: bool,
    fold_system_messages: bool,
    pending_paste: Option<String>,
    fatal_error: Option<String>,
    last_tick: Instant,
    should_quit: bool,
    notices: Vec<TransientNotice>,
}

impl App {
    fn new(bridge: BridgeClient) -> Self {
        Self {
            bridge,
            state: NativeTuiState {
                ready: false,
                version: String::new(),
                cwd: String::new(),
                mode: "jennie".into(),
                modes: Vec::new(),
                provider: String::new(),
                model: String::new(),
                models: Vec::new(),
                auth_type: None,
                auth_source: None,
                permission_profile: "workspace-write".into(),
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
                workspace: None,
                verification: None,
                error: None,
            },
            composer: ComposerState::default(),
            scroll: 0,
            auto_scroll: true,
            spinner_index: 0,
            splash_phase: 0,
            selected_suggestion: 0,
            ask_user_selection: 0,
            sidebar_tab: SidebarTab::Jobs,
            sidebar_selection: 0,
            palette: None,
            inspector: None,
            fold_tool_calls: false,
            fold_system_messages: false,
            pending_paste: None,
            fatal_error: None,
            last_tick: Instant::now(),
            should_quit: false,
            notices: Vec::new(),
        }
    }

    fn on_bridge_event(&mut self, event: BridgeEvent) {
        match event {
            BridgeEvent::State { state } => {
                let was_asking = self.state.ask_user.is_some();
                let previous_mode = self.state.mode.clone();
                let previous_model = self.state.model.clone();
                let previous_provider = self.state.provider.clone();
                let previous_jobs = self
                    .state
                    .background_jobs
                    .iter()
                    .map(|job| (job.id.clone(), job.status.clone()))
                    .collect::<std::collections::HashMap<_, _>>();
                let previous_verification = self.state.verification.as_ref().map(|item| item.status.clone());
                self.state = state;

                if !was_asking && self.state.ask_user.is_some() {
                    self.ask_user_selection = 0;
                    self.composer.clear();
                }

                if self.state.ready
                    && (self.state.mode != previous_mode
                        || self.state.model != previous_model
                        || self.state.provider != previous_provider)
                {
                    let mode_label = self.current_mode_label();
                    self.push_notice(
                        format!("{} · {} · {}", mode_label, self.state.provider, self.state.model),
                        NoticeTone::Info,
                    );
                }

                let mut pending_notices: Vec<(String, NoticeTone)> = Vec::new();
                for job in &self.state.background_jobs {
                    let previous = previous_jobs.get(&job.id);
                    if matches!(previous.map(|value| value.as_str()), Some("running"))
                        && job.status == "done"
                    {
                        pending_notices.push((format!("{} finished", job.label), NoticeTone::Success));
                    } else if matches!(previous.map(|value| value.as_str()), Some("running" | "done"))
                        && job.status == "error"
                    {
                        pending_notices.push((format!("{} failed", job.label), NoticeTone::Error));
                    }
                }
                for (text, tone) in pending_notices {
                    self.push_notice(text, tone);
                }

                let current_verification = self.state.verification.as_ref().map(|item| item.status.clone());
                if previous_verification.as_deref() != current_verification.as_deref() {
                    if let Some(status) = current_verification.as_deref() {
                        match status {
                            "passed" => self.push_notice("verification passed".to_string(), NoticeTone::Success),
                            "failed" => self.push_notice("verification failed".to_string(), NoticeTone::Error),
                            _ => {}
                        }
                    }
                }

                if self.auto_scroll {
                    self.scroll = usize::MAX;
                }
                self.prune_notices();
                self.clamp_sidebar_selection();
                self.refresh_open_inspector();
            }
            BridgeEvent::Fatal { message } => {
                self.fatal_error = Some(message);
            }
        }
    }

    fn current_mode_label(&self) -> String {
        self.state
            .modes
            .iter()
            .find(|mode| mode.active)
            .map(|mode| mode.label.clone())
            .unwrap_or_else(|| self.state.mode.to_uppercase())
    }

    fn push_notice(&mut self, text: String, tone: NoticeTone) {
        self.notices.push(TransientNotice {
            text,
            tone,
            created_at: Instant::now(),
        });
        if self.notices.len() > 4 {
            let overflow = self.notices.len().saturating_sub(4);
            self.notices.drain(0..overflow);
        }
    }

    fn prune_notices(&mut self) {
        self.notices
            .retain(|notice| notice.created_at.elapsed() <= Duration::from_secs(4));
    }

    fn sync_bridge(&mut self) {
        while let Some(event) = self.bridge.try_recv() {
            match event {
                Ok(event) => self.on_bridge_event(event),
                Err(error) => {
                    self.fatal_error = Some(error.to_string());
                    break;
                }
            }
        }
    }

    fn run(&mut self, terminal: &mut DefaultTerminal) -> Result<()> {
        while !self.should_quit {
            self.sync_bridge();
            self.prune_notices();
            terminal.draw(|frame| self.render(frame))?;

            let timeout = Duration::from_millis(50);
            if event::poll(timeout)? {
                let ev = event::read()?;
                self.handle_event(ev)?;
            }

            if self.last_tick.elapsed() >= Duration::from_millis(90) {
                self.spinner_index = (self.spinner_index + 1) % SPINNER_FRAMES.len();
                self.splash_phase = self.splash_phase.wrapping_add(1);
                self.last_tick = Instant::now();
            }
        }

        Ok(())
    }

    fn render(&mut self, frame: &mut Frame) {
        frame.render_widget(
            Block::default().style(Style::default().bg(BG).fg(FG)),
            frame.area(),
        );

        let root = if frame.area().width >= 100 {
            Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Min(20), Constraint::Length(44)])
                .split(frame.area())
        } else {
            Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Min(20)])
                .split(frame.area())
        };
        let show_sidebar = root.len() > 1;
        let main = root[0];
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(6),
                Constraint::Length(1),
                Constraint::Length(6),
            ])
            .split(main);

        self.render_transcript(frame, chunks[0]);
        self.render_status_line(frame, chunks[1]);
        let composer_metrics = self.render_composer(frame, chunks[2]);

        if show_sidebar {
            self.draw_sidebar_divider(frame, root[1].x, frame.area());
            self.render_sidebar(frame, root[1]);
        }

        if let Some((popup_area, suggestions)) = self.render_popup(frame, chunks[1]) {
            frame.render_widget(Clear, popup_area);
            let selected_index = self
                .palette
                .as_ref()
                .map(|palette| palette.selected)
                .unwrap_or(self.selected_suggestion);
            let lines: Vec<Line> = suggestions
                .iter()
                .enumerate()
                .map(|(index, suggestion)| {
                    let selected = index == selected_index;
                    let marker = if selected { "› " } else { "  " };
                    let style = if selected {
                        Style::default()
                            .fg(BG)
                            .bg(ACCENT)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(FG)
                    };
                    Line::from(vec![
                        Span::styled(marker, style),
                        Span::styled(
                            format!("{} ", suggestion.value),
                            style.add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(&suggestion.description, style),
                    ])
                })
                .collect();

            let block = Paragraph::new(Text::from(lines))
                .block(Block::default().style(Style::default().bg(BG).fg(ACCENT)));
            frame.render_widget(block, popup_area);
        }

        self.render_notices(frame);

        if let Some(inspector) = &self.inspector {
            self.render_inspector(frame, inspector);
        }

        if let Some(error) = &self.fatal_error {
            let area = centered_rect(70, 5, frame.area());
            frame.render_widget(Clear, area);
            frame.render_widget(
                Paragraph::new(Text::from(vec![
                    Line::from(Span::styled(
                        "Bridge Error",
                        Style::default().fg(ERROR).add_modifier(Modifier::BOLD),
                    )),
                    Line::from(Span::raw("")),
                    Line::from(Span::styled(error, Style::default().fg(FG))),
                ]))
                .block(Block::default().style(Style::default().bg(BG).fg(FG))),
                area,
            );
        }

        if self.palette.is_none() && self.inspector.is_none() && self.fatal_error.is_none() {
            frame.set_cursor_position((composer_metrics.0, composer_metrics.1));
        }
    }
    fn draw_sidebar_divider(&self, frame: &mut Frame, x: u16, area: Rect) {
        for row in area.top()..area.bottom() {
            frame.buffer_mut().cell_mut((x, row)).map(|cell| {
                cell.set_symbol("│").set_fg(ACCENT_DIM).set_bg(BG);
            });
        }
    }

    fn render_transcript(&mut self, frame: &mut Frame, area: Rect) {
        let area = top_padded_rect(area, PANEL_TOP_PADDING);
        let available_width = area.width.saturating_sub(1) as usize;
        let lines = build_transcript_lines(
            &self.state.messages,
            available_width,
            self.fold_tool_calls,
            self.fold_system_messages,
        );
        let height = area.height as usize;
        let max_scroll = lines.len().saturating_sub(height);

        if self.scroll == usize::MAX || (self.auto_scroll && self.scroll > max_scroll) {
            self.scroll = max_scroll;
        } else {
            self.scroll = self.scroll.min(max_scroll);
        }

        let visible = if lines.is_empty() {
            build_welcome_lines(available_width, self.splash_phase)
        } else {
            lines
                .iter()
                .skip(self.scroll)
                .take(height)
                .cloned()
                .collect::<Vec<_>>()
        };

        frame.render_widget(
            Paragraph::new(Text::from(visible))
                .style(Style::default().bg(BG))
                .block(Block::default().style(Style::default().bg(BG))),
            area,
        );
    }

    fn render_sidebar(&mut self, frame: &mut Frame, area: Rect) {
        let inner = top_padded_rect(
            Rect {
            x: area.x + 2,
            y: area.y,
            width: area.width.saturating_sub(2),
            height: area.height,
            },
            PANEL_TOP_PADDING,
        );

        let mut lines = Vec::new();
        push_sidebar_rail_item(
            &mut lines,
            "·",
            ACCENT_DIM,
            format!("ddudu v{}", self.state.version),
            Some(if self.state.permission_profile == "permissionless" {
                "fire on (permissionless)".to_string()
            } else {
                format!("fire off ({})", self.state.permission_profile)
            }),
            FG,
            ACCENT_DIM,
        );
        lines.push(Line::from(Span::raw("")));
        let mut item_index = 0usize;
        self.render_sidebar_jobs_tab(&mut lines, &mut item_index);
        lines.push(Line::from(Span::raw("")));
        self.render_sidebar_plan_tab(&mut lines, &mut item_index);
        lines.push(Line::from(Span::raw("")));
        self.render_sidebar_context_tab(&mut lines, &mut item_index);
        lines.push(Line::from(Span::raw("")));
        self.render_sidebar_systems_tab(&mut lines, &mut item_index);

        frame.render_widget(
            Paragraph::new(Text::from(lines)).style(Style::default().bg(BG)),
            inner,
        );
    }

    fn render_sidebar_jobs_tab(
        &self,
        lines: &mut Vec<Line<'static>>,
        item_index: &mut usize,
    ) {
        lines.push(sidebar_header("Activity"));
        let mut has_activity = false;
        if self.state.loading {
            has_activity = true;
            push_sidebar_rail_item(
                lines,
                SPINNER_FRAMES[self.spinner_index],
                ACCENT,
                "foreground request".to_string(),
                Some(preview_line(&self.state.loading_label, 28)),
                FG,
                ACCENT_DIM,
            );
        }
        if !self.state.agent_activities.is_empty() {
            has_activity = true;
        }
        for (index, item) in self.state.agent_activities.iter().enumerate().take(4) {
            let (marker, color) = match item.status.as_str() {
                "running" => (SPINNER_FRAMES[self.spinner_index], ACCENT),
                "verifying" => ("◌", ACCENT),
                "done" => ("✓", SUCCESS),
                "error" => ("!", ERROR),
                "queued" => ("•", ACCENT_DIM),
                _ => ("·", ACCENT_DIM),
            };
            let title = match (&item.mode, &item.purpose) {
                (Some(mode), Some(purpose)) => format!("{} · {}", title_case_label(mode), purpose),
                (Some(mode), None) => title_case_label(mode),
                (None, Some(purpose)) => format!("{} · {}", item.label, purpose),
                (None, None) => item.label.clone(),
            };
            push_sidebar_selectable_item(
                lines,
                *item_index == self.sidebar_selection,
                marker,
                color,
                preview_line(&title, 28),
                item.detail
                    .as_ref()
                    .map(|detail| preview_line(detail, 28))
                    .or_else(|| item.workspace_path.as_ref().map(|path| preview_line(path, 28))),
                FG,
                ACCENT_DIM,
            );
            *item_index += 1;
            if index >= 3 {
                break;
            }
        }

        if !self.state.background_jobs.is_empty() {
            has_activity = true;
        }
        for job in self.state.background_jobs.iter().take(4) {
            let (marker, color) = match job.status.as_str() {
                "running" => (SPINNER_FRAMES[self.spinner_index], ACCENT),
                "done" => ("✓", SUCCESS),
                "error" => ("!", ERROR),
                _ => ("·", ACCENT_DIM),
            };
            let elapsed = format_elapsed(Some(job.started_at));
            let retry = job
                .attempt
                .filter(|attempt| *attempt > 0)
                .map(|attempt| format!(" · retry {}", format_count(attempt)));
            push_sidebar_selectable_item(
                lines,
                *item_index == self.sidebar_selection,
                marker,
                color,
                format!(
                    "{}{} {elapsed}",
                    preview_line(&job.label, 18),
                    retry.as_deref().unwrap_or("")
                ),
                checklist_progress(&job.checklist)
                    .or_else(|| job.detail.clone())
                    .map(|detail| preview_line(&detail, 28))
                    .or_else(|| job.detail
                        .as_ref()
                        .map(|detail| preview_line(detail, 28)))
                    .or_else(|| job.result_preview.as_ref().map(|detail| preview_line(detail, 28)))
                    .or_else(|| job.workspace_path.as_ref().map(|path| preview_line(path, 28))),
                FG,
                ACCENT_DIM,
            );
            *item_index += 1;
        }

        if !self.state.queued_prompts.is_empty() {
            has_activity = true;
        }
        for (index, prompt) in self.state.queued_prompts.iter().enumerate().take(4) {
            push_sidebar_selectable_item(
                lines,
                *item_index == self.sidebar_selection,
                "•",
                ACCENT_DIM,
                format!("{}. {}", index + 1, preview_line(prompt, 24)),
                Some("queued prompt".to_string()),
                FG,
                ACCENT_DIM,
            );
            *item_index += 1;
        }

        if !has_activity {
            push_sidebar_rail_item(
                lines,
                "·",
                ACCENT_DIM,
                "quiet".to_string(),
                Some(if self.state.loading {
                    "foreground request still running".to_string()
                } else {
                    "idle".to_string()
                }),
                FG,
                ACCENT_DIM,
            );
        }
    }

    fn render_sidebar_plan_tab(
        &self,
        lines: &mut Vec<Line<'static>>,
        item_index: &mut usize,
    ) {
        lines.push(sidebar_header("Workflow"));
        if let Some(workspace) = &self.state.workspace {
            push_sidebar_rail_item(
                lines,
                "▣",
                ACCENT,
                preview_line(&workspace.label, 28),
                Some(preview_line(&workspace.path, 28)),
                FG,
                ACCENT_DIM,
            );
        } else {
            push_sidebar_rail_item(
                lines,
                "·",
                ACCENT_DIM,
                "root workspace".to_string(),
                Some(preview_line(&self.state.cwd, 28)),
                FG,
                ACCENT_DIM,
            );
        }
        if let Some(verification) = &self.state.verification {
            let (marker, color) = match verification.status.as_str() {
                "running" => (SPINNER_FRAMES[self.spinner_index], ACCENT),
                "passed" => ("✓", SUCCESS),
                "failed" => ("!", ERROR),
                _ => ("·", ACCENT_DIM),
            };
            push_sidebar_rail_item(
                lines,
                marker,
                color,
                format!("verify {}", verification.status),
                verification
                    .summary
                    .as_ref()
                    .map(|summary| preview_line(summary, 28))
                    .or_else(|| verification.cwd.as_ref().map(|cwd| preview_line(cwd, 28))),
                FG,
                ACCENT_DIM,
            );
        }
        if self.state.todos.is_empty() {
            push_sidebar_rail_item(
                lines,
                "·",
                ACCENT_DIM,
                "no active plan".to_string(),
                None,
                FG,
                ACCENT_DIM,
            );
            return;
        }
        for (index, item) in self.state.todos.iter().enumerate().take(10) {
            let (marker, color) = match item.status.as_str() {
                "completed" => ("✓", SUCCESS),
                "in_progress" => ("→", ACCENT),
                _ => ("·", ACCENT_DIM),
            };
            push_sidebar_selectable_item(
                lines,
                *item_index == self.sidebar_selection,
                marker,
                color,
                preview_line(&item.step, 28),
                item.owner
                    .as_ref()
                    .map(|owner| format!("{} · {}", owner, preview_line(&item.id, 8)))
                    .or_else(|| Some(preview_line(&item.id, 8))),
                FG,
                ACCENT_DIM,
            );
            let _ = index;
            *item_index += 1;
        }

        if let Some(active_job) = self
            .state
            .background_jobs
            .iter()
            .find(|job| job.status == "running" && !job.checklist.is_empty())
            .or_else(|| self.state.background_jobs.iter().find(|job| !job.checklist.is_empty()))
        {
            lines.push(Line::from(Span::raw("")));
            lines.push(sidebar_header("Task Progress"));
            push_sidebar_rail_item(
                lines,
                "·",
                ACCENT_DIM,
                preview_line(&active_job.label, 28),
                checklist_progress(&active_job.checklist),
                FG,
                ACCENT_DIM,
            );

            for item in active_job.checklist.iter().take(5) {
                let (marker, color) = match item.status.as_str() {
                    "completed" => ("✓", SUCCESS),
                    "in_progress" => (SPINNER_FRAMES[self.spinner_index], ACCENT),
                    "error" => ("!", ERROR),
                    _ => ("·", ACCENT_DIM),
                };
                let title = if let Some(owner) = &item.owner {
                    format!("{} · {}", item.label, preview_line(owner, 10))
                } else {
                    item.label.clone()
                };
                push_sidebar_rail_item(
                    lines,
                    marker,
                    color,
                    preview_line(&title, 28),
                    item.detail.as_ref().map(|detail| preview_line(detail, 28)),
                    FG,
                    ACCENT_DIM,
                );
            }
        }
    }

    fn render_sidebar_context_tab(
        &self,
        lines: &mut Vec<Line<'static>>,
        item_index: &mut usize,
    ) {
        lines.push(sidebar_header("Context"));
        push_sidebar_selectable_item(
            lines,
            *item_index == self.sidebar_selection,
            "◉",
            ACCENT,
            format!("{:>5.1}% footprint", self.state.context_percent * 100.0),
            Some(format!(
                "{}  {} / {}",
                context_meter(self.state.context_percent, 10),
                format_count(self.state.context_tokens),
                format_count(self.state.context_limit)
            )),
            FG,
            ACCENT_DIM,
        );
        *item_index += 1;
        push_sidebar_rail_item(
            lines,
            "·",
            ACCENT_DIM,
            format!("{} · {}", self.current_mode_label(), display_model_name(&self.state.model)),
            Some(preview_line(&self.state.provider, 28)),
            FG,
            ACCENT_DIM,
        );
        if let Some(estimate) = &self.state.request_estimate {
            push_sidebar_selectable_item(
                lines,
                *item_index == self.sidebar_selection,
                "→",
                ACCENT,
                format!("{} request", estimate.mode),
                Some(format!(
                    "system {} · history {} · tools {} · prompt {}",
                    format_count(estimate.system),
                    format_count(estimate.history),
                    format_count(estimate.tools),
                    format_count(estimate.prompt)
                )),
                FG,
                ACCENT_DIM,
            );
            *item_index += 1;
        }

        if let Some(preview) = &self.state.context_preview {
            push_sidebar_selectable_item(
                lines,
                *item_index == self.sidebar_selection,
                "≡",
                ACCENT_DIM,
                "context preview".to_string(),
                Some(preview_line(preview, 28)),
                FG,
                ACCENT_DIM,
            );
            *item_index += 1;
        }

        push_sidebar_selectable_item(
            lines,
            *item_index == self.sidebar_selection,
            "∆",
            ACCENT_DIM,
            "open diff viewer".to_string(),
            Some("current workspace".to_string()),
            FG,
            ACCENT_DIM,
        );
        *item_index += 1;
    }

    fn render_sidebar_systems_tab(
        &self,
        lines: &mut Vec<Line<'static>>,
        item_index: &mut usize,
    ) {
        lines.push(sidebar_header("Systems"));
        if let Some(mcp) = &self.state.mcp {
            push_sidebar_selectable_item(
                lines,
                *item_index == self.sidebar_selection,
                if mcp.connected_servers > 0 { "◎" } else { "○" },
                if mcp.connected_servers > 0 { ACCENT } else { ACCENT_DIM },
                format!(
                    "{} / {} connected",
                    format_count(mcp.connected_servers),
                    format_count(mcp.configured_servers)
                ),
                Some(format!("{} tools", format_count(mcp.tool_count))),
                FG,
                ACCENT_DIM,
            );
            *item_index += 1;
        } else {
            push_sidebar_rail_item(
                lines,
                "·",
                ACCENT_DIM,
                "no mcp servers".to_string(),
                None,
                FG,
                ACCENT_DIM,
            );
        }

        if let Some(lsp) = &self.state.lsp {
            push_sidebar_selectable_item(
                lines,
                *item_index == self.sidebar_selection,
                if lsp.connected_servers > 0 { "◎" } else { "○" },
                if lsp.connected_servers > 0 { ACCENT } else { ACCENT_DIM },
                format!(
                    "{} / {} connected",
                    format_count(lsp.connected_servers),
                    format_count(lsp.available_servers)
                ),
                Some(preview_line(&lsp.server_labels.join(" · "), 28)),
                FG,
                ACCENT_DIM,
            );
            *item_index += 1;
        } else {
            push_sidebar_rail_item(
                lines,
                "·",
                ACCENT_DIM,
                "no language servers".to_string(),
                None,
                FG,
                ACCENT_DIM,
            );
        }

    }

    fn sidebar_targets(&self) -> Vec<SidebarTarget> {
        let mut targets = Vec::new();
        targets.extend(
            self.state
                .agent_activities
                .iter()
                .enumerate()
                .take(4)
                .map(|(index, _)| SidebarTarget::Agent(index)),
        );
        targets.extend(
            self.state
                .background_jobs
                .iter()
                .enumerate()
                .take(4)
                .map(|(index, _)| SidebarTarget::Job(index)),
        );
        targets.extend(
            self.state
                .queued_prompts
                .iter()
                .enumerate()
                .take(4)
                .map(|(index, _)| SidebarTarget::Queue(index)),
        );
        targets.extend(
            self.state
                .todos
                .iter()
                .enumerate()
                .take(10)
                .map(|(index, _)| SidebarTarget::Plan(index)),
        );
        targets.push(SidebarTarget::ContextOverview);
        if self.state.request_estimate.is_some() {
            targets.push(SidebarTarget::ContextEstimate);
        }
        if self.state.context_preview.is_some() {
            targets.push(SidebarTarget::ContextPreview);
        }
        targets.push(SidebarTarget::ContextDiff);
        if self.state.mcp.is_some() {
            targets.push(SidebarTarget::McpSummary);
        }
        if self.state.lsp.is_some() {
            targets.push(SidebarTarget::LspSummary);
        }
        targets
    }

    fn clamp_sidebar_selection(&mut self) {
        let total = self.sidebar_targets().len();
        if total == 0 {
            self.sidebar_selection = 0;
        } else if self.sidebar_selection >= total {
            self.sidebar_selection = total - 1;
        }
    }

    fn set_sidebar_tab(&mut self, tab: SidebarTab) {
        self.sidebar_tab = tab;
        self.sidebar_selection = self.section_start_index(tab);
        self.clamp_sidebar_selection();
    }

    fn section_start_index(&self, tab: SidebarTab) -> usize {
        let jobs_len = self.state.agent_activities.iter().take(4).count()
            + self.state.background_jobs.iter().take(4).count()
            + self.state.queued_prompts.iter().take(4).count();
        let plan_len = self.state.todos.iter().take(10).count();
        let context_len = 1
            + usize::from(self.state.request_estimate.is_some())
            + usize::from(self.state.context_preview.is_some())
            + 1;
        match tab {
            SidebarTab::Jobs => 0,
            SidebarTab::Plan => jobs_len,
            SidebarTab::Context => jobs_len + plan_len,
            SidebarTab::Systems => jobs_len + plan_len + context_len,
        }
    }

    fn render_notices(&self, frame: &mut Frame) {
        if self.notices.is_empty() {
            return;
        }

        let width = self
            .notices
            .iter()
            .map(|notice| notice.text.width() + 4)
            .max()
            .unwrap_or(24)
            .min(frame.area().width.saturating_sub(4) as usize) as u16;

        for (index, notice) in self.notices.iter().rev().take(3).enumerate() {
            let area = Rect {
                x: frame.area().right().saturating_sub(width + 2),
                y: frame.area().y + 1 + (index as u16 * 3),
                width,
                height: 3,
            };
            frame.render_widget(Clear, area);
            let color = match notice.tone {
                NoticeTone::Info => ACCENT,
                NoticeTone::Success => SUCCESS,
                NoticeTone::Error => ERROR,
            };
            frame.render_widget(
                Paragraph::new(Text::from(vec![
                    Line::from(Span::styled(
                        preview_line(&notice.text, width.saturating_sub(4) as usize),
                        Style::default().fg(FG),
                    )),
                ]))
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .style(Style::default().bg(BG).fg(color))
                        .border_style(Style::default().fg(color)),
                ),
                area,
            );
        }
    }

    fn render_inspector(&self, frame: &mut Frame, inspector: &InspectorState) {
        let area = centered_rect(72, frame.area().height.saturating_sub(6).min(24), frame.area());
        frame.render_widget(Clear, area);
        let inner = Rect {
            x: area.x + 1,
            y: area.y + 1,
            width: area.width.saturating_sub(2),
            height: area.height.saturating_sub(2),
        };

        let body_height = inner.height.saturating_sub(2) as usize;
        let max_scroll = inspector.body.len().saturating_sub(body_height);
        let scroll = inspector.scroll.min(max_scroll);
        let visible = inspector
            .body
            .iter()
            .skip(scroll)
            .take(body_height)
            .map(|line| render_inspector_line(line, inner.width as usize))
            .collect::<Vec<_>>();

        let footer = inspector
            .footer
            .as_ref()
            .map(|footer| Line::from(Span::styled(footer.clone(), Style::default().fg(ACCENT_DIM))))
            .unwrap_or_else(|| Line::from(Span::raw("")));

        let mut content = vec![Line::from(Span::styled(
            inspector.title.clone(),
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ))];
        content.extend(visible);
        content.push(footer);

        frame.render_widget(
            Paragraph::new(Text::from(content)).block(
                Block::default()
                    .borders(Borders::ALL)
                    .style(Style::default().bg(BG).fg(FG))
                    .border_style(Style::default().fg(ACCENT)),
            ),
            inner,
        );
    }

    fn render_status_line(&self, frame: &mut Frame, area: Rect) {
        let mut spans = Vec::new();

        if self.state.loading {
            let elapsed = format_elapsed(self.state.loading_since);
            spans.push(Span::styled(
                format!("{} ", SPINNER_FRAMES[self.spinner_index]),
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            ));
            spans.push(Span::styled(
                format!("running {elapsed}"),
                Style::default().fg(FG),
            ));
            if !self.state.loading_label.is_empty() {
                spans.push(Span::styled("  ·  ", Style::default().fg(ACCENT_DIM)));
                spans.push(Span::styled(
                    &self.state.loading_label,
                    Style::default().fg(ACCENT_DIM),
                ));
            }
            spans.push(Span::styled("  ·  ", Style::default().fg(ACCENT_DIM)));
            spans.push(Span::styled("Esc interrupt", Style::default().fg(ACCENT_DIM)));
            if !self.state.queued_prompts.is_empty() {
                spans.push(Span::styled("  ·  ", Style::default().fg(ACCENT_DIM)));
                spans.push(Span::styled(
                    format!("queue {}", format_count(self.state.queued_prompts.len() as u64)),
                    Style::default().fg(ACCENT),
                ));
            }
        } else if let Some(prompt) = &self.state.ask_user {
            spans.push(Span::styled(
                "ask",
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            ));
            spans.push(Span::styled("  ", Style::default().fg(ACCENT_DIM)));
            spans.push(Span::styled(&prompt.question, Style::default().fg(FG)));
        } else if let Some(error) = &self.state.error {
            spans.push(Span::styled(error, Style::default().fg(ERROR)));
        } else if !self.state.ready {
            spans.push(Span::styled("booting…", Style::default().fg(ACCENT_DIM)));
        }

        frame.render_widget(
            Paragraph::new(Line::from(spans)).style(Style::default().bg(BG)),
            area,
        );
    }

    fn render_composer(&self, frame: &mut Frame, area: Rect) -> (u16, u16) {
        let divider = Span::styled(
            "─".repeat(area.width as usize),
            Style::default().fg(ACCENT_DIM),
        );
        frame.render_widget(
            Paragraph::new(Line::from(divider)).style(Style::default().bg(BG)),
            Rect {
                x: area.x,
                y: area.y,
                width: area.width,
                height: 1,
            },
        );

        let inner = Rect {
            x: area.x,
            y: area.y + 1,
            width: area.width,
            height: area.height.saturating_sub(1),
        };

        let prompt_prefix = if self.state.ask_user.is_some() {
            "? ".to_string()
        } else {
            "› ".to_string()
        };

        let prompt_style = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
        let content_width = inner.width.saturating_sub(prompt_prefix.width() as u16) as usize;
        let queue_visible = !self.state.queued_prompts.is_empty() && self.state.ask_user.is_none();
        let paste_visible = self.pending_paste.is_some();
        let footer_rows = 1usize;
        let min_editor_rows = if inner.height > 3 { 2usize } else { 1usize };
        let max_queue_rows = if queue_visible {
            self.state
                .queued_prompts
                .len()
                .min((inner.height as usize).saturating_sub(footer_rows + min_editor_rows + usize::from(paste_visible)))
        } else {
            0usize
        };
        let queue_preview_rows = if queue_visible && self.state.queued_prompts.len() > max_queue_rows && max_queue_rows > 0 {
            max_queue_rows.saturating_sub(1)
        } else {
            max_queue_rows
        };
        let metrics = wrap_editor_text(
            &self.composer.text,
            self.composer.cursor,
            content_width.max(1),
        );
        let max_visible = inner
            .height
            .saturating_sub((footer_rows + max_queue_rows + usize::from(paste_visible)) as u16) as usize;
        let start = metrics
            .lines
            .len()
            .saturating_sub(max_visible.max(1))
            .min(metrics.cursor_row);
        let visible_lines = metrics
            .lines
            .iter()
            .skip(start)
            .take(max_visible.max(1))
            .cloned()
            .collect::<Vec<_>>();

        let mut lines = Vec::new();
        if paste_visible {
            let line_count = self
                .pending_paste
                .as_ref()
                .map(|value| value.lines().count().max(1))
                .unwrap_or(1);
            lines.push(Line::from(vec![
                Span::styled("[Paste ", Style::default().fg(ACCENT_DIM)),
                Span::styled(
                    format!("{} Lines", format_count(line_count as u64)),
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                ),
                Span::styled("] Enter insert · Esc cancel", Style::default().fg(ACCENT_DIM)),
            ]));
        }
        if queue_visible && max_queue_rows > 0 {
            for (index, prompt) in self
                .state
                .queued_prompts
                .iter()
                .take(queue_preview_rows)
                .enumerate()
            {
                let marker = format!("{:>2}. ", index + 1);
                let marker_width = marker.width();
                lines.push(Line::from(vec![
                    Span::styled(marker, Style::default().fg(ACCENT_DIM)),
                    Span::styled(
                        preview_line(prompt, content_width.saturating_sub(marker_width)),
                        Style::default().fg(FG),
                    ),
                ]));
            }
            let remaining = self.state.queued_prompts.len().saturating_sub(queue_preview_rows);
            if remaining > 0 {
                lines.push(Line::from(vec![
                    Span::styled("… ", Style::default().fg(ACCENT_DIM)),
                    Span::styled(
                        format!("+{} more queued", format_count(remaining as u64)),
                        Style::default().fg(ACCENT_DIM),
                    ),
                ]));
            }
        }

        if visible_lines.is_empty() {
            lines.push(Line::from(vec![
                Span::styled(prompt_prefix.clone(), prompt_style),
                Span::styled("", Style::default().fg(FG)),
            ]));
        } else {
            for (index, line) in visible_lines.iter().enumerate() {
                let prefix = if index == 0 {
                    prompt_prefix.clone()
                } else {
                    " ".repeat(prompt_prefix.width())
                };
                lines.push(Line::from(vec![
                    Span::styled(prefix, prompt_style),
                    Span::styled(line.clone(), Style::default().fg(FG)),
                ]));
            }
        }

        let mut footer_spans = build_mode_badge_spans(&self.state);
        if let Some(prompt) = &self.state.ask_user {
            if let Some(selected) = prompt.options.get(self.ask_user_selection) {
                footer_spans.push(Span::styled("  ·  ", Style::default().fg(ACCENT_DIM)));
                footer_spans.push(Span::styled(selected.clone(), Style::default().fg(FG)));
            }
        }
        lines.push(Line::from(footer_spans));

        frame.render_widget(
            Paragraph::new(Text::from(lines)).style(Style::default().bg(BG)),
            inner,
        );

        let cursor_x = inner.x + prompt_prefix.width() as u16 + metrics.cursor_col as u16;
        let cursor_y = inner.y
            + max_queue_rows as u16
            + (metrics.cursor_row.saturating_sub(start) as u16);
        (
            cursor_x.min(inner.right().saturating_sub(1)),
            cursor_y.min(inner.bottom().saturating_sub(2)),
        )
    }

    fn render_popup(&self, _frame: &mut Frame, body_area: Rect) -> Option<(Rect, Vec<Suggestion>)> {
        if let Some(palette) = &self.palette {
            let items = self.current_palette_items(&palette.query);
            let _width = items
                .iter()
                .map(|item| item.label.width() + item.description.width() + 6)
                .max()
                .unwrap_or(28)
                .min(body_area.width.saturating_sub(6) as usize) as u16;
            let height = min(items.len().max(1), 10) as u16;
            let area = centered_rect(
                72,
                height.saturating_add(3).min(body_area.height.saturating_sub(1)),
                body_area,
            );
            return Some((
                area,
                items.into_iter()
                    .take(10)
                    .map(|item| Suggestion {
                        kind: SuggestionKind::Slash,
                        value: item.label,
                        description: item.description,
                    })
                    .collect(),
            ));
        }

        let suggestions = self.current_suggestions();
        if suggestions.is_empty() {
            return None;
        }

        let width = suggestions
            .iter()
            .map(|item| item.value.width() + item.description.width() + 6)
            .max()
            .unwrap_or(20)
            .min(body_area.width.saturating_sub(4) as usize) as u16;
        let height = min(suggestions.len(), 8) as u16;
        let area = Rect {
            x: body_area.x + 2,
            y: body_area.bottom().saturating_sub(height + 2),
            width: width + 2,
            height: height + 1,
        };

        Some((area, suggestions.into_iter().take(8).collect()))
    }

    fn current_suggestions(&self) -> Vec<Suggestion> {
        let input = self.composer.trim();
        if input.is_empty() {
            return Vec::new();
        }

        if input == "/mode" || input.starts_with("/mode ") {
            let query = input.strip_prefix("/mode").unwrap_or("").trim();
            let query_lower = query.to_lowercase();
            return self
                .state
                .modes
                .iter()
                .filter(|mode| {
                    query_lower.is_empty()
                        || mode.name.starts_with(&query_lower)
                        || mode.label.to_lowercase().starts_with(&query_lower)
                })
                .map(|mode| Suggestion {
                    kind: SuggestionKind::Mode,
                    value: mode.name.clone(),
                    description: format!("{} · {}", mode.label, mode.tagline),
                })
                .collect();
        }

        if input == "/model" || input.starts_with("/model ") {
            let query = input.strip_prefix("/model").unwrap_or("").trim();
            return self
                .state
                .models
                .iter()
                .filter(|model| query.is_empty() || model.starts_with(query))
                .map(|model| Suggestion {
                    kind: SuggestionKind::Model,
                    value: model.clone(),
                    description: self.state.provider.clone(),
                })
                .collect();
        }

        if !input.starts_with('/') || input.contains(' ') {
            return Vec::new();
        }

        self.state
            .slash_commands
            .iter()
            .filter(|command| command.value.starts_with(&input.to_lowercase()))
            .map(|command| Suggestion {
                kind: SuggestionKind::Slash,
                value: command.value.clone(),
                description: command.description.clone(),
            })
            .collect()
    }

    fn current_palette_items(&self, query: &str) -> Vec<PaletteItem> {
        let q = query.trim().to_lowercase();
        let mut items = Vec::new();

        items.extend(self.state.slash_commands.iter().filter_map(|command| {
            let haystack = format!("{} {}", command.value, command.description).to_lowercase();
            if !q.is_empty() && !haystack.contains(&q) {
                return None;
            }
            Some(PaletteItem {
                label: command.value.clone(),
                description: command.description.clone(),
                action: PaletteAction::InsertSlash(command.value.clone()),
            })
        }));

        for tab in SidebarTab::all() {
            let label = format!("Jump to {} section", tab.label());
            if q.is_empty() || label.to_lowercase().contains(&q) {
                items.push(PaletteItem {
                    label,
                    description: "sidebar".to_string(),
                    action: PaletteAction::SwitchTab(tab),
                });
            }
        }

        if q.is_empty() || "context inspector".contains(&q) {
            items.push(PaletteItem {
                label: "Open context inspector".to_string(),
                description: "context".to_string(),
                action: PaletteAction::OpenContext,
            });
        }

        if q.is_empty() || "diff viewer".contains(&q) {
            items.push(PaletteItem {
                label: "Open diff viewer".to_string(),
                description: "workspace".to_string(),
                action: PaletteAction::OpenDiff(None),
            });
        }

        if q.is_empty()
            || "resume session".contains(&q)
            || "saved session".contains(&q)
            || "/session pick".contains(&q)
        {
            items.push(PaletteItem {
                label: "Resume saved session".to_string(),
                description: "sessions".to_string(),
                action: PaletteAction::InsertSlash("/session pick".to_string()),
            });
        }

        for (index, job) in self.state.background_jobs.iter().enumerate().take(6) {
            let label = format!("Inspect job · {}", preview_line(&job.label, 28));
            if q.is_empty() || label.to_lowercase().contains(&q) {
                items.push(PaletteItem {
                    label,
                    description: job.status.clone(),
                    action: PaletteAction::OpenTarget(SidebarTarget::Job(index)),
                });
            }
        }

        for (index, prompt) in self.state.queued_prompts.iter().enumerate().take(6) {
            let label = format!("Inspect queue {} · {}", index + 1, preview_line(prompt, 28));
            if q.is_empty() || label.to_lowercase().contains(&q) {
                items.push(PaletteItem {
                    label,
                    description: "queued prompt".to_string(),
                    action: PaletteAction::OpenTarget(SidebarTarget::Queue(index)),
                });
            }
        }

        items
    }

    fn handle_event(&mut self, event: Event) -> Result<()> {
        match event {
            Event::Key(key) => self.handle_key(key),
            Event::Mouse(mouse) => {
                match mouse.kind {
                    MouseEventKind::ScrollUp => {
                        self.auto_scroll = false;
                        self.scroll = self.scroll.saturating_sub(3);
                    }
                    MouseEventKind::ScrollDown => {
                        self.auto_scroll = false;
                        self.scroll = self.scroll.saturating_add(3);
                    }
                    _ => {}
                }
                Ok(())
            }
            Event::Paste(text) => {
                if text.contains('\n') || text.contains('\r') {
                    self.pending_paste = Some(text);
                    let line_count = self
                        .pending_paste
                        .as_ref()
                        .map(|value| value.lines().count().max(1))
                        .unwrap_or(1);
                    self.push_notice(
                        format!("paste held · {} lines", format_count(line_count as u64)),
                        NoticeTone::Info,
                    );
                } else {
                    self.composer.insert_text(&text);
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> Result<()> {
        let suggestions = self.current_suggestions();
        let popup_visible = self.palette.is_some() || !suggestions.is_empty();
        let composer_empty = self.composer.trim().is_empty();

        if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('c') {
            if self.state.loading {
                self.bridge.send(BridgeCommand::Abort)?;
            } else {
                self.should_quit = true;
            }
            return Ok(());
        }

        if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('k') {
            if self.palette.is_some() {
                self.palette = None;
            } else {
                self.palette = Some(PaletteState {
                    query: String::new(),
                    selected: 0,
                });
                self.inspector = None;
            }
            return Ok(());
        }

        if self.inspector.is_some() {
            return self.handle_inspector_key(key);
        }

        if self.palette.is_some() {
            return self.handle_palette_key(key);
        }

        if self.pending_paste.is_some() {
            match key.code {
                KeyCode::Enter => {
                    if let Some(paste) = self.pending_paste.take() {
                        self.composer.insert_text(&paste);
                    }
                    return Ok(());
                }
                KeyCode::Esc => {
                    self.pending_paste = None;
                    return Ok(());
                }
                _ => return Ok(()),
            }
        }

        if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('l') {
            self.bridge.send(BridgeCommand::ClearMessages)?;
            return Ok(());
        }

        if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('y') {
            self.execute_slash_command("/session pick")?;
            self.push_notice("session picker".to_string(), NoticeTone::Info);
            return Ok(());
        }

        if key.code == KeyCode::BackTab {
            self.bridge
                .send(BridgeCommand::CycleMode { direction: 1 })?;
            return Ok(());
        }

        if key.code == KeyCode::Esc {
            if self.state.loading {
                self.bridge.send(BridgeCommand::Abort)?;
            } else {
                self.composer.clear();
                self.selected_suggestion = 0;
            }
            return Ok(());
        }

        if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('j') {
            self.composer.insert_text("\n");
            return Ok(());
        }

        if key.code == KeyCode::Enter && key.modifiers.contains(KeyModifiers::SHIFT) {
            self.composer.insert_text("\n");
            return Ok(());
        }

        if let Some(prompt) = &self.state.ask_user {
            if matches!(key.code, KeyCode::Up)
                && composer_empty
                && !prompt.options.is_empty()
            {
                if self.ask_user_selection > 0 {
                    self.ask_user_selection -= 1;
                }
                return Ok(());
            }

            if matches!(key.code, KeyCode::Down)
                && composer_empty
                && !prompt.options.is_empty()
            {
                if self.ask_user_selection + 1 < prompt.options.len() {
                    self.ask_user_selection += 1;
                }
                return Ok(());
            }
        }

        if !popup_visible && self.state.ask_user.is_none() && composer_empty {
            match key.code {
                KeyCode::Up => {
                    self.auto_scroll = false;
                    self.scroll = self.scroll.saturating_sub(1);
                    return Ok(());
                }
                KeyCode::Down => {
                    self.auto_scroll = false;
                    self.scroll = self.scroll.saturating_add(1);
                    return Ok(());
                }
                _ => {}
            }
        }

        if popup_visible && key.code == KeyCode::Up {
            if self.selected_suggestion > 0 {
                self.selected_suggestion -= 1;
            }
            return Ok(());
        }

        if popup_visible && key.code == KeyCode::Down {
            if self.selected_suggestion + 1 < suggestions.len() {
                self.selected_suggestion += 1;
            }
            return Ok(());
        }

        match key.code {
            KeyCode::Enter => self.submit_or_accept(popup_visible, &suggestions),
            KeyCode::Tab => {
                if popup_visible {
                    self.accept_suggestion(&suggestions)?;
                } else {
                    self.composer.insert_text("  ");
                }
                Ok(())
            }
            KeyCode::Backspace => {
                self.composer.backspace();
                self.selected_suggestion = 0;
                Ok(())
            }
            KeyCode::Delete => {
                self.composer.delete();
                self.selected_suggestion = 0;
                Ok(())
            }
            KeyCode::Left => {
                self.composer.move_left();
                Ok(())
            }
            KeyCode::Right => {
                self.composer.move_right();
                Ok(())
            }
            KeyCode::Home => {
                self.composer.move_home();
                Ok(())
            }
            KeyCode::End => {
                self.composer.move_end();
                self.auto_scroll = true;
                Ok(())
            }
            KeyCode::PageUp => {
                self.auto_scroll = false;
                self.scroll = self.scroll.saturating_sub(10);
                Ok(())
            }
            KeyCode::PageDown => {
                self.auto_scroll = false;
                self.scroll = self.scroll.saturating_add(10);
                Ok(())
            }
            KeyCode::Char(ch) => {
                if key.modifiers.contains(KeyModifiers::CONTROL) {
                    return Ok(());
                }
                self.composer.insert_text(&ch.to_string());
                self.selected_suggestion = 0;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn submit_or_accept(&mut self, popup_visible: bool, suggestions: &[Suggestion]) -> Result<()> {
        if popup_visible {
            let input = self.composer.trim();
            if suggestions
                .get(self.selected_suggestion)
                .map(|suggestion| {
                    matches!(suggestion.kind, SuggestionKind::Slash)
                        && (input != suggestion.value
                            || suggestion.value == "/mode"
                            || suggestion.value == "/model")
                })
                .unwrap_or(false)
            {
                self.accept_suggestion(suggestions)?;
                return Ok(());
            }

            if suggestions
                .get(self.selected_suggestion)
                .map(|suggestion| {
                    matches!(
                        suggestion.kind,
                        SuggestionKind::Mode | SuggestionKind::Model
                    )
                })
                .unwrap_or(false)
            {
                self.accept_suggestion(suggestions)?;
                return Ok(());
            }
        }

        let trimmed = self.composer.trim();
        if trimmed.is_empty() {
            if let Some(prompt) = &self.state.ask_user {
                if let Some(choice) = prompt.options.get(self.ask_user_selection) {
                    self.bridge.send(BridgeCommand::AnswerAskUser {
                        answer: choice.clone(),
                    })?;
                }
            }
            self.composer.clear();
            return Ok(());
        }

        if self.state.ask_user.is_some() {
            self.bridge.send(BridgeCommand::AnswerAskUser {
                answer: trimmed.clone(),
            })?;
            self.composer.clear();
            return Ok(());
        }

        if trimmed.starts_with('/') {
            self.execute_slash_command(&trimmed)?;
            self.composer.clear();
            return Ok(());
        }

        self.bridge.send(BridgeCommand::Submit {
            content: trimmed.clone(),
        })?;
        self.composer.clear();
        self.auto_scroll = true;
        Ok(())
    }

    fn accept_suggestion(&mut self, suggestions: &[Suggestion]) -> Result<()> {
        let Some(selected) = suggestions.get(self.selected_suggestion).cloned() else {
            return Ok(());
        };

        match selected.kind {
            SuggestionKind::Slash => {
                if selected.value == "/mode" || selected.value == "/model" {
                    self.composer.set_text(format!("{} ", selected.value));
                } else {
                    self.composer.set_text(selected.value);
                }
            }
            SuggestionKind::Mode => {
                self.bridge.send(BridgeCommand::SetMode {
                    mode: selected.value,
                })?;
                self.composer.clear();
            }
            SuggestionKind::Model => {
                self.bridge.send(BridgeCommand::SetModel {
                    model: selected.value,
                })?;
                self.composer.clear();
            }
        }

        self.selected_suggestion = 0;
        Ok(())
    }

    fn execute_slash_command(&mut self, command: &str) -> Result<()> {
        if matches!(command.trim(), "/quit" | "/exit") {
            self.should_quit = true;
            return Ok(());
        }

        self.bridge.send(BridgeCommand::RunSlash {
            command: command.to_string(),
        })?;

        Ok(())
    }

    fn handle_palette_key(&mut self, key: KeyEvent) -> Result<()> {
        let mut apply: Option<PaletteAction> = None;
        let Some((mut query, mut selected)) = self
            .palette
            .as_ref()
            .map(|palette| (palette.query.clone(), palette.selected))
        else {
            return Ok(());
        };

        match key.code {
            KeyCode::Esc => {
                self.palette = None;
                return Ok(());
            }
            KeyCode::Up => {
                selected = selected.saturating_sub(1);
            }
            KeyCode::Down => {
                let len = self.current_palette_items(&query).len();
                if selected + 1 < len {
                    selected += 1;
                }
            }
            KeyCode::Backspace => {
                query.pop();
                selected = 0;
            }
            KeyCode::Enter => {
                let items = self.current_palette_items(&query);
                if let Some(item) = items.get(selected) {
                    apply = Some(item.action.clone());
                }
            }
            KeyCode::Char(ch) => {
                if !key.modifiers.contains(KeyModifiers::CONTROL) {
                    query.push(ch);
                    selected = 0;
                }
            }
            _ => return Ok(()),
        }

        if let Some(palette) = &mut self.palette {
            palette.query = query;
            palette.selected = selected;
        }

        if let Some(action) = apply {
            self.palette = None;
            self.execute_palette_action(action)?;
        }

        Ok(())
    }

    fn execute_palette_action(&mut self, action: PaletteAction) -> Result<()> {
        match action {
            PaletteAction::InsertSlash(command) => {
                self.composer.set_text(command);
                self.selected_suggestion = 0;
            }
            PaletteAction::SwitchTab(tab) => self.set_sidebar_tab(tab),
            PaletteAction::OpenTarget(target) => self.open_sidebar_target(target)?,
            PaletteAction::OpenContext => self.open_context_inspector(),
            PaletteAction::OpenDiff(cwd) => self.open_diff_viewer(cwd, "Workspace Diff".to_string())?,
        }
        Ok(())
    }

    fn handle_inspector_key(&mut self, key: KeyEvent) -> Result<()> {
        let mut close = false;
        let mut open_diff: Option<(Option<String>, String)> = None;
        let mut run_command: Option<String> = None;

        if let Some(inspector) = &mut self.inspector {
            match key.code {
                KeyCode::Esc => close = true,
                KeyCode::Up => {
                    inspector.scroll = inspector.scroll.saturating_sub(1);
                }
                KeyCode::Down => {
                    inspector.scroll = inspector.scroll.saturating_add(1);
                }
                KeyCode::PageUp => {
                    inspector.scroll = inspector.scroll.saturating_sub(8);
                }
                KeyCode::PageDown => {
                    inspector.scroll = inspector.scroll.saturating_add(8);
                }
                KeyCode::Char('v') => match &inspector.kind {
                    InspectorKind::Job(job_id) => {
                        if let Some(job) = self.state.background_jobs.iter().find(|item| item.id == *job_id) {
                            open_diff = Some((
                                job.workspace_path.clone(),
                                format!("Job Diff · {}", preview_line(&job.label, 24)),
                            ));
                        }
                    }
                    InspectorKind::Diff { .. } => close = true,
                    _ => {
                        open_diff = Some((None, "Workspace Diff".to_string()));
                    }
                },
                KeyCode::Char('r') => match &inspector.kind {
                    InspectorKind::Job(job_id) => {
                        run_command = Some(format!("/jobs retry {}", short_job_ref(job_id)));
                    }
                    InspectorKind::Queue(index) => {
                        run_command = Some(format!("/queue run {}", index + 1));
                    }
                    _ => {}
                },
                KeyCode::Char('p') => match &inspector.kind {
                    InspectorKind::Job(job_id) => {
                        run_command = Some(format!("/jobs promote {}", short_job_ref(job_id)));
                    }
                    InspectorKind::Queue(index) => {
                        run_command = Some(format!("/queue promote {}", index + 1));
                    }
                    _ => {}
                },
                KeyCode::Char('d') => {
                    if let InspectorKind::Queue(index) = &inspector.kind {
                        run_command = Some(format!("/queue drop {}", index + 1));
                    }
                }
                KeyCode::Char('c') => {
                    if let InspectorKind::Job(job_id) = &inspector.kind {
                        run_command = Some(format!("/jobs cancel {}", short_job_ref(job_id)));
                    }
                }
                KeyCode::Char('l') => {
                    if let InspectorKind::Job(job_id) = &inspector.kind {
                        run_command = Some(format!("/jobs logs {}", short_job_ref(job_id)));
                    }
                }
                KeyCode::Char('o') => {
                    if let InspectorKind::Job(job_id) = &inspector.kind {
                        run_command = Some(format!("/jobs result {}", short_job_ref(job_id)));
                    }
                }
                _ => {}
            }
        }

        if let Some(command) = run_command {
            self.execute_slash_command(&command)?;
            self.push_notice(command, NoticeTone::Info);
        }
        if let Some((cwd, title)) = open_diff {
            self.open_diff_viewer(cwd, title)?;
        }
        if close {
            self.inspector = None;
        }

        Ok(())
    }

    fn open_sidebar_target(&mut self, target: SidebarTarget) -> Result<()> {
        let inspector = match target {
            SidebarTarget::Agent(index) => self.build_agent_inspector(index),
            SidebarTarget::Job(index) => self.build_job_inspector(index),
            SidebarTarget::Queue(index) => self.build_queue_inspector(index),
            SidebarTarget::Plan(index) => self.build_plan_inspector(index),
            SidebarTarget::ContextOverview
            | SidebarTarget::ContextEstimate
            | SidebarTarget::ContextPreview => Some(self.build_context_inspector()),
            SidebarTarget::ContextDiff => {
                self.open_diff_viewer(None, "Workspace Diff".to_string())?;
                return Ok(());
            }
            SidebarTarget::McpSummary => self.build_mcp_summary_inspector(),
            SidebarTarget::LspSummary => self.build_lsp_summary_inspector(),
        };
        self.inspector = inspector;
        Ok(())
    }

    fn open_context_inspector(&mut self) {
        self.inspector = Some(self.build_context_inspector());
    }

    fn open_diff_viewer(&mut self, cwd: Option<String>, title: String) -> Result<()> {
        let target_cwd = cwd.unwrap_or_else(|| self.state.cwd.clone());
        let body = load_git_diff(&target_cwd)
            .with_context(|| format!("failed to load git diff for {target_cwd}"))?;
        if body.trim().is_empty() {
            self.push_notice("no diff to show".to_string(), NoticeTone::Info);
            return Ok(());
        }

        self.inspector = Some(InspectorState {
            title,
            body: body.lines().map(|line| line.to_string()).collect(),
            footer: Some("Esc close · ↑↓ scroll · v close".to_string()),
            scroll: 0,
            kind: InspectorKind::Diff {
                title: "Workspace Diff".to_string(),
                cwd: Some(target_cwd),
            },
        });
        Ok(())
    }

    fn build_agent_inspector(&self, index: usize) -> Option<InspectorState> {
        let item = self.state.agent_activities.get(index)?;
        Some(InspectorState {
            title: format!("Subagent · {}", item.label),
            body: vec![
                format!("status: {}", item.status),
                format!(
                    "mode: {}",
                    item.mode
                        .as_ref()
                        .map(|mode| title_case_label(mode))
                        .unwrap_or_else(|| "n/a".to_string())
                ),
                format!("purpose: {}", item.purpose.clone().unwrap_or_else(|| "general".to_string())),
                format!("updated: {}", item.updated_at),
                item.detail.clone().unwrap_or_else(|| "detail: n/a".to_string()),
                item.workspace_path
                    .as_ref()
                    .map(|path| format!("workspace: {path}"))
                    .unwrap_or_else(|| "workspace: n/a".to_string()),
            ],
            footer: Some("Esc close".to_string()),
            scroll: 0,
            kind: InspectorKind::Agent(index),
        })
    }

    fn build_job_inspector(&self, index: usize) -> Option<InspectorState> {
        let job = self.state.background_jobs.get(index)?;
        Some(InspectorState {
            title: format!("Job · {}", job.label),
            body: vec![
                format!("status: {}", job.status),
                format!("kind: {}", job.kind),
                format!("attempt: {}", format_count(job.attempt.unwrap_or(0))),
                format!(
                    "mode: {}",
                    job.preferred_mode
                        .as_ref()
                        .map(|mode| title_case_label(mode))
                        .unwrap_or_else(|| "n/a".to_string())
                ),
                format!("purpose: {}", job.purpose.clone().unwrap_or_else(|| "general".to_string())),
                format!("started: {}", job.started_at),
                format!("updated: {}", job.updated_at),
                job.detail
                    .as_ref()
                    .map(|detail| format!("detail: {detail}"))
                    .unwrap_or_else(|| "detail: n/a".to_string()),
                job.result_preview
                    .as_ref()
                    .map(|detail| format!("result: {detail}"))
                    .unwrap_or_else(|| "result: n/a".to_string()),
                job.workspace_path
                    .as_ref()
                    .map(|path| format!("workspace: {path}"))
                    .unwrap_or_else(|| "workspace: n/a".to_string()),
            ],
            footer: Some("r retry · p promote · c cancel · l logs · o result · v diff · Esc close".to_string()),
            scroll: 0,
            kind: InspectorKind::Job(job.id.clone()),
        })
    }

    fn build_queue_inspector(&self, index: usize) -> Option<InspectorState> {
        let prompt = self.state.queued_prompts.get(index)?;
        Some(InspectorState {
            title: format!("Queue {}", index + 1),
            body: vec![
                "queued prompt".to_string(),
                String::new(),
                prompt.clone(),
            ],
            footer: Some("r run · p promote · d drop · Esc close".to_string()),
            scroll: 0,
            kind: InspectorKind::Queue(index),
        })
    }

    fn build_plan_inspector(&self, index: usize) -> Option<InspectorState> {
        let item = self.state.todos.get(index)?;
        Some(InspectorState {
            title: format!("Plan {}", index + 1),
            body: vec![
                format!("status: {}", item.status),
                format!("step: {}", item.step),
                format!("owner: {}", item.owner.clone().unwrap_or_else(|| "n/a".to_string())),
                format!("id: {}", item.id),
                format!("updated: {}", item.updated_at),
            ],
            footer: Some("Esc close".to_string()),
            scroll: 0,
            kind: InspectorKind::Plan(index),
        })
    }

    fn build_context_inspector(&self) -> InspectorState {
        let mut body = vec![
            format!("mode: {}", self.current_mode_label()),
            format!("provider: {}", self.state.provider),
            format!("model: {}", display_model_name(&self.state.model)),
            format!("permission: {}", self.state.permission_profile),
            format!(
                "footprint: {:>5.1}% · {} / {}",
                self.state.context_percent * 100.0,
                format_count(self.state.context_tokens),
                format_count(self.state.context_limit)
            ),
        ];
        if let Some(estimate) = &self.state.request_estimate {
            body.push(String::new());
            body.push(format!("request mode: {}", estimate.mode));
            body.push(format!(
                "system {} · history {} · tools {} · prompt {} · total {}",
                format_count(estimate.system),
                format_count(estimate.history),
                format_count(estimate.tools),
                format_count(estimate.prompt),
                format_count(estimate.total),
            ));
        }
        if let Some(preview) = &self.state.context_preview {
            body.push(String::new());
            body.push("context preview".to_string());
            body.extend(preview.lines().map(|line| line.to_string()));
        }
        InspectorState {
            title: "Context Inspector".to_string(),
            body,
            footer: Some("v diff viewer · Esc close".to_string()),
            scroll: 0,
            kind: InspectorKind::Context,
        }
    }

    fn build_mcp_summary_inspector(&self) -> Option<InspectorState> {
        let mcp = self.state.mcp.as_ref()?;
        Some(InspectorState {
            title: "MCP".to_string(),
            body: vec![
                format!("configured: {}", format_count(mcp.configured_servers)),
                format!("connected: {}", format_count(mcp.connected_servers)),
                format!("tools: {}", format_count(mcp.tool_count)),
                String::new(),
                format!("servers: {}", mcp.server_names.join(", ")),
            ],
            footer: Some("Esc close".to_string()),
            scroll: 0,
            kind: InspectorKind::McpSummary,
        })
    }

    fn build_mcp_server_inspector(&self, index: usize) -> Option<InspectorState> {
        let mcp = self.state.mcp.as_ref()?;
        let server = mcp.server_names.get(index)?;
        let connected = mcp.connected_names.iter().any(|name| name == server);
        Some(InspectorState {
            title: format!("MCP Server · {server}"),
            body: vec![
                format!("status: {}", if connected { "connected" } else { "configured" }),
                format!("server: {server}"),
            ],
            footer: Some("Esc close".to_string()),
            scroll: 0,
            kind: InspectorKind::McpServer(index),
        })
    }

    fn build_lsp_summary_inspector(&self) -> Option<InspectorState> {
        let lsp = self.state.lsp.as_ref()?;
        Some(InspectorState {
            title: "LSP".to_string(),
            body: vec![
                format!("available: {}", format_count(lsp.available_servers)),
                format!("connected: {}", format_count(lsp.connected_servers)),
                String::new(),
                format!("servers: {}", lsp.server_labels.join(", ")),
            ],
            footer: Some("Esc close".to_string()),
            scroll: 0,
            kind: InspectorKind::LspSummary,
        })
    }

    fn build_lsp_server_inspector(&self, index: usize) -> Option<InspectorState> {
        let lsp = self.state.lsp.as_ref()?;
        let server = lsp.server_labels.get(index)?;
        let connected = lsp.connected_labels.iter().any(|item| item == server);
        Some(InspectorState {
            title: format!("LSP Server · {server}"),
            body: vec![
                format!("status: {}", if connected { "connected" } else { "available" }),
                format!("server: {server}"),
            ],
            footer: Some("Esc close".to_string()),
            scroll: 0,
            kind: InspectorKind::LspServer(index),
        })
    }

    fn build_tool_inspector(&self, message_index: usize, tool_index: usize) -> Option<InspectorState> {
        let tool = self.state.messages.get(message_index)?.tool_calls.get(tool_index)?;
        let mut body = vec![
            format!("status: {}", tool.status),
            format!("tool: {}", tool.name),
            format!("summary: {}", tool.summary),
        ];
        if !tool.args.trim().is_empty() {
            body.push(String::new());
            body.push("args".to_string());
            body.extend(tool.args.lines().map(|line| line.to_string()));
        }
        if let Some(result) = &tool.result {
            body.push(String::new());
            body.push("result".to_string());
            body.extend(result.lines().map(|line| line.to_string()));
        }
        Some(InspectorState {
            title: format!("Tool · {}", tool.name),
            body,
            footer: Some("Esc close".to_string()),
            scroll: 0,
            kind: InspectorKind::Tool(message_index, tool_index),
        })
    }

    fn refresh_open_inspector(&mut self) {
        let Some(existing) = &self.inspector else {
            return;
        };
        let scroll = existing.scroll;
        let replacement = match existing.kind.clone() {
            InspectorKind::Agent(index) => self.build_agent_inspector(index),
            InspectorKind::Job(job_id) => self
                .state
                .background_jobs
                .iter()
                .position(|job| job.id == job_id)
                .and_then(|index| self.build_job_inspector(index)),
            InspectorKind::Queue(index) => self.build_queue_inspector(index),
            InspectorKind::Plan(index) => self.build_plan_inspector(index),
            InspectorKind::Context => Some(self.build_context_inspector()),
            InspectorKind::McpSummary => self.build_mcp_summary_inspector(),
            InspectorKind::McpServer(index) => self.build_mcp_server_inspector(index),
            InspectorKind::LspSummary => self.build_lsp_summary_inspector(),
            InspectorKind::LspServer(index) => self.build_lsp_server_inspector(index),
            InspectorKind::Tool(message_index, tool_index) => {
                self.build_tool_inspector(message_index, tool_index)
            }
            InspectorKind::Diff { title, cwd } => {
                let body = cwd
                    .as_ref()
                    .and_then(|path| load_git_diff(path).ok())
                    .unwrap_or_default();
                Some(InspectorState {
                    title,
                    body: body.lines().map(|line| line.to_string()).collect(),
                    footer: Some("Esc close · ↑↓ scroll · v close".to_string()),
                    scroll,
                    kind: InspectorKind::Diff { title: "Workspace Diff".to_string(), cwd },
                })
            }
        };

        self.inspector = replacement.map(|mut inspector| {
            inspector.scroll = scroll;
            inspector
        });
    }
}

struct WrappedEditor {
    lines: Vec<String>,
    cursor_row: usize,
    cursor_col: usize,
}

fn wrap_editor_text(text: &str, cursor: usize, width: usize) -> WrappedEditor {
    let graphemes: Vec<String> = UnicodeSegmentation::graphemes(text, true)
        .map(|g| g.to_string())
        .collect();
    let width = width.max(1);
    let mut lines = vec![String::new()];
    let mut row = 0usize;
    let mut col = 0usize;
    let mut cursor_row = 0usize;
    let mut cursor_col = 0usize;

    for (index, grapheme) in graphemes.iter().enumerate() {
        if index == cursor {
            cursor_row = row;
            cursor_col = col;
        }

        if grapheme == "\n" {
            lines.push(String::new());
            row += 1;
            col = 0;
            continue;
        }

        let grapheme_width = UnicodeWidthStr::width(grapheme.as_str()).max(1);
        if col + grapheme_width > width && !lines[row].is_empty() {
            lines.push(String::new());
            row += 1;
            col = 0;
        }

        lines[row].push_str(grapheme);
        col += grapheme_width;
    }

    if cursor == graphemes.len() {
        cursor_row = row;
        cursor_col = col;
    }

    WrappedEditor {
        lines,
        cursor_row,
        cursor_col,
    }
}

fn wrap_plain(text: &str, width: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }

    let width = width.max(1);
    let graphemes: Vec<&str> = UnicodeSegmentation::graphemes(text, true).collect();
    let mut lines = vec![String::new()];
    let mut current_width = 0usize;

    for grapheme in graphemes {
        if grapheme == "\n" {
            lines.push(String::new());
            current_width = 0;
            continue;
        }

        let grapheme_width = UnicodeWidthStr::width(grapheme).max(1);
        if current_width + grapheme_width > width && !lines.last().unwrap().is_empty() {
            lines.push(String::new());
            current_width = 0;
        }

        lines.last_mut().unwrap().push_str(grapheme);
        current_width += grapheme_width;
    }

    lines
}

fn pad_art_lines(lines: &[&str]) -> Vec<String> {
    let max_width = lines
        .iter()
        .map(|line| UnicodeWidthStr::width(*line))
        .max()
        .unwrap_or(0);

    lines.iter()
        .map(|line| {
            let pad = max_width.saturating_sub(UnicodeWidthStr::width(*line));
            format!("{line}{}", " ".repeat(pad))
        })
        .collect()
}

fn shimmer_centered_line(
    line: &str,
    width: usize,
    phase: usize,
    offset: usize,
    base: Color,
    highlight: Color,
) -> Line<'static> {
    let mut spans = Vec::new();
    let content_width = UnicodeWidthStr::width(line);
    let left_pad = width.saturating_sub(content_width) / 2;
    if left_pad > 0 {
        spans.push(Span::raw(" ".repeat(left_pad)));
    }

    let graphemes = UnicodeSegmentation::graphemes(line, true).collect::<Vec<_>>();
    let cycle_width = graphemes.len().saturating_add(10).max(1);
    let sweep = ((phase + offset * 4) % cycle_width) as isize - 5;
    for (index, grapheme) in graphemes.iter().enumerate() {
        let distance = (index as isize - sweep).abs();
        let style = if distance <= 1 {
            Style::default()
                .fg(highlight)
                .add_modifier(Modifier::BOLD)
        } else if distance <= 4 {
            Style::default().fg(base).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(ACCENT_DIM)
        };
        spans.push(Span::styled((*grapheme).to_string(), style));
    }

    Line::from(spans)
}

fn build_welcome_lines(width: usize, phase: usize) -> Vec<Line<'static>> {
    let art = if width < 64 {
        Vec::new()
    } else if width < 100 {
        pad_art_lines(SPLASH_COMPACT)
    } else {
        pad_art_lines(SPLASH_FULL)
    };

    let mut lines = Vec::new();
    lines.push(Line::from(Span::raw("")));
    lines.push(Line::from(Span::raw("")));
    for (index, line) in art.into_iter().enumerate() {
        lines.push(shimmer_centered_line(
            &line,
            width,
            phase,
            index,
            ACCENT,
            FG,
        ));
    }

    if !lines.is_empty() {
        lines.push(Line::from(Span::raw("")));
    }
    lines.push(shimmer_centered_line(
        "BL4CKP1NK 1N Y0UR AREA",
        width,
        phase + 6,
        0,
        ACCENT,
        FG,
    ));
    lines.push(Line::from(Span::raw("")));
    lines
}

fn preview_line(text: &str, max_width: usize) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max_width {
        return normalized;
    }

    normalized.chars().take(max_width.saturating_sub(1)).collect::<String>() + "…"
}

fn format_count(value: u64) -> String {
    let raw = value.to_string();
    let mut out = String::with_capacity(raw.len() + raw.len() / 3);

    for (index, ch) in raw.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }

    out.chars().rev().collect()
}

fn checklist_progress(checklist: &[NativeJobChecklistItem]) -> Option<String> {
    if checklist.is_empty() {
        return None;
    }

    let total = checklist.len();
    let completed = checklist.iter().filter(|item| item.status == "completed").count();
    let active = checklist.iter().filter(|item| item.status == "in_progress").count();
    let blocked = checklist.iter().filter(|item| item.status == "error").count();

    let summary = [
        Some(format!("{completed}/{total} done")),
        (active > 0).then(|| format!("{active} active")),
        (blocked > 0).then(|| format!("{blocked} blocked")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");

    Some(summary)
}

fn title_case_label(value: &str) -> String {
    let lower = value.trim().to_lowercase();
    let mut chars = lower.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };

    format!("{}{}", first.to_uppercase(), chars.collect::<String>())
}

fn display_model_name(model: &str) -> String {
    if let Some(version) = model.strip_prefix("claude-opus-") {
        return format!("Opus {}", version.replace('-', "."));
    }

    if let Some(version) = model.strip_prefix("claude-sonnet-") {
        return format!("Sonnet {}", version.replace('-', "."));
    }

    if let Some(version) = model.strip_prefix("claude-haiku-") {
        return format!("Haiku {}", version.replace('-', "."));
    }

    if let Some(version) = model.strip_prefix("gpt-") {
        return format!("GPT-{}", version);
    }

    if let Some(version) = model.strip_prefix("gemini-") {
        let pretty = version
            .split('-')
            .map(|segment| match segment {
                "pro" => "Pro".to_string(),
                "flash" => "Flash".to_string(),
                value => value.to_string(),
            })
            .collect::<Vec<_>>()
            .join(" ");
        return format!("Gemini {}", pretty);
    }

    model.to_string()
}

fn build_mode_badge_spans(state: &NativeTuiState) -> Vec<Span<'static>> {
    if let Some(mode) = state.modes.iter().find(|mode| mode.active) {
        return vec![
            Span::styled("● ", Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)),
            Span::styled(
                title_case_label(&mode.label),
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            ),
            Span::styled(" (", Style::default().fg(ACCENT_DIM)),
            Span::styled(mode.tagline.clone(), Style::default().fg(FG)),
            Span::styled(" - ", Style::default().fg(ACCENT_DIM)),
            Span::styled(display_model_name(&mode.model), Style::default().fg(ACCENT_DIM)),
            Span::styled(")", Style::default().fg(ACCENT_DIM)),
        ];
    }

    vec![Span::styled(
        format!(
            "● {} ({})",
            title_case_label(&state.mode),
            display_model_name(&state.model)
        ),
        Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
    )]
}

fn sidebar_header(title: &str) -> Line<'static> {
    Line::from(vec![
        Span::styled("• ", Style::default().fg(ACCENT)),
        Span::styled(
            title.to_string(),
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ),
    ])
}

fn push_sidebar_rail_item(
    lines: &mut Vec<Line<'static>>,
    marker: &str,
    marker_color: Color,
    title: String,
    detail: Option<String>,
    title_color: Color,
    detail_color: Color,
) {
    lines.push(Line::from(vec![
        Span::styled(format!("{marker} "), Style::default().fg(marker_color)),
        Span::styled(title, Style::default().fg(title_color)),
    ]));

    if let Some(detail) = detail {
        lines.push(Line::from(vec![
            Span::styled("│ ", Style::default().fg(marker_color)),
            Span::styled(detail, Style::default().fg(detail_color)),
        ]));
    }
}

fn push_sidebar_selectable_item(
    lines: &mut Vec<Line<'static>>,
    _selected: bool,
    marker: &str,
    marker_color: Color,
    title: String,
    detail: Option<String>,
    title_color: Color,
    detail_color: Color,
) {
    let selected_style = Style::default();
    lines.push(Line::from(vec![
        Span::styled(
            format!("{marker} "),
            selected_style.fg(marker_color),
        ),
        Span::styled(title, selected_style.fg(title_color)),
    ]));

    if let Some(detail) = detail {
        lines.push(Line::from(vec![
            Span::styled("│ ", selected_style.fg(marker_color)),
            Span::styled(detail, selected_style.fg(detail_color)),
        ]));
    }
}

fn render_inspector_line(raw: &str, width: usize) -> Line<'static> {
    let style = if raw.starts_with("+++") || raw.starts_with("---") || raw.starts_with("@@") {
        Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
    } else if raw.starts_with('+') {
        Style::default().fg(SUCCESS)
    } else if raw.starts_with('-') {
        Style::default().fg(ERROR)
    } else if raw.ends_with(':') {
        Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(FG)
    };

    Line::from(Span::styled(
        preview_line(raw, width.max(1)),
        style,
    ))
}

fn context_meter(percent: f64, width: usize) -> String {
    let width = width.max(4);
    let filled = ((percent.clamp(0.0, 1.0)) * width as f64).round() as usize;
    let filled = filled.min(width);
    format!("{}{}", "■".repeat(filled), "·".repeat(width.saturating_sub(filled)))
}

fn looks_like_path_token(token: &str) -> bool {
    let trimmed = token.trim_matches(|ch: char| {
        matches!(ch, '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | ':')
    });
    if trimmed.is_empty() {
        return false;
    }

    trimmed.starts_with("./")
        || trimmed.starts_with("../")
        || trimmed.starts_with("~/")
        || trimmed.starts_with('/')
        || (trimmed.contains('/') && trimmed.contains('.'))
}

fn looks_like_url_token(token: &str) -> bool {
    let trimmed = token.trim_matches(|ch: char| {
        matches!(ch, '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | ':')
    });

    trimmed.starts_with("http://") || trimmed.starts_with("https://")
}

fn tool_status_color(status: &str) -> Color {
    match status {
        "done" => TOOL_MUTED,
        "error" => ERROR,
        "running" => TOOL_RUNNING,
        _ => TOOL_MUTED,
    }
}

fn tool_status_label(status: &str) -> &'static str {
    match status {
        "done" => "done",
        "error" => "error",
        "running" => "running",
        "pending" => "pending",
        _ => "idle",
    }
}

fn format_elapsed(started_at_ms: Option<u64>) -> String {
    let Some(started_at_ms) = started_at_ms else {
        return "00:00".into();
    };

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(started_at_ms);
    let elapsed_secs = now_ms.saturating_sub(started_at_ms) / 1000;
    let minutes = elapsed_secs / 60;
    let seconds = elapsed_secs % 60;

    format!("{minutes:02}:{seconds:02}")
}

fn short_job_ref(job_id: &str) -> &str {
    job_id.get(..8).unwrap_or(job_id)
}

fn load_git_diff(cwd: &str) -> Result<String> {
    let output = Command::new("git")
        .args(["diff", "--no-ext-diff", "--stat=120", "--patch", "--"])
        .current_dir(cwd)
        .output()
        .with_context(|| format!("failed to run git diff in {cwd}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(anyhow!(if stderr.is_empty() {
            "git diff failed".to_string()
        } else {
            stderr
        }));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn push_run(runs: &mut Vec<(Style, String)>, style: Style, text: &str) {
    if text.is_empty() {
        return;
    }

    if let Some((last_style, last_text)) = runs.last_mut() {
        if *last_style == style {
            last_text.push_str(text);
            return;
        }
    }

    runs.push((style, text.to_string()));
}

fn push_token_run(runs: &mut Vec<(Style, String)>, base_style: Style, token: &str) {
    if token.is_empty() {
        return;
    }

    let style = if looks_like_url_token(token) {
        Style::default()
            .fg(LINK)
            .add_modifier(Modifier::UNDERLINED)
    } else if looks_like_path_token(token) {
        Style::default().fg(PATH)
    } else {
        base_style
    };

    push_run(runs, style, token);
}

fn push_plain_runs(runs: &mut Vec<(Style, String)>, text: &str, base_style: Style) {
    let mut token = String::new();
    let mut whitespace = String::new();

    for ch in text.chars() {
        if ch.is_whitespace() {
            if !token.is_empty() {
                push_token_run(runs, base_style, &token);
                token.clear();
            }
            whitespace.push(ch);
            continue;
        }

        if !whitespace.is_empty() {
            push_run(runs, base_style, &whitespace);
            whitespace.clear();
        }
        token.push(ch);
    }

    if !token.is_empty() {
        push_token_run(runs, base_style, &token);
    }
    if !whitespace.is_empty() {
        push_run(runs, base_style, &whitespace);
    }
}

fn find_next_inline_marker(text: &str) -> usize {
    ['`', '[', '*', '_']
        .iter()
        .filter_map(|marker| text.find(*marker))
        .min()
        .unwrap_or(text.len())
}

fn parse_markdown_link(text: &str) -> Option<(usize, Vec<(Style, String)>)> {
    if !text.starts_with('[') {
        return None;
    }

    let label_end = text.find("](")?;
    let target_start = label_end + 2;
    let target_end = text[target_start..].find(')')? + target_start;
    let label = &text[1..label_end];
    let target = &text[target_start..target_end];
    let target_style = if looks_like_path_token(target) {
        Style::default().fg(PATH)
    } else {
        Style::default()
            .fg(LINK)
            .add_modifier(Modifier::UNDERLINED)
    };

    let mut runs = Vec::new();
    push_plain_runs(
        &mut runs,
        label,
        target_style.add_modifier(Modifier::BOLD),
    );
    if !target.is_empty() && target != label {
        push_run(&mut runs, Style::default().fg(MUTED), " ");
        push_run(&mut runs, target_style, "<");
        push_run(&mut runs, target_style, target);
        push_run(&mut runs, target_style, ">");
    }

    Some((target_end + 1, runs))
}

fn parse_inline_markdown_runs(text: &str, base_style: Style) -> Vec<(Style, String)> {
    let mut runs = Vec::new();
    let mut index = 0usize;

    while index < text.len() {
        let slice = &text[index..];

        if let Some((consumed, link_runs)) = parse_markdown_link(slice) {
            runs.extend(link_runs);
            index += consumed;
            continue;
        }

        let mut matched = false;
        for (open, close, style) in [
            ("**", "**", base_style.add_modifier(Modifier::BOLD)),
            ("__", "__", base_style.add_modifier(Modifier::BOLD)),
            ("*", "*", base_style.add_modifier(Modifier::ITALIC)),
            ("_", "_", base_style.add_modifier(Modifier::ITALIC)),
            ("`", "`", Style::default().fg(SUCCESS)),
        ] {
            if let Some(stripped) = slice.strip_prefix(open) {
                if let Some(end) = stripped.find(close) {
                    let inner = &stripped[..end];
                    if open == "`" {
                        push_run(&mut runs, style, inner);
                    } else {
                        push_plain_runs(&mut runs, inner, style);
                    }
                    index += open.len() + end + close.len();
                    matched = true;
                    break;
                }
            }
        }
        if matched {
            continue;
        }

        let next_marker = find_next_inline_marker(slice);
        let plain = &slice[..next_marker];
        if plain.is_empty() {
            if let Some(ch) = slice.chars().next() {
                let mut raw = [0u8; 4];
                push_run(&mut runs, base_style, ch.encode_utf8(&mut raw));
                index += ch.len_utf8();
            }
        } else {
            push_plain_runs(&mut runs, plain, base_style);
            index += plain.len();
        }
    }

    runs
}

fn wrap_styled_runs(runs: Vec<(Style, String)>, width: usize) -> Vec<Vec<Span<'static>>> {
    let width = width.max(1);
    let mut lines: Vec<Vec<(Style, String)>> = vec![Vec::new()];
    let mut current_width = 0usize;

    for (style, text) in runs {
        for grapheme in UnicodeSegmentation::graphemes(text.as_str(), true) {
            if grapheme == "\n" {
                lines.push(Vec::new());
                current_width = 0;
                continue;
            }

            let grapheme_width = UnicodeWidthStr::width(grapheme).max(1);
            if current_width + grapheme_width > width && current_width > 0 {
                lines.push(Vec::new());
                current_width = 0;
            }

            if let Some(current_line) = lines.last_mut() {
                if let Some((last_style, last_text)) = current_line.last_mut() {
                    if *last_style == style {
                        last_text.push_str(grapheme);
                    } else {
                        current_line.push((style, grapheme.to_string()));
                    }
                } else {
                    current_line.push((style, grapheme.to_string()));
                }
            }

            current_width += grapheme_width;
        }
    }

    if lines.is_empty() {
        return vec![vec![Span::raw(String::new())]];
    }

    lines
        .into_iter()
        .map(|line| {
            if line.is_empty() {
                vec![Span::raw(String::new())]
            } else {
                line.into_iter()
                    .map(|(style, text)| Span::styled(text, style))
                    .collect()
            }
        })
        .collect()
}

fn parse_ordered_list_prefix(text: &str) -> Option<(&str, &str)> {
    let dot_index = text.find(". ")?;
    if dot_index == 0 {
        return None;
    }

    let marker = &text[..dot_index];
    if marker.chars().all(|ch| ch.is_ascii_digit()) {
        Some((marker, &text[dot_index + 2..]))
    } else {
        None
    }
}

fn is_horizontal_rule(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.len() < 3 {
        return false;
    }

    trimmed.chars().all(|ch| matches!(ch, '-' | '*' | '_'))
}

#[derive(Clone, Copy)]
enum TableAlign {
    Left,
    Center,
    Right,
}

fn parse_markdown_table_cells(text: &str) -> Option<Vec<String>> {
    let trimmed = text.trim();
    if !trimmed.contains('|') {
        return None;
    }

    let cells = trimmed
        .trim_matches('|')
        .split('|')
        .map(|cell| cell.trim().to_string())
        .collect::<Vec<_>>();
    if cells.len() < 2 {
        return None;
    }

    Some(cells)
}

fn parse_markdown_table_alignments(text: &str, expected_cols: usize) -> Option<Vec<TableAlign>> {
    let cells = parse_markdown_table_cells(text)?;
    if cells.len() != expected_cols {
        return None;
    }

    let mut aligns = Vec::with_capacity(expected_cols);
    for cell in cells {
        let compact = cell.replace(' ', "");
        if compact.is_empty() || !compact.chars().all(|ch| matches!(ch, '-' | ':')) {
            return None;
        }

        let align = match (compact.starts_with(':'), compact.ends_with(':')) {
            (true, true) => TableAlign::Center,
            (false, true) => TableAlign::Right,
            _ => TableAlign::Left,
        };
        aligns.push(align);
    }

    Some(aligns)
}

fn pad_table_cell(text: &str, width: usize, align: TableAlign) -> String {
    let clipped = preview_line(text, width.max(1));
    let visible_width = UnicodeWidthStr::width(clipped.as_str());
    let pad = width.saturating_sub(visible_width);

    match align {
        TableAlign::Left => format!("{clipped}{}", " ".repeat(pad)),
        TableAlign::Right => format!("{}{}", " ".repeat(pad), clipped),
        TableAlign::Center => {
            let left = pad / 2;
            let right = pad.saturating_sub(left);
            format!("{}{}{}", " ".repeat(left), clipped, " ".repeat(right))
        }
    }
}

fn build_table_border(left: &str, mid: &str, right: &str, widths: &[usize]) -> String {
    let mut out = String::from(left);
    for (index, width) in widths.iter().enumerate() {
        if index > 0 {
            out.push_str(mid);
        }
        out.push_str(&"─".repeat(width + 2));
    }
    out.push_str(right);
    out
}

fn build_table_row_spans(
    cells: &[String],
    widths: &[usize],
    aligns: &[TableAlign],
    header: bool,
) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let border_style = Style::default().fg(ACCENT_DIM);
    let cell_style = if header {
        Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(FG)
    };

    spans.push(Span::styled("│", border_style));
    for (index, cell) in cells.iter().enumerate() {
        let align = aligns.get(index).copied().unwrap_or(TableAlign::Left);
        spans.push(Span::styled(" ", border_style));
        spans.push(Span::styled(
            pad_table_cell(cell, widths[index], align),
            cell_style,
        ));
        spans.push(Span::styled(" ", border_style));
        spans.push(Span::styled("│", border_style));
    }
    spans
}

fn render_markdown_table_block(
    raw_lines: &[&str],
    width: usize,
) -> Option<(usize, Vec<Vec<Span<'static>>>)> {
    if raw_lines.len() < 2 {
        return None;
    }

    let header = parse_markdown_table_cells(raw_lines[0])?;
    let aligns = parse_markdown_table_alignments(raw_lines[1], header.len())?;
    let mut rows = vec![header];
    let mut consumed = 2usize;

    while consumed < raw_lines.len() {
        let Some(row) = parse_markdown_table_cells(raw_lines[consumed]) else {
            break;
        };
        if row.len() != rows[0].len() {
            break;
        }
        rows.push(row);
        consumed += 1;
    }

    let col_count = rows[0].len();
    let overhead = (3 * col_count) + 1;
    if width <= overhead + col_count {
        return None;
    }

    let mut widths = vec![3usize; col_count];
    for row in &rows {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(UnicodeWidthStr::width(cell.as_str()).max(1));
        }
    }

    let max_total = width.saturating_sub(overhead);
    while widths.iter().sum::<usize>() > max_total {
        let Some((largest_index, largest_width)) = widths
            .iter()
            .enumerate()
            .max_by_key(|(_, width)| **width)
        else {
            break;
        };
        if *largest_width <= 4 {
            break;
        }
        widths[largest_index] = largest_width.saturating_sub(1);
    }

    let mut rendered = Vec::new();
    rendered.push(vec![Span::styled(
        build_table_border("╭", "┬", "╮", &widths),
        Style::default().fg(ACCENT_DIM),
    )]);
    rendered.push(build_table_row_spans(&rows[0], &widths, &aligns, true));
    rendered.push(vec![Span::styled(
        build_table_border("├", "┼", "┤", &widths),
        Style::default().fg(ACCENT_DIM),
    )]);

    for row in rows.iter().skip(1) {
        rendered.push(build_table_row_spans(row, &widths, &aligns, false));
    }

    rendered.push(vec![Span::styled(
        build_table_border("╰", "┴", "╯", &widths),
        Style::default().fg(ACCENT_DIM),
    )]);

    Some((consumed, rendered))
}

fn render_assistant_markdown_line(
    raw_line: &str,
    width: usize,
    in_code_block: &mut bool,
) -> Vec<Vec<Span<'static>>> {
    let trimmed_start = raw_line.trim_start();
    let base = Style::default().fg(FG);

    if trimmed_start.starts_with("```") {
        *in_code_block = !*in_code_block;
        let label = trimmed_start.trim_matches('`').trim();
        let fence_text = if label.is_empty() {
            "code".to_string()
        } else {
            format!("code · {label}")
        };
        return vec![vec![Span::styled(
            fence_text,
            Style::default().fg(ACCENT_DIM),
        )]];
    }

    if *in_code_block {
        return wrap_styled_runs(vec![(Style::default().fg(SUCCESS), raw_line.to_string())], width);
    }

    if raw_line.trim().is_empty() {
        return vec![vec![Span::raw(String::new())]];
    }

    if is_horizontal_rule(raw_line) {
        return vec![vec![Span::styled(
            "─".repeat(width.max(8).min(48)),
            Style::default().fg(ACCENT_DIM),
        )]];
    }

    if trimmed_start.starts_with("> ") {
        let mut runs = vec![(Style::default().fg(ACCENT_DIM), "▎ ".to_string())];
        runs.extend(parse_inline_markdown_runs(
            trimmed_start.trim_start_matches("> ").trim_start(),
            Style::default()
                .fg(ACCENT_DIM)
                .add_modifier(Modifier::ITALIC),
        ));
        return wrap_styled_runs(runs, width);
    }

    let heading_level = trimmed_start.chars().take_while(|ch| *ch == '#').count();
    if heading_level > 0 && trimmed_start.chars().nth(heading_level) == Some(' ') {
        let heading_text = trimmed_start[heading_level + 1..].trim();
        let mut runs = vec![(
            Style::default().fg(ACCENT_DIM),
            format!("{} ", "•".repeat(heading_level.min(3))),
        )];
        runs.extend(parse_inline_markdown_runs(
            heading_text,
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ));
        return wrap_styled_runs(runs, width);
    }

    if let Some(rest) = trimmed_start
        .strip_prefix("- ")
        .or_else(|| trimmed_start.strip_prefix("* "))
        .or_else(|| trimmed_start.strip_prefix("+ "))
    {
        let mut runs = vec![(Style::default().fg(ACCENT), "• ".to_string())];
        runs.extend(parse_inline_markdown_runs(rest, base));
        return wrap_styled_runs(runs, width);
    }

    if let Some((marker, rest)) = parse_ordered_list_prefix(trimmed_start) {
        let mut runs = vec![(
            Style::default()
                .fg(ACCENT)
                .add_modifier(Modifier::BOLD),
            format!("{marker}. "),
        )];
        runs.extend(parse_inline_markdown_runs(rest, base));
        return wrap_styled_runs(runs, width);
    }

    if trimmed_start.starts_with('{')
        || trimmed_start.starts_with('}')
        || trimmed_start.starts_with('[')
        || trimmed_start.starts_with(']')
    {
        return wrap_styled_runs(
            vec![(Style::default().fg(SUCCESS), raw_line.to_string())],
            width,
        );
    }

    wrap_styled_runs(parse_inline_markdown_runs(raw_line, base), width)
}

fn append_guttered_span_lines(
    lines: &mut Vec<Line<'static>>,
    rendered_lines: Vec<Vec<Span<'static>>>,
    prefix: &str,
    prefix_style: Style,
    first_visual_line: &mut bool,
) {
    let continuation = " ".repeat(prefix.width());
    for spans in rendered_lines {
        let gutter = if *first_visual_line {
            prefix.to_string()
        } else {
            continuation.clone()
        };
        *first_visual_line = false;

        let mut full = Vec::with_capacity(spans.len() + 1);
        full.push(Span::styled(gutter, prefix_style));
        full.extend(spans);
        lines.push(Line::from(full));
    }
}

fn build_transcript_lines(
    messages: &[NativeMessageState],
    width: usize,
    fold_tool_calls: bool,
    fold_system_messages: bool,
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let width = width.max(10);

    for message in messages {
        let (prefix, prefix_style, text_style) = match message.role.as_str() {
            "user" => (
                "› ",
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                Style::default().fg(FG),
            ),
            "assistant" => (
                "│ ",
                Style::default().fg(ACCENT_DIM),
                Style::default().fg(FG),
            ),
            "system" => (
                "! ",
                Style::default().fg(ERROR).add_modifier(Modifier::BOLD),
                Style::default().fg(FG),
            ),
            _ => ("· ", Style::default().fg(MUTED), Style::default().fg(FG)),
        };

        let prefix_width = prefix.width();
        if fold_system_messages && message.role == "system" && !message.content.trim().is_empty() {
            let folded = preview_line(&message.content, width.saturating_sub(prefix_width));
            lines.push(Line::from(vec![
                Span::styled(prefix.to_string(), prefix_style),
                Span::styled(format!("{folded}  [folded]"), Style::default().fg(TOOL_MUTED)),
            ]));
        } else if !message.content.trim().is_empty() || message.tool_calls.is_empty() {
            let mut first_visual_line = true;
            if message.role == "assistant" {
                let mut in_code_block = false;
                let raw_lines = message.content.split('\n').collect::<Vec<_>>();
                let mut index = 0usize;
                while index < raw_lines.len() {
                    let raw_line = raw_lines[index];
                    let rendered = if !in_code_block {
                        if let Some((consumed, table_lines)) = render_markdown_table_block(
                            &raw_lines[index..],
                            width.saturating_sub(prefix_width),
                        ) {
                            index += consumed;
                            table_lines
                        } else {
                            index += 1;
                            render_assistant_markdown_line(
                                raw_line,
                                width.saturating_sub(prefix_width),
                                &mut in_code_block,
                            )
                        }
                    } else {
                        index += 1;
                        render_assistant_markdown_line(
                            raw_line,
                            width.saturating_sub(prefix_width),
                            &mut in_code_block,
                        )
                    };
                    append_guttered_span_lines(
                        &mut lines,
                        rendered,
                        prefix,
                        prefix_style,
                        &mut first_visual_line,
                    );
                }
            } else {
                for raw_line in message.content.split('\n') {
                    let wrapped = wrap_plain(raw_line, width.saturating_sub(prefix_width));
                    for chunk in wrapped {
                        let gutter = if first_visual_line {
                            prefix.to_string()
                        } else {
                            " ".repeat(prefix_width)
                        };
                        first_visual_line = false;

                        lines.push(Line::from(vec![
                            Span::styled(gutter, prefix_style),
                            Span::styled(chunk, text_style),
                        ]));
                    }

                    if raw_line.is_empty() {
                        let gutter = if first_visual_line {
                            prefix.to_string()
                        } else {
                            " ".repeat(prefix_width)
                        };
                        first_visual_line = false;
                        lines.push(Line::from(vec![
                            Span::styled(gutter, prefix_style),
                            Span::styled(String::new(), text_style),
                        ]));
                    }
                }
            }
        }

        if fold_tool_calls && !message.tool_calls.is_empty() {
            let summary = message
                .tool_calls
                .iter()
                .map(|tool| tool.summary.as_str())
                .take(2)
                .collect::<Vec<_>>()
                .join(" · ");
            lines.push(Line::from(vec![
                Span::styled("  ↳ ", Style::default().fg(TOOL_MUTED)),
                Span::styled(
                    format!(
                        "{} tool calls folded{}",
                        format_count(message.tool_calls.len() as u64),
                        if summary.is_empty() {
                            String::new()
                        } else {
                            format!(" · {}", preview_line(&summary, width.saturating_sub(24)))
                        }
                    ),
                    Style::default().fg(TOOL_MUTED),
                ),
            ]));
        } else {
            for tool in &message.tool_calls {
                let color = tool_status_color(&tool.status);
                let mut tool_text = format!("{} · {}", tool.summary, tool_status_label(&tool.status));
                if let Some(result) = &tool.result {
                    let detail = preview_line(result, 72);
                    if !detail.is_empty() {
                        tool_text.push_str(" · ");
                        tool_text.push_str(&detail);
                    }
                }
                let wrapped_tool = wrap_plain(&tool_text, width.saturating_sub(4));
                for (index, chunk) in wrapped_tool.iter().enumerate() {
                    let gutter = if index == 0 { "  ↳ " } else { "    " };
                    lines.push(Line::from(vec![
                        Span::styled(gutter, Style::default().fg(color)),
                        Span::styled(chunk.clone(), Style::default().fg(color)),
                    ]));
                }
            }
        }

        if message.is_streaming {
            lines.push(Line::from(Span::styled(
                "  streaming…",
                Style::default().fg(ACCENT_DIM),
            )));
        }

        lines.push(Line::from(Span::raw("")));
    }

    lines
}

fn centered_rect(percent_x: u16, height: u16, area: Rect) -> Rect {
    let width = area.width.saturating_mul(percent_x).saturating_div(100);
    Rect {
        x: area.x + area.width.saturating_sub(width) / 2,
        y: area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    }
}

fn top_padded_rect(area: Rect, padding: u16) -> Rect {
    let inset = padding.min(area.height.saturating_sub(1));
    Rect {
        x: area.x,
        y: area.y + inset,
        width: area.width,
        height: area.height.saturating_sub(inset),
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
    let bridge = BridgeClient::spawn(&node_path, &bridge_path)?;

    let mut terminal = ratatui::init();
    let _ = execute!(
        terminal.backend_mut(),
        PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
    );
    terminal.clear()?;

    let outcome = {
        let mut app = App::new(bridge);
        app.run(&mut terminal).and_then(|_| {
            app.bridge.shutdown();
            Ok(())
        })
    };

    let _ = execute!(terminal.backend_mut(), PopKeyboardEnhancementFlags);
    ratatui::restore();
    outcome
}
