use std::cmp::min;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use crossterm::event::{
    self, Event, KeyCode, KeyEvent, KeyModifiers, MouseEventKind,
};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Clear, Paragraph};
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
const LINK: Color = Color::Rgb(132, 203, 255);
const PATH: Color = Color::Rgb(255, 208, 120);
const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
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

#[derive(Debug, Clone, Deserialize)]
struct NativeAskUserState {
    question: String,
    options: Vec<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
struct NativePlanItemState {
    id: String,
    step: String,
    status: String,
    owner: Option<String>,
    updated_at: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
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
    request_estimate: Option<NativeRequestEstimateState>,
    queued_prompts: Vec<String>,
    providers: Vec<NativeProviderState>,
    messages: Vec<NativeMessageState>,
    ask_user: Option<NativeAskUserState>,
    slash_commands: Vec<NativeSlashCommand>,
    session_id: Option<String>,
    remote_session_id: Option<String>,
    remote_session_count: u64,
    todos: Vec<NativePlanItemState>,
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

struct TransientNotice {
    text: String,
    created_at: Instant,
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
                    Ok(raw) => serde_json::from_str::<BridgeEvent>(&raw)
                        .map_err(|error| anyhow!("failed to parse bridge event: {error}")),
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
    selected_suggestion: usize,
    ask_user_selection: usize,
    fatal_error: Option<String>,
    last_tick: Instant,
    should_quit: bool,
    notice: Option<TransientNotice>,
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
                request_estimate: None,
                queued_prompts: Vec::new(),
                providers: Vec::new(),
                messages: Vec::new(),
                ask_user: None,
                slash_commands: Vec::new(),
                session_id: None,
                remote_session_id: None,
                remote_session_count: 0,
                todos: Vec::new(),
                error: None,
            },
            composer: ComposerState::default(),
            scroll: 0,
            auto_scroll: true,
            spinner_index: 0,
            selected_suggestion: 0,
            ask_user_selection: 0,
            fatal_error: None,
            last_tick: Instant::now(),
            should_quit: false,
            notice: None,
        }
    }

    fn on_bridge_event(&mut self, event: BridgeEvent) {
        match event {
            BridgeEvent::State { state } => {
                let was_asking = self.state.ask_user.is_some();
                let previous_mode = self.state.mode.clone();
                let previous_model = self.state.model.clone();
                let previous_provider = self.state.provider.clone();
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
                    let mode_label = self
                        .state
                        .modes
                        .iter()
                        .find(|mode| mode.active)
                        .map(|mode| mode.label.clone())
                        .unwrap_or_else(|| self.state.mode.to_uppercase());
                    self.notice = Some(TransientNotice {
                        text: format!(
                            "{} · {} · {}",
                            mode_label, self.state.provider, self.state.model
                        ),
                        created_at: Instant::now(),
                    });
                }

                if self.auto_scroll {
                    self.scroll = usize::MAX;
                }
            }
            BridgeEvent::Fatal { message } => {
                self.fatal_error = Some(message);
            }
        }
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
            if self
                .notice
                .as_ref()
                .map(|notice| notice.created_at.elapsed() > Duration::from_secs(3))
                .unwrap_or(false)
            {
                self.notice = None;
            }
            terminal.draw(|frame| self.render(frame))?;

            let timeout = Duration::from_millis(50);
            if event::poll(timeout)? {
                let ev = event::read()?;
                self.handle_event(ev)?;
            }

            if self.last_tick.elapsed() >= Duration::from_millis(90) {
                self.spinner_index = (self.spinner_index + 1) % SPINNER_FRAMES.len();
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
            let lines: Vec<Line> = suggestions
                .iter()
                .enumerate()
                .map(|(index, suggestion)| {
                    let selected = index == self.selected_suggestion;
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

        frame.set_cursor_position((composer_metrics.0, composer_metrics.1));
    }
    fn draw_sidebar_divider(&self, frame: &mut Frame, x: u16, area: Rect) {
        for row in area.top()..area.bottom() {
            frame.buffer_mut().cell_mut((x, row)).map(|cell| {
                cell.set_symbol("│").set_fg(ACCENT_DIM).set_bg(BG);
            });
        }
    }

    fn render_transcript(&mut self, frame: &mut Frame, area: Rect) {
        let available_width = area.width.saturating_sub(1) as usize;
        let lines = build_transcript_lines(&self.state.messages, available_width);
        let height = area.height as usize;
        let max_scroll = lines.len().saturating_sub(height);

        if self.scroll == usize::MAX || (self.auto_scroll && self.scroll > max_scroll) {
            self.scroll = max_scroll;
        } else {
            self.scroll = self.scroll.min(max_scroll);
        }

        let visible = if lines.is_empty() {
            build_welcome_lines(available_width)
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

    fn render_sidebar(&self, frame: &mut Frame, area: Rect) {
        let inner = Rect {
            x: area.x + 2,
            y: area.y,
            width: area.width.saturating_sub(2),
            height: area.height,
        };

        let mut lines = Vec::new();
        lines.push(sidebar_header("Context"));
        push_sidebar_rail_item(
            &mut lines,
            "·",
            ACCENT_DIM,
            format!("ddudu v{}", self.state.version),
            None,
            FG,
            ACCENT_DIM,
        );
        push_sidebar_rail_item(
            &mut lines,
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
        if let Some(remote_session_id) = &self.state.remote_session_id {
            push_sidebar_rail_item(
                &mut lines,
                "◎",
                SUCCESS,
                format!("bridge {}", preview_line(remote_session_id, 16)),
                Some("active remote session".to_string()),
                FG,
                ACCENT_DIM,
            );
        } else if self.state.remote_session_count > 0 {
            push_sidebar_rail_item(
                &mut lines,
                "◎",
                ACCENT_DIM,
                format!("bridge {}", format_count(self.state.remote_session_count)),
                Some("saved remote sessions".to_string()),
                FG,
                ACCENT_DIM,
            );
        }
        push_sidebar_rail_item(
            &mut lines,
            if self.state.permission_profile == "permissionless" { "✦" } else { "·" },
            if self.state.permission_profile == "permissionless" {
                ERROR
            } else {
                ACCENT_DIM
            },
            format!("permissions {}", self.state.permission_profile),
            None,
            FG,
            ACCENT_DIM,
        );
        lines.push(Line::from(Span::raw("")));

        lines.push(sidebar_header("Plan"));
        if self.state.todos.is_empty() {
            push_sidebar_rail_item(
                &mut lines,
                "·",
                ACCENT_DIM,
                "no active plan".to_string(),
                None,
                FG,
                ACCENT_DIM,
            );
        } else {
            for item in self.state.todos.iter().take(6) {
                let (marker, color) = match item.status.as_str() {
                    "completed" => ("✓", SUCCESS),
                    "in_progress" => ("→", ACCENT),
                    _ => ("·", ACCENT_DIM),
                };
                let detail = item
                    .owner
                    .as_ref()
                    .map(|owner| format!("{} · {}", owner, preview_line(&item.id, 6)))
                    .or_else(|| Some(preview_line(&item.id, 6)));
                push_sidebar_rail_item(
                    &mut lines,
                    marker,
                    color,
                    preview_line(&item.step, 28),
                    detail,
                    FG,
                    ACCENT_DIM,
                );
            }
        }
        lines.push(Line::from(Span::raw("")));

        lines.push(sidebar_header("Background"));
        if self.state.loading {
            let elapsed = format_elapsed(self.state.loading_since);
            push_sidebar_rail_item(
                &mut lines,
                SPINNER_FRAMES[self.spinner_index],
                ACCENT,
                format!("request {elapsed}"),
                Some(if self.state.loading_label.is_empty() {
                    "running".to_string()
                } else {
                    self.state.loading_label.clone()
                }),
                FG,
                ACCENT_DIM,
            );
            if let Some(estimate) = &self.state.request_estimate {
                push_sidebar_rail_item(
                    &mut lines,
                    "⋯",
                    ACCENT_DIM,
                    format!("next {} ~{}", estimate.mode, format_count(estimate.total)),
                    estimate.note.as_ref().map(|note| preview_line(note, 32)),
                    FG,
                    ACCENT_DIM,
                );
            }
            push_sidebar_rail_item(
                &mut lines,
                "·",
                ACCENT_DIM,
                "Esc to interrupt".to_string(),
                None,
                FG,
                ACCENT_DIM,
            );
        } else {
            push_sidebar_rail_item(
                &mut lines,
                "·",
                ACCENT_DIM,
                "idle".to_string(),
                Some("no running request".to_string()),
                FG,
                ACCENT_DIM,
            );
        }
        for prompt in self.state.queued_prompts.iter().take(3) {
            push_sidebar_rail_item(
                &mut lines,
                "•",
                ACCENT_DIM,
                preview_line(prompt, 26),
                Some("queued".to_string()),
                FG,
                ACCENT_DIM,
            );
        }

        lines.push(Line::from(Span::raw("")));
        lines.push(sidebar_header("Tools"));

        let mut shown = 0usize;
        for message in self.state.messages.iter().rev() {
            for tool in message.tool_calls.iter().rev() {
                let color = tool_status_color(&tool.status);
                push_sidebar_rail_item(
                    &mut lines,
                    status_marker(&tool.status),
                    color,
                    preview_line(&tool.summary, 26),
                    Some(format!(
                        "{}{}",
                        tool_status_label(&tool.status),
                        tool.result
                            .as_ref()
                            .map(|result| format!(" · {}", preview_line(result, 22)))
                            .unwrap_or_default()
                    )),
                    color,
                    ACCENT_DIM,
                );
                shown += 1;
                if shown >= 8 {
                    break;
                }
            }
            if shown >= 8 {
                break;
            }
        }

        if shown == 0 {
            push_sidebar_rail_item(
                &mut lines,
                "·",
                ACCENT_DIM,
                "no tool activity".to_string(),
                None,
                FG,
                ACCENT_DIM,
            );
        }

        lines.push(Line::from(Span::raw("")));
        lines.push(sidebar_header("Providers"));
        for provider in &self.state.providers {
            let color = if provider.available { SUCCESS } else { ACCENT_DIM };
            push_sidebar_rail_item(
                &mut lines,
                if provider.available { "●" } else { "○" },
                color,
                title_case_label(&provider.name),
                provider
                    .source
                    .as_ref()
                    .map(|source| preview_line(source, 28)),
                FG,
                ACCENT_DIM,
            );
        }

        frame.render_widget(
            Paragraph::new(Text::from(lines)).style(Style::default().bg(BG)),
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
        let metrics = wrap_editor_text(
            &self.composer.text,
            self.composer.cursor,
            content_width.max(1),
        );
        let max_visible = inner.height.saturating_sub(1) as usize;
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
        } else if let Some(notice) = &self.notice {
            footer_spans.push(Span::styled("  ·  ", Style::default().fg(ACCENT_DIM)));
            footer_spans.push(Span::styled(
                format!("switched {}", notice.text),
                Style::default().fg(ACCENT_DIM),
            ));
        }
        lines.push(Line::from(footer_spans));

        frame.render_widget(
            Paragraph::new(Text::from(lines)).style(Style::default().bg(BG)),
            inner,
        );

        let cursor_x = inner.x + prompt_prefix.width() as u16 + metrics.cursor_col as u16;
        let cursor_y = inner.y + (metrics.cursor_row.saturating_sub(start) as u16);
        (
            cursor_x.min(inner.right().saturating_sub(1)),
            cursor_y.min(inner.bottom().saturating_sub(2)),
        )
    }

    fn render_popup(&self, _frame: &mut Frame, body_area: Rect) -> Option<(Rect, Vec<Suggestion>)> {
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
                self.composer.insert_text(&text);
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> Result<()> {
        let suggestions = self.current_suggestions();
        let popup_visible = !suggestions.is_empty();
        let composer_empty = self.composer.trim().is_empty();

        if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('c') {
            if self.state.loading {
                self.bridge.send(BridgeCommand::Abort)?;
            } else {
                self.should_quit = true;
            }
            return Ok(());
        }

        if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('l') {
            self.bridge.send(BridgeCommand::ClearMessages)?;
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
        if command.trim() == "/quit" {
            self.should_quit = true;
            return Ok(());
        }

        self.bridge.send(BridgeCommand::RunSlash {
            command: command.to_string(),
        })?;

        Ok(())
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

fn center_with_padding(line: &str, width: usize) -> String {
    let line_width = UnicodeWidthStr::width(line);
    if width <= line_width {
        return line.to_string();
    }

    let left_pad = (width - line_width) / 2;
    format!("{}{}", " ".repeat(left_pad), line)
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

fn build_welcome_lines(width: usize) -> Vec<Line<'static>> {
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
    for line in art {
        lines.push(Line::from(Span::styled(
            center_with_padding(&line, width),
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        )));
    }

    if !lines.is_empty() {
        lines.push(Line::from(Span::raw("")));
    }
    lines.push(Line::from(Span::styled(
        center_with_padding("BL4CKP1NK 1N Y0UR AREA", width),
        Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
    )));
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
        "done" => SUCCESS,
        "error" => ERROR,
        "running" => ACCENT,
        _ => ACCENT_DIM,
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

fn status_marker(status: &str) -> &'static str {
    match status {
        "done" => "●",
        "error" => "✕",
        "running" => "↻",
        "pending" => "◌",
        _ => "·",
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

fn build_transcript_lines(messages: &[NativeMessageState], width: usize) -> Vec<Line<'static>> {
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
        if !message.content.trim().is_empty() || message.tool_calls.is_empty() {
            let mut first_visual_line = true;
            if message.role == "assistant" {
                let mut in_code_block = false;
                for raw_line in message.content.split('\n') {
                    let rendered = render_assistant_markdown_line(
                        raw_line,
                        width.saturating_sub(prefix_width),
                        &mut in_code_block,
                    );
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
    terminal.clear()?;

    let outcome = {
        let mut app = App::new(bridge);
        app.run(&mut terminal).and_then(|_| {
            app.bridge.shutdown();
            Ok(())
        })
    };

    ratatui::restore();
    outcome
}
