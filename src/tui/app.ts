import { basename } from 'node:path';

import { AnthropicClient, type ApiMessage, type ContentBlock, type ToolUseContentBlock } from '../api/anthropic-client.js';
import { discoverToken, type ResolvedToken } from '../api/oauth-discovery.js';
import { executeToolCalls, formatToolsForApi, type ToolUseBlock } from '../api/tool-executor.js';
import { resolveMultipleMentions } from '../context/file-context.js';
import { BashRunner } from '../core/bash-runner.js';
import { generateBriefing, formatBriefing } from '../core/briefing.js';
import { ChecksRunner } from '../core/checks.js';
import { CompactionEngine } from '../core/compaction.js';
import { EpistemicStateManager } from '../core/epistemic-state.js';
import { GitCheckpoint } from '../core/git-checkpoint.js';
import { HookRegistry } from '../core/hooks.js';
import { loadMemory } from '../core/memory.js';
import { loadSystemPrompt } from '../core/prompts.js';
import { SkillLoader } from '../core/skill-loader.js';
import { TokenCounter } from '../core/token-counter.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { AutocompletePopup, type AutocompleteItem } from './components/autocomplete.js';
import { ChatView } from './components/chat-view.js';
import { InfoPanel, INFO_PANEL_WIDTH, INFO_PANEL_MIN_TERMINAL } from './components/info-panel.js';
import { InputBar } from './components/input-bar.js';
import { MentionResolver } from './components/mention-resolver.js';
import { StatusBar } from './components/status-bar.js';
import {
  PINK, PINK_DIM, DIM, RESET, GRAY, SPINNER,
  MAIN_BG, BOX_TL, BOX_TR, BOX_BL, BOX_BR, BOX_H, BOX_V, BOX_VR, BOX_VL, BOX_HD, BOX_HU,
  BP_LYRICS,
  fmtUser, fmtAssistant, fmtThinking, fmtError, fmtSystem,
  visibleLength, joinHorizontal,
} from './colors.js';
import { createCommands, executeCommand } from './commands.js';
import { MouseTracker, enableMouse, disableMouse } from './mouse.js';
import { Renderer, type LayoutResult } from './renderer.js';
import { TabManager, type Tab } from './tab-manager.js';
import { ProcessTerminal } from './terminal.js';

const MAX_TOOL_LOOP_DEPTH = 25;

export interface BlackpinkMode {
  name: string;
  provider: string;
  model: string;
  label: string;
  description: string;
  promptAddition: string;
}

export const BLACKPINK_MODES: Record<string, BlackpinkMode> = {
  jennie: {
    name: 'jennie',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    label: 'JENNIE',
    description: 'Orchestration — balanced multi-agent coordination',
    promptAddition:
      'You are operating in JENNIE mode (orchestration).\n' +
      '- Start by classifying each request as trivial, moderate, or complex before acting.\n' +
      '- Trivial: respond directly with minimal overhead and no unnecessary decomposition.\n' +
      '- Moderate: execute directly but structure work into clear ordered steps.\n' +
      '- Complex: break work into sub-tasks and use the task tool to spawn specialized sub-agents.\n' +
      '- Assign sub-agents discrete scopes, collect outputs, and synthesize one coherent final result.\n' +
      '- Balance speed and quality consciously; default to quality, but optimize for speed when urgency is explicit.\n' +
      '- Use tools proactively: read relevant files before edits and grep/search before implementing assumptions.\n' +
      '- After changes, run appropriate verification checks and report concrete pass/fail outcomes.\n' +
      '- If requirements or constraints are ambiguous, use ask_question to clarify before risky changes.\n' +
      '- Keep orchestration visible: state plan briefly, execute decisively, then summarize validated results.',
  },
  lisa: {
    name: 'lisa',
    provider: 'openai',
    model: 'gpt-4o',
    label: 'LISA',
    description: 'Ultraworker — fast execution, high throughput',
    promptAddition:
      'You are operating in LISA mode (ultraworker).\n' +
      '- Execute immediately with zero deliberation overhead; act on the first viable interpretation.\n' +
      '- Treat every message as urgent and optimize for fastest safe completion.\n' +
      '- Deliver one-shot results; avoid back-and-forth unless a hard blocker makes progress impossible.\n' +
      '- Do not explain reasoning unless explicitly requested by the user.\n' +
      '- Run tool calls in parallel whenever operations are independent.\n' +
      '- Never ask clarifying questions; make reasonable assumptions and proceed.\n' +
      '- Keep output minimal, action-oriented, and free of narrative prose.\n' +
      '- For code edits: change only what is needed, verify quickly, report done.\n' +
      '- Prefer direct commands and concrete outcomes over planning language.\n' +
      '- Maintain throughput momentum across tasks without pausing for optional refinements.',
  },
  'rosé': {
    name: 'rosé',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    label: 'ROSÉ',
    description: 'Planning — deep thinking, architecture, strategy',
    promptAddition:
      'You are operating in ROSÉ mode (planning).\n' +
      '- Think step by step before taking any action; never jump to implementation blindly.\n' +
      '- Build a detailed plan with explicit rationale for each major decision.\n' +
      '- Enumerate edge cases, failure modes, operational risks, and recovery strategies.\n' +
      '- Compare alternatives and explain why the chosen approach is superior in context.\n' +
      '- Use read_file and grep extensively to build full context before modifying anything.\n' +
      '- When implementation is requested, explain approach first, then execute in controlled steps.\n' +
      '- For architecture requests, provide clear trade-off analysis with concrete pros and cons.\n' +
      '- Use oracle for second opinions on critical or high-impact technical decisions.\n' +
      '- Prefer correctness, robustness, and long-term maintainability over speed.\n' +
      '- Validate assumptions continuously and revise the plan if new evidence appears.',
  },
  jisoo: {
    name: 'jisoo',
    provider: 'gemini',
    model: 'gemini-2.0-pro',
    label: 'JISOO',
    description: 'Design — UI/UX focused, visual, creative',
    promptAddition:
      'You are operating in JISOO mode (design).\n' +
      '- Prioritize UI/UX quality, component architecture, and cohesive visual direction.\n' +
      '- Define visual hierarchy and layout intent before writing implementation details.\n' +
      '- Design interactions across hover, focus, active, loading, error, and empty states.\n' +
      '- Enforce accessibility basics: semantic structure, ARIA where needed, keyboard navigation, and color contrast.\n' +
      '- Apply systematic spacing, consistent typography scales, and disciplined color usage.\n' +
      '- Evaluate decisions from the user perspective, not only technical implementation quality.\n' +
      '- Propose transitions or animations only when they improve clarity or perceived performance.\n' +
      '- Ensure responsive behavior across mobile, tablet, and desktop viewport ranges.\n' +
      '- Keep component APIs composable and maintainable for future design iteration.\n' +
      '- When reviewing UI, provide concrete usability findings and actionable improvements.',
  },
};

const MODE_ALIASES: Record<string, string> = {
  smart: 'jennie',
  rush: 'lisa',
  deep: 'rosé',
  design: 'jisoo',
};

const resolveModeName = (input: string): string | undefined => {
  const lower = input.toLowerCase();
  if (lower in BLACKPINK_MODES) return lower;
  if (lower in MODE_ALIASES) return MODE_ALIASES[lower];
  if (lower === 'rose') return 'rosé';
  return undefined;
};

const WELCOME_ART: string[] = [
  "      d8b       d8b                d8b                    d8b       d8b                d8b",
  "      88P       88P                88P                    88P       88P                88P",
  "     d88       d88                d88                    d88       d88                d88",
  " d888888   d888888  ?88   d8P d888888  ?88   d8P     d888888   d888888  ?88   d8P d888888  ?88   d8P",
  "d8P' ?88  d8P' ?88  d88   88 d8P' ?88  d88   88     d8P' ?88  d8P' ?88  d88   88 d8P' ?88  d88   88",
  "88b  ,88b 88b  ,88b ?8(  d88 88b  ,88b ?8(  d88     88b  ,88b 88b  ,88b ?8(  d88 88b  ,88b ?8(  d88",
  "`?88P'`88b`?88P'`88b`?88P'?8b`?88P'`88b`?88P'?8b    `?88P'`88b`?88P'`88b`?88P'?8b`?88P'`88b`?88P'?8b",
];

interface TuiAppConfig {
  provider: string;
  model: string;
  models: string[];
  maxTabs?: number;
  providerCommand: string;
  providerArgs: string[];
}

export class TuiApp {
  private readonly terminal: ProcessTerminal;
  private readonly renderer: Renderer;
  private readonly tabManager: TabManager;
  private readonly statusBar: StatusBar;
  private readonly chatView: ChatView;
  private readonly inputBar: InputBar;
  private readonly infoPanel: InfoPanel;
  private readonly mouseTracker = new MouseTracker();
  private readonly autocomplete: AutocompletePopup;
  private readonly mentionResolver: MentionResolver;
  private readonly bashRunner: BashRunner;
  private readonly tokenCounter: TokenCounter;
  private readonly toolRegistry = createDefaultRegistry();
  private readonly epistemicState = new EpistemicStateManager();
  private readonly hookRegistry = new HookRegistry();
  private readonly skillLoader: SkillLoader;
  private config: TuiAppConfig;
  private activeMode = 'jennie';
  private started = false;
  private bashMode = false;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private spinnerTick = 0;
  private spinnerLineIdx = -1;
  private spinnerGotOutput = false;
  private modelIndex = 0;
  private showSplash = true;
  private prefixMode = false;
  private prefixTimeout: ReturnType<typeof setTimeout> | null = null;
  private bpLyricIndex = 0;
  private glitchFrame = 0;
  private glitchTimer: ReturnType<typeof setInterval> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  private resolvedToken: ResolvedToken | null = null;
  private systemPrompt = '';
  private readonly tabConversations = new Map<string, ApiMessage[]>();
  private readonly activeAbort = new Map<string, AbortController>();
  private readonly messageQueue: string[] = [];
  private pendingQuestion: {
    resolve: (answer: string) => void;
    reject: (err: Error) => void;
    tabId: string;
  } | null = null;
  private lastEscTime = 0;
  private imageCounter = 0;

  public constructor(config: TuiAppConfig) {
    this.config = config;
    this.modelIndex = config.models.indexOf(config.model);
    if (this.modelIndex < 0) this.modelIndex = 0;
    this.terminal = new ProcessTerminal();
    this.statusBar = new StatusBar();
    this.chatView = new ChatView();
    this.inputBar = new InputBar();
    this.infoPanel = new InfoPanel();
    this.tabManager = new TabManager(config.maxTabs ?? 8);
    this.renderer = new Renderer(this.terminal, () => this.layout());
    this.skillLoader = new SkillLoader(process.cwd());

    const cmdItems: AutocompleteItem[] = createCommands(() => ({
      provider: config.provider,
      model: config.model,
      version: '0.2.0',
      cwd: process.cwd(),
      tabCount: 1,
      activeTabName: 'main',
      queueLength: this.messageQueue.length,
    })).map((c) => ({
      name: c.name,
      description: c.description,
      value: `/${c.name}`,
    }));
    this.autocomplete = new AutocompletePopup(cmdItems);
    this.mentionResolver = new MentionResolver(process.cwd());
    this.bashRunner = new BashRunner(process.cwd());
    this.tokenCounter = new TokenCounter(config.model);

    this.inputBar.on('submit', (value) => {
      this.handleSubmit(value);
    });

    this.tabManager.on('switch', (tab) => {
      this.syncTabToView(tab);
      this.renderer.requestRender();
    });

    this.tabManager.on('close', (tab) => {
      const abort = this.activeAbort.get(tab.id);
      if (abort) {
        abort.abort();
        this.activeAbort.delete(tab.id);
      }
      this.tabConversations.delete(tab.id);

      const active = this.tabManager.getActiveTab();
      if (active) {
        this.syncTabToView(active);
      } else {
        this.chatView.setLines([]);
      }
      this.renderer.requestRender();
    });
  }

  public async init(): Promise<void> {
    try {
      this.resolvedToken = await discoverToken();
    } catch {
      this.resolvedToken = null;
    }

    const projectName = basename(process.cwd());
    try {
      this.systemPrompt = await loadSystemPrompt({
        model: this.config.model,
        provider: this.config.provider,
        cwd: process.cwd(),
        projectName,
        version: '0.2.0',
        timestamp: new Date().toISOString(),
        rules: [],
        skills: [],
        userInstructions: '',
      });
    } catch {
      this.systemPrompt = '';
    }

    await this.skillLoader.scan().catch(() => {});

    try {
      const memory = await loadMemory(process.cwd());
      if (memory.replace(/## Global Memory\n\n\n## Project Memory\n/u, '').trim().length > 0) {
        this.systemPrompt += `\n\n<memory>\n${memory}\n</memory>`;
      }
    } catch {
      // Memory loading is optional
    }

    void this.hookRegistry.emit('onSessionStart', {
      model: this.config.model,
      provider: this.config.provider,
      cwd: process.cwd(),
    });
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.renderer.clear();
    this.terminal.start(
      (data) => this.handleInput(data),
      () => this.handleResize(),
    );
    this.terminal.write(enableMouse());

    this.glitchTimer = setInterval(() => {
      if (!this.showSplash) {
        if (this.glitchTimer) {
          clearInterval(this.glitchTimer);
          this.glitchTimer = null;
        }
        return;
      }
      this.glitchFrame = (this.glitchFrame + 1) % 60;
      this.renderer.requestRender();
    }, 120);

    this.renderer.requestRender();
  }

  public stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stopSpinner();
    if (this.glitchTimer) {
      clearInterval(this.glitchTimer);
      this.glitchTimer = null;
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }

    for (const [tabId, abort] of this.activeAbort) {
      abort.abort();
      this.activeAbort.delete(tabId);
    }

    this.terminal.write(disableMouse());
    this.terminal.stop();
    this.terminal.write('\n');
  }

  public handleInput(data: string): void {
    if (this.mouseTracker.isMouseEvent(data)) {
      const event = this.mouseTracker.parse(data);
      if (event) {
        if (event.type === 'wheel-up') {
          this.chatView.scroll(-3);
          this.renderer.requestRender();
          return;
        }
        if (event.type === 'wheel-down') {
          this.chatView.scroll(3);
          this.renderer.requestRender();
          return;
        }
        if (event.type === 'click' && event.row === 1) {
          const tabs = this.tabManager.getTabs();
          const tabIndex = Math.floor((event.col - 10) / 10);
          if (tabIndex >= 0 && tabIndex < tabs.length) {
            const target = tabs[tabIndex];
            if (target) {
              this.tabManager.switchTab(target.id);
              this.renderer.requestRender();
            }
          }
          return;
        }
      }
      return;
    }

    if (data === '\u001b' && !this.autocomplete.isVisible) {
      const active = this.tabManager.getActiveTab();

      if (active?.status === 'working') {
        const abort = this.activeAbort.get(active.id);
        if (abort) {
          abort.abort();
          this.activeAbort.delete(active.id);
        }
        this.stopSpinner();
        if (this.spinnerLineIdx >= 0 && this.spinnerLineIdx < active.lines.length) {
          active.lines.splice(this.spinnerLineIdx, 1);
          this.spinnerLineIdx = -1;
        }
        const history = this.tabConversations.get(active.id);
        if (history && history.length > 0 && history[history.length - 1]?.role === 'user') {
          history.pop();
        }
        active.lines.push(fmtSystem('Cancelled'));
        active.lines.push('');
        active.status = 'idle';
        active.agentId = undefined;
        this.chatView.setLines(active.lines);
        this.renderer.requestRender();
        this.lastEscTime = 0;
        return;
      }

      const now = Date.now();
      if (now - this.lastEscTime < 400) {
        if (active) {
          active.lines = [];
          this.tabConversations.delete(active.id);
        }
        this.chatView.setLines([]);
        this.renderer.clear();
        this.renderer.requestRender();
        this.lastEscTime = 0;
        return;
      }

      this.lastEscTime = now;

      if (this.inputBar.getInput().length > 0) {
        this.inputBar.clear();
        this.renderer.requestRender();
      }
      return;
    }

    if (data === '\u0003') {
      if (this.pendingQuestion) {
        const pq = this.pendingQuestion;
        this.pendingQuestion = null;
        pq.reject(new Error('Cancelled by user.'));
      }

      const active = this.tabManager.getActiveTab();
      if (active?.status === 'working') {
        const abort = this.activeAbort.get(active.id);
        if (abort) {
          abort.abort();
          this.activeAbort.delete(active.id);
        }
        this.stopSpinner();
        if (this.spinnerLineIdx >= 0 && this.spinnerLineIdx < active.lines.length) {
          active.lines.splice(this.spinnerLineIdx, 1);
          this.spinnerLineIdx = -1;
        }

        const history = this.tabConversations.get(active.id);
        if (history && history.length > 0 && history[history.length - 1]?.role === 'user') {
          history.pop();
        }

        active.lines.push(fmtSystem('Cancelled'));
        active.lines.push('');
        active.status = 'idle';
        active.agentId = undefined;
        this.chatView.setLines(active.lines);
        this.renderer.requestRender();
        return;
      }

      this.stop();
      process.exit(0);
      return;
    }

    if (data === '\u0002') {
      this.prefixMode = true;
      if (this.prefixTimeout) clearTimeout(this.prefixTimeout);
      this.prefixTimeout = setTimeout(() => {
        this.prefixMode = false;
        this.renderer.requestRender();
      }, 2000);
      this.renderer.requestRender();
      return;
    }

    if (this.prefixMode) {
      this.prefixMode = false;
      if (this.prefixTimeout) {
        clearTimeout(this.prefixTimeout);
        this.prefixTimeout = null;
      }

      if (data === 't' || data === 'T') {
        this.createTab();
      } else if (data === 'w' || data === 'W') {
        const active = this.tabManager.getActiveTab();
        if (active) {
          this.tabManager.closeTab(active.id);
        }
        this.ensureInitialTab();
      } else if (data === 'n' || data === 'N') {
        const tabs = this.tabManager.getTabs();
        const idx = tabs.findIndex((t) => t.id === this.tabManager.getActiveTab()?.id);
        if (idx >= 0 && idx < tabs.length - 1) {
          this.tabManager.switchTab(tabs[idx + 1]!.id);
        }
      } else if (data === 'p' || data === 'P') {
        const tabs = this.tabManager.getTabs();
        const idx = tabs.findIndex((t) => t.id === this.tabManager.getActiveTab()?.id);
        if (idx > 0) {
          this.tabManager.switchTab(tabs[idx - 1]!.id);
        }
      } else if (data === 'l' || data === 'L') {
        const active = this.tabManager.getActiveTab();
        if (active) {
          active.lines = [];
          this.tabConversations.delete(active.id);
        }
        this.chatView.setLines([]);
        this.renderer.clear();
      } else if (data >= '1' && data <= '8') {
        const tabs = this.tabManager.getTabs();
        const target = tabs[Number.parseInt(data, 10) - 1];
        if (target) this.tabManager.switchTab(target.id);
      }

      this.renderer.requestRender();
      return;
    }

    if (data === '\x1b[Z') {
      this.cycleMode();
      this.renderer.requestRender();
      return;
    }

    if (data === '\u000c') {
      const active = this.tabManager.getActiveTab();
      if (active) {
        active.lines = [];
        this.tabConversations.delete(active.id);
      }
      this.chatView.setLines([]);
      this.renderer.clear();
      this.renderer.requestRender();
      return;
    }

    const ctrlDigit = this.parseCtrlDigit(data);
    if (ctrlDigit !== null) {
      const tabs = this.tabManager.getTabs();
      const target = tabs[ctrlDigit - 1];
      if (target) {
        this.tabManager.switchTab(target.id);
      }
      this.renderer.requestRender();
      return;
    }

    if (data === '\u001b[A' || data === '\u001b[B') {
      if (this.inputBar.getInput().length === 0) {
        this.chatView.scroll(data === '\u001b[A' ? -1 : 1);
        this.renderer.requestRender();
        return;
      }
    }

    if (this.autocomplete.isVisible) {
      if (data === '\u001b[A') {
        this.autocomplete.moveUp();
        this.renderer.requestRender();
        return;
      }
      if (data === '\u001b[B') {
        this.autocomplete.moveDown();
        this.renderer.requestRender();
        return;
      }
      if (data === '\r') {
        const selected = this.autocomplete.select();
        if (selected) {
          this.inputBar.clear();
          this.inputBar.handleInput(`\u001b[200~${selected.value} \u001b[201~`);
          this.autocomplete.dismiss();
          this.renderer.requestRender();
          return;
        }
      }
      if (data === '\u001b') {
        this.autocomplete.dismiss();
        this.renderer.requestRender();
        return;
      }
    }

    const handled = this.inputBar.handleInput(data);

    const currentInput = this.inputBar.getInput();
    if (currentInput.startsWith('/')) {
      this.autocomplete.update(currentInput.slice(1));
    } else {
      this.autocomplete.dismiss();
    }

    const mentionMatch = currentInput.match(/(?:^|\s)(@[\w./-]*)$/u);
    if (mentionMatch) {
      const query = mentionMatch[1] ?? '';
      void this.mentionResolver.update(query).then(() => {
        this.renderer.requestRender();
      }).catch(() => {});
    } else {
      this.mentionResolver.dismiss();
    }

    if (handled) {
      this.renderer.requestRender();
    }
  }

  public layout(): LayoutResult {
    const { cols, rows } = this.terminal.getSize();
    const safeRows = Math.max(1, rows);

    if (this.showSplash) return this.layoutSplash(cols, safeRows);

    const active = this.tabManager.getActiveTab();
    const agentStatus: 'ready' | 'thinking' | 'streaming' =
      active?.status === 'working'
        ? (this.spinnerGotOutput ? 'streaming' : 'thinking')
        : 'ready';

    const bpMode = BLACKPINK_MODES[this.activeMode];
    const tabs = this.tabManager.getTabs();
    const activeTabId = active?.id ?? '';
    const provider = this.config.provider;
    const model = this.config.model;
    const mode = bpMode?.label ?? this.activeMode.toUpperCase();
    const sessionId = active?.sessionId ?? '-';
    const cwd = process.cwd();
    const tabCount = tabs.length;
    const modelIndex = this.modelIndex;
    const modelCount = this.config.models.length;

    this.statusBar.update({
      tabs,
      activeTabId,
      provider,
      model,
      mode,
      status: agentStatus,
    });

    const showSidebar = cols >= INFO_PANEL_MIN_TERMINAL;
    const sideContentW = showSidebar ? INFO_PANEL_WIDTH : 0;
    const chatContentW = showSidebar ? cols - sideContentW - 3 : cols - 2;

    const chromeHeight = 5;
    const contentHeight = Math.max(1, safeRows - chromeHeight);

    const statusContent = this.statusBar.render(chatContentW)[0] ?? '';
    const chatLines = this.chatView.render(chatContentW, contentHeight);
    const inputContent = this.inputBar.render(chatContentW)[0] ?? '';
    const footerContent = joinHorizontal(this.buildFooterContent(chatContentW, bpMode), '', chatContentW);

    if (showSidebar) {
      this.infoPanel.update({
        model,
        provider,
        status: agentStatus,
        sessionId,
        cwd,
        tabCount,
        modelIndex,
        modelCount,
        mode,
        tokenUsage: this.tokenCounter.getUsage(),
        contextPercent: this.tokenCounter.getUsagePercent(),
      });
    }

    const sideLines = showSidebar
      ? this.infoPanel.render(sideContentW, contentHeight + 3)
      : [];

    const lines: string[] = [];
    let sideIdx = 0;

    lines.push(this.buildTopBorder(statusContent, chatContentW, sideContentW, showSidebar));

    for (const chatLine of chatLines) {
      const side = showSidebar ? (sideLines[sideIdx++] ?? '') : null;
      lines.push(this.frameLine(chatLine, side, chatContentW, sideContentW));
    }

    const sideForSep = showSidebar ? (sideLines[sideIdx++] ?? '') : null;
    lines.push(this.buildInputSep(chatContentW, sideForSep, sideContentW, showSidebar));

    const sideForInput = showSidebar ? (sideLines[sideIdx++] ?? '') : null;
    lines.push(this.frameLine(inputContent, sideForInput, chatContentW, sideContentW));

    const sideForFooter = showSidebar ? (sideLines[sideIdx++] ?? '') : null;
    lines.push(this.frameLine(footerContent, sideForFooter, chatContentW, sideContentW));

    lines.push(this.buildBottomBorder(chatContentW, sideContentW, showSidebar));

    if (lines.length > safeRows) lines.length = safeRows;
    while (lines.length < safeRows) lines.push(MAIN_BG + ' '.repeat(cols) + RESET);

    const cursorRow = safeRows - 3;
    const cursorCol = 2 + this.inputBar.getCursorColumn();

    const result: LayoutResult = { lines, cursor: { row: cursorRow, col: cursorCol } };

    if (this.autocomplete.isVisible) {
      const acPreview = this.autocomplete.render(1, 1, chatContentW - 2);
      const acCount = Math.min(8, acPreview.length);
      const acStartRow = cursorRow - acCount;
      result.overlays = this.autocomplete.render(acStartRow, 3, chatContentW - 2);
    }

    return result;
  }

  private frameLine(chat: string, side: string | null, chatW: number, sideW: number): string {
    const chatVis = visibleLength(chat);
    const chatPad = Math.max(0, chatW - chatVis);
    const paddedChat = chat + MAIN_BG + ' '.repeat(chatPad);

    if (side !== null) {
      const sideVis = visibleLength(side);
      const sidePad = Math.max(0, sideW - sideVis);
      const paddedSide = side + MAIN_BG + ' '.repeat(sidePad);
      return `${MAIN_BG}${PINK_DIM}${BOX_V}${RESET}${MAIN_BG}${paddedChat}${PINK_DIM}${BOX_V}${RESET}${MAIN_BG}${paddedSide}${PINK_DIM}${BOX_V}${RESET}`;
    }
    return `${MAIN_BG}${PINK_DIM}${BOX_V}${RESET}${MAIN_BG}${paddedChat}${PINK_DIM}${BOX_V}${RESET}`;
  }

  private buildTopBorder(statusContent: string, chatW: number, sideW: number, hasSidebar: boolean): string {
    const statusVis = visibleLength(statusContent);
    const chatFill = Math.max(0, chatW - statusVis);
    if (hasSidebar) {
      return `${MAIN_BG}${PINK_DIM}${BOX_TL}${RESET}${MAIN_BG}${statusContent}${PINK_DIM}${BOX_H.repeat(chatFill)}${BOX_HD}${BOX_H.repeat(sideW)}${BOX_TR}${RESET}`;
    }
    return `${MAIN_BG}${PINK_DIM}${BOX_TL}${RESET}${MAIN_BG}${statusContent}${PINK_DIM}${BOX_H.repeat(chatFill)}${BOX_TR}${RESET}`;
  }

  private buildInputSep(chatW: number, side: string | null, sideW: number, hasSidebar: boolean): string {
    const label = ' INPUT ';
    const fillLen = Math.max(0, chatW - label.length);
    const fillLeft = Math.min(2, fillLen);
    const fillRight = Math.max(0, fillLen - fillLeft);
    const sep = `${PINK_DIM}${BOX_VR}${BOX_H.repeat(fillLeft)}${RESET}${PINK_DIM}${label}${BOX_H.repeat(fillRight)}${BOX_VL}${RESET}`;

    if (hasSidebar && side !== null) {
      const sideVis = visibleLength(side);
      const sidePad = Math.max(0, sideW - sideVis);
      return `${MAIN_BG}${sep}${MAIN_BG}${side}${MAIN_BG}${' '.repeat(sidePad)}${PINK_DIM}${BOX_V}${RESET}`;
    }
    return `${MAIN_BG}${sep}`;
  }

  private buildBottomBorder(chatW: number, sideW: number, hasSidebar: boolean): string {
    if (hasSidebar) {
      return `${MAIN_BG}${PINK_DIM}${BOX_BL}${BOX_H.repeat(chatW)}${BOX_HU}${BOX_H.repeat(sideW)}${BOX_BR}${RESET}`;
    }
    return `${MAIN_BG}${PINK_DIM}${BOX_BL}${BOX_H.repeat(chatW)}${BOX_BR}${RESET}`;
  }

  private layoutSplash(cols: number, rows: number): LayoutResult {
    const lines: string[] = [];
    const artLines = WELCOME_ART.length;
    const boxWidth = Math.max(4, Math.min(60, cols - 8));
    const totalContent = artLines + 5 + 3 + 2;
    const topPad = Math.max(0, Math.floor((rows - totalContent) / 2));

    for (let i = 0; i < topPad; i++) lines.push(MAIN_BG + ' '.repeat(cols) + RESET);

    const glitchChars = ['░', '▒', '▓', '█', '▄', '▀', '▐', '▌'];
    for (let i = 0; i < WELCOME_ART.length; i++) {
      let artLine = WELCOME_ART[i] ?? '';
      if (this.glitchFrame > 0) {
        const chars = [...artLine];
        const glitchCount = 1 + (this.glitchFrame % 3);
        for (let g = 0; g < glitchCount; g++) {
          const pos = (this.glitchFrame * 7 + g * 13 + i * 3) % chars.length;
          if (chars[pos] !== ' ') {
            chars[pos] = glitchChars[(this.glitchFrame + g + i) % glitchChars.length] ?? '█';
          }
        }
        artLine = chars.join('');
      }
      const centered = this.centerLine(`${PINK}${artLine}${RESET}`, cols);
      lines.push(MAIN_BG + centered + RESET);
    }

    lines.push(MAIN_BG + ' '.repeat(cols) + RESET);
    lines.push(MAIN_BG + this.centerLine(`${PINK}♪ DDUDUDDUDU${RESET}  ${DIM}v0.2.0${RESET}`, cols) + RESET);
    lines.push(MAIN_BG + this.centerLine(`${DIM}Multi-Agent Orchestration Harness${RESET}`, cols) + RESET);
    lines.push(MAIN_BG + ' '.repeat(cols) + RESET);
    lines.push(MAIN_BG + ' '.repeat(cols) + RESET);

    const boxLeft = Math.max(0, Math.floor((cols - boxWidth) / 2));
    const pad = ' '.repeat(boxLeft);
    const innerW = boxWidth - 2;
    const inputContent = this.inputBar.render(innerW)[0] ?? '';
    const inputVis = visibleLength(inputContent);
    const inputPad = Math.max(0, innerW - inputVis);
    const paddedInput = `${inputContent}${MAIN_BG}${' '.repeat(inputPad)}`;

    lines.push(MAIN_BG + pad + `${PINK_DIM}${BOX_TL}${BOX_H.repeat(innerW)}${BOX_TR}${RESET}` + MAIN_BG + ' '.repeat(Math.max(0, cols - boxWidth - boxLeft)) + RESET);
    lines.push(MAIN_BG + pad + `${PINK_DIM}${BOX_V}${RESET}${MAIN_BG}${paddedInput}${PINK_DIM}${BOX_V}${RESET}` + MAIN_BG + ' '.repeat(Math.max(0, cols - boxWidth - boxLeft)) + RESET);
    lines.push(MAIN_BG + pad + `${PINK_DIM}${BOX_BL}${BOX_H.repeat(innerW)}${BOX_BR}${RESET}` + MAIN_BG + ' '.repeat(Math.max(0, cols - boxWidth - boxLeft)) + RESET);

    lines.push(MAIN_BG + ' '.repeat(cols) + RESET);
    const bpMode = BLACKPINK_MODES[this.activeMode];
    const footer = `${PINK}${bpMode?.label ?? 'JENNIE'}${RESET} ${PINK_DIM}${this.config.model}${RESET}   ${DIM}Shift+Tab mode · /help commands${RESET}`;
    lines.push(MAIN_BG + this.centerLine(footer, cols) + RESET);

    while (lines.length < rows) lines.push(MAIN_BG + ' '.repeat(cols) + RESET);
    if (lines.length > rows) lines.length = rows;

    const inputRow = topPad + artLines + 5 + 2;
    const cursorCol = boxLeft + 1 + this.inputBar.getCursorColumn() + 1;

    return { lines, cursor: { row: inputRow, col: cursorCol } };
  }

  private centerLine(content: string, width: number): string {
    const vis = visibleLength(content);
    const leftPad = Math.max(0, Math.floor((width - vis) / 2));
    const rightPad = Math.max(0, width - vis - leftPad);
    return ' '.repeat(leftPad) + content + ' '.repeat(rightPad);
  }

  private getTabHistory(tabId: string): ApiMessage[] {
    const existing = this.tabConversations.get(tabId);
    if (existing) return existing;
    const fresh: ApiMessage[] = [];
    this.tabConversations.set(tabId, fresh);
    return fresh;
  }

  private async handleSubmit(value: string): Promise<void> {
    if (this.showSplash) {
      this.showSplash = false;
      if (this.glitchTimer) {
        clearInterval(this.glitchTimer);
        this.glitchTimer = null;
      }
      this.ensureInitialTab();
      this.renderer.clear();
    }

    const active = this.tabManager.getActiveTab();
    if (!active || value.length === 0) {
      this.renderer.requestRender();
      return;
    }

    if (this.pendingQuestion && active.id === this.pendingQuestion.tabId) {
      this.resolveQuestion(value);
      return;
    }

    if (active.agentId && active.status === 'working') {
      this.messageQueue.push(value);
      active.lines.push(fmtSystem(`⊕ Queued (${this.messageQueue.length} in queue)`));
      active.lines.push('');
      this.chatView.setLines(active.lines);
      this.renderer.requestRender();
      return;
    }

    this.autocomplete.dismiss();

    if (value.startsWith('!') || this.bashMode) {
      const command = value.startsWith('!') ? value.slice(1) : value;
      if (command.trim().length > 0) {
        active.lines.push(fmtUser(value));
        active.lines.push('');
        this.chatView.setLines(active.lines);
        this.renderer.requestRender();

        void this.bashRunner.execute(command).then((result) => {
          active.lines.push(...this.bashRunner.formatForChat(result, command).split('\n'));
          active.lines.push('');
          this.chatView.setLines(active.lines);
          this.renderer.requestRender();
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          active.lines.push(fmtError(msg));
          active.lines.push('');
          this.chatView.setLines(active.lines);
          this.renderer.requestRender();
        });
        return;
      }
    }

    if (value.trim() === '/bash') {
      this.bashMode = !this.bashMode;
      active.lines.push(fmtSystem(`Bash mode ${this.bashMode ? 'enabled' : 'disabled'}`));
      active.lines.push('');
      this.chatView.setLines(active.lines);
      this.renderer.requestRender();
      return;
    }

    const cmdResult = executeCommand(value, () => ({
      provider: this.config.provider,
      model: this.config.model,
      version: '0.2.0',
      cwd: process.cwd(),
      tabCount: this.tabManager.getTabs().length,
      activeTabName: active.name,
      queueLength: this.messageQueue.length,
    }));

    if (cmdResult) {
      active.lines.push(fmtUser(value));
      active.lines.push(...cmdResult.lines);
      active.lines.push('');

      if (cmdResult.action === 'exit') {
        this.chatView.setLines(active.lines);
        this.renderer.requestRender();
        setTimeout(() => this.stop(), 100);
        process.exitCode = 0;
        return;
      }

      if (cmdResult.action === 'clear') {
        active.lines = [];
        this.tabConversations.delete(active.id);
        this.chatView.setLines([]);
        this.renderer.clear();
        this.renderer.requestRender();
        return;
      }

      if (cmdResult.action === 'reset') {
        active.lines = [];
        this.tabConversations.delete(active.id);
        this.chatView.setLines([]);
        this.renderer.clear();
        this.ensureInitialTab();
        this.renderer.requestRender();
        return;
      }

      if (cmdResult.action === 'undo') {
        void this.handleUndo(active);
      }
      if (cmdResult.action === 'handoff') {
        void this.handleHandoff(active, cmdResult.actionData ?? '');
      }
      if (cmdResult.action === 'review') {
        void this.handleReview(active);
      }
      if (cmdResult.action === 'fork') {
        this.handleFork(active);
      }
      if (cmdResult.action === 'skill') {
        void this.handleSkillCommand(active, cmdResult.actionData);
      }
      if (cmdResult.action === 'briefing') {
        this.handleBriefing(active);
      }
      if (cmdResult.action === 'mode_switch') {
        this.handleModeSwitch(active, cmdResult.actionData ?? '');
      }
      if (cmdResult.action === 'compact') {
        void this.handleCompact(active);
      }
      if (cmdResult.action === 'status') {
        this.handleStatus(active);
      }
      if (cmdResult.action === 'queue_clear') {
        this.messageQueue.length = 0;
        active.lines.push(fmtSystem('Message queue cleared.'));
      }

      this.chatView.setLines(active.lines);
      this.renderer.requestRender();
      return;
    }

    if (!this.resolvedToken) {
      active.lines.push(fmtUser(value));
      active.lines.push(fmtError('No API token. Set ANTHROPIC_API_KEY or configure Claude Code OAuth.'));
      active.lines.push(fmtSystem('Run: ddudu doctor'));
      active.lines.push('');
      this.chatView.setLines(active.lines);
      this.renderer.requestRender();
      return;
    }

    const history = this.getTabHistory(active.id);

    let resolvedContext = '';
    const mentionTokens = value.match(/@[\w./-]+/gu) ?? [];
    if (mentionTokens.length > 0) {
      const mentionItems = mentionTokens.map((token) => {
        if (token === '@codebase') {
          return { type: 'codebase' as const, name: token };
        }
        if (token === '@git') {
          return { type: 'git' as const, name: token };
        }
        if (token === '@session') {
          return { type: 'session' as const, name: token };
        }
        return {
          type: 'file' as const,
          name: token,
          path: token.slice(1),
        };
      });

      try {
        resolvedContext = await resolveMultipleMentions(mentionItems, process.cwd());
      } catch {
        resolvedContext = '';
      }
    }

    const userContent = resolvedContext.length > 0
      ? `${value}\n\n<context>\n${resolvedContext}\n</context>`
      : value;

    history.push({ role: 'user', content: userContent });

    active.lines.push(fmtUser(value));
    active.lines.push('');
    active.status = 'working';

    active.lines.push(fmtThinking(`${SPINNER[0] ?? '⠋'} ${BP_LYRICS[0] ?? 'Playing with fire...'}`));
    this.spinnerLineIdx = active.lines.length - 1;
    this.spinnerFrame = 0;
    this.spinnerTick = 0;
    this.bpLyricIndex = 0;
    this.spinnerGotOutput = false;
    this.chatView.setLines(active.lines);
    this.renderer.requestRender();

    this.spinnerTimer = setInterval(() => {
      if (!active || active.status !== 'working') {
        this.stopSpinner();
        return;
      }
      this.spinnerTick += 1;
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      if (this.spinnerTick % 25 === 0) {
        this.bpLyricIndex = (this.bpLyricIndex + 1) % BP_LYRICS.length;
      }
      if (this.spinnerLineIdx >= 0 && this.spinnerLineIdx < active.lines.length) {
        const lyric = BP_LYRICS[this.bpLyricIndex % BP_LYRICS.length] ?? 'Playing with fire...';
        active.lines[this.spinnerLineIdx] = fmtThinking(`${SPINNER[this.spinnerFrame] ?? '⠋'} ${lyric}`);
        this.chatView.setLines(active.lines);
        this.renderer.requestRender();
      }
    }, 80);

    const abortController = new AbortController();
    active.agentId = active.id;
    this.activeAbort.set(active.id, abortController);

    this.startStreamingLoop(active, history, abortController, 0);
  }

  private startStreamingLoop(
    active: Tab,
    history: ApiMessage[],
    abortController: AbortController,
    depth: number,
  ): void {
    if (depth > MAX_TOOL_LOOP_DEPTH) {
      this.clearSpinner(active);
      active.lines.push(fmtError(`Max tool call depth (${MAX_TOOL_LOOP_DEPTH}) exceeded.`));
      active.lines.push('');
      this.finalizeStream(active);
      return;
    }

    if (!this.resolvedToken) return;

    const client = new AnthropicClient({
      token: this.resolvedToken.token,
      baseUrl: this.resolvedToken.baseUrl,
      model: this.config.model,
      maxTokens: 8192,
    });

    const apiTools = formatToolsForApi(this.toolRegistry);
    let lineBuffer = '';

    client.stream(
      this.systemPrompt,
      history,
      {
        onText: (text: string) => {
          if (abortController.signal.aborted) return;

          if (!this.spinnerGotOutput) {
            this.spinnerGotOutput = true;
            this.clearSpinner(active);
          }

          const combined = lineBuffer + text;
          const segments = combined.split('\n');
          lineBuffer = segments.pop() ?? '';

          for (const segment of segments) {
            active.lines.push(fmtAssistant(segment));
          }

          this.chatView.setLines(
            lineBuffer.length > 0
              ? [...active.lines, fmtAssistant(lineBuffer)]
              : active.lines,
          );
          this.renderer.requestRender();
        },

        onToolUse: (toolBlocks: ToolUseContentBlock[], textSoFar: string, usage: { input: number; output: number }) => {
          if (abortController.signal.aborted) return;

          this.clearSpinner(active);

          if (lineBuffer.length > 0) {
            active.lines.push(fmtAssistant(lineBuffer));
            lineBuffer = '';
          }

          const contentBlocks: ContentBlock[] = [];
          if (textSoFar.length > 0) {
            contentBlocks.push({ type: 'text', text: textSoFar });
          }
          for (const block of toolBlocks) {
            contentBlocks.push(block);
          }
          history.push({ role: 'assistant', content: contentBlocks });

          this.tokenCounter.addUsage(usage.input, usage.output);

          for (const block of toolBlocks) {
            active.lines.push(fmtSystem(`⚡ ${block.name}`));
          }
          this.chatView.setLines(active.lines);
          this.renderer.requestRender();

          void this.executeToolsAndContinue(active, history, abortController, toolBlocks, depth);
        },

        onError: (error: Error) => {
          if (abortController.signal.aborted) return;

          this.clearSpinner(active);

          if (lineBuffer.length > 0) {
            active.lines.push(fmtAssistant(lineBuffer));
            lineBuffer = '';
          }

          if (history.length > 0 && history[history.length - 1]?.role === 'user') {
            history.pop();
          }

          active.lines.push(fmtError(error.message));
          active.lines.push('');
          this.finalizeStream(active);
        },

        onDone: (fullText: string, usage: { input: number; output: number }) => {
          if (abortController.signal.aborted) return;

          this.clearSpinner(active);

          if (lineBuffer.length > 0) {
            active.lines.push(fmtAssistant(lineBuffer));
            lineBuffer = '';
          }

          history.push({ role: 'assistant', content: fullText });

          active.lines.push(fmtSystem(`${usage.input}→${usage.output} tokens`));
          this.tokenCounter.addUsage(usage.input, usage.output);
          active.lines.push('');
          this.finalizeStream(active);
        },
      },
      abortController.signal,
      apiTools,
    ).catch(() => {});
  }

  private async executeToolsAndContinue(
    active: Tab,
    history: ApiMessage[],
    abortController: AbortController,
    toolBlocks: ToolUseContentBlock[],
    depth: number,
  ): Promise<void> {
    if (abortController.signal.aborted) return;

    const executorBlocks: ToolUseBlock[] = toolBlocks.map((block) => ({
      type: 'tool_use' as const,
      id: block.id,
      name: block.name,
      input: block.input,
    }));

    const results = await executeToolCalls(executorBlocks, this.toolRegistry, {
      cwd: process.cwd(),
      abortSignal: abortController.signal,
      askUser: (question: string, options?: string[]) => this.askUserInteractive(active, question, options),
    });

    for (const result of results) {
      const preview = result.content.length > 200
        ? result.content.slice(0, 197) + '...'
        : result.content;
      const icon = result.is_error ? '✗' : '✓';
      active.lines.push(fmtSystem(`${icon} ${preview}`));
    }
    this.chatView.setLines(active.lines);
    this.renderer.requestRender();

    const toolResultBlocks: ContentBlock[] = results.map((r) => ({
      type: 'tool_result' as const,
      tool_use_id: r.tool_use_id,
      content: r.content,
      is_error: r.is_error,
    }));
    history.push({ role: 'user', content: toolResultBlocks });

    this.spinnerGotOutput = false;
    active.lines.push(fmtThinking(`${SPINNER[0] ?? '⠋'} ${BP_LYRICS[0] ?? 'Playing with fire...'}`));
    this.spinnerLineIdx = active.lines.length - 1;
    this.spinnerFrame = 0;
    this.spinnerTick = 0;
    this.bpLyricIndex = 0;
    this.chatView.setLines(active.lines);
    this.renderer.requestRender();

    this.startStreamingLoop(active, history, abortController, depth + 1);
  }

  private clearSpinner(active: Tab): void {
    this.stopSpinner();
    if (this.spinnerLineIdx >= 0 && this.spinnerLineIdx < active.lines.length) {
      active.lines.splice(this.spinnerLineIdx, 1);
      this.spinnerLineIdx = -1;
    }
  }

  private finalizeStream(active: Tab): void {
    active.status = 'idle';
    active.agentId = undefined;
    this.activeAbort.delete(active.id);

    if (this.messageQueue.length > 0) {
      active.lines.push(fmtSystem('▸ Processing queued message...'));
      active.lines.push('');
      const queuedMessage = this.messageQueue.shift();
      if (queuedMessage !== undefined) {
        process.nextTick(() => {
          void this.handleSubmit(queuedMessage);
        });
      }
    }

    this.chatView.setLines(active.lines);
    this.renderer.requestRender();
  }

  private async handleUndo(active: Tab): Promise<void> {
    const git = new GitCheckpoint(process.cwd());
    try {
      const available = await git.isAvailable();
      if (!available) {
        active.lines.push(fmtError('Not a git repository.'));
      } else {
        const success = await git.undo();
        active.lines.push(fmtSystem(success ? 'Last checkpoint reverted.' : 'No ddudu checkpoint to undo.'));
      }
    } catch (err: unknown) {
      active.lines.push(fmtError(err instanceof Error ? err.message : 'Undo failed.'));
    }
    active.lines.push('');
    this.chatView.setLines(active.lines);
    this.renderer.requestRender();
  }

  private async handleHandoff(active: Tab, goal: string): Promise<void> {
    const engine = new CompactionEngine();
    const history = this.getTabHistory(active.id);
    const messages = history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    try {
      const result = await engine.handoff(goal, messages);
      const tabNumber = this.tabManager.getTabs().length + 1;
      const tab = this.tabManager.addTab(`handoff${tabNumber}`);
      tab.lines = [
        fmtSystem(`Handoff: ${goal}`),
        '',
        ...result.summary.split('\n').map((l) => fmtSystem(l)),
        '',
      ];

      const newHistory = this.getTabHistory(tab.id);
      newHistory.push({
        role: 'user',
        content: `Continue from handoff. Goal: ${goal}\n\n${result.summary}`,
      });

      active.lines.push(fmtSystem(`Handed off to tab "${tab.name}".`));
      this.syncTabToView(tab);
    } catch (err: unknown) {
      active.lines.push(fmtError(err instanceof Error ? err.message : 'Handoff failed.'));
    }
    active.lines.push('');
    this.chatView.setLines(active.lines);
    this.renderer.requestRender();
  }

  private async handleReview(active: Tab): Promise<void> {
    const runner = new ChecksRunner(process.cwd());
    const git = new GitCheckpoint(process.cwd());

    try {
      const diff = await git.getDiff();
      const report = await runner.runAllChecks(diff);
      const formatted = runner.formatReport(report);
      active.lines.push(...formatted.split('\n').map((l) => fmtSystem(l)));
    } catch (err: unknown) {
      active.lines.push(fmtError(err instanceof Error ? err.message : 'Review failed.'));
    }
    active.lines.push('');
    this.chatView.setLines(active.lines);
    this.renderer.requestRender();
  }

  private handleFork(active: Tab): void {
    const tabNumber = this.tabManager.getTabs().length + 1;
    const tab = this.tabManager.addTab(`fork${tabNumber}`);
    tab.lines = [...active.lines];

    const history = this.getTabHistory(active.id);
    const newHistory = this.getTabHistory(tab.id);
    for (const msg of history) {
      newHistory.push({ ...msg });
    }

    active.lines.push(fmtSystem(`Forked to tab "${tab.name}".`));
    active.lines.push('');
    this.chatView.setLines(active.lines);
    this.renderer.requestRender();
  }

  private async handleSkillCommand(active: Tab, name?: string): Promise<void> {
    await this.skillLoader.scan().catch(() => {});

    if (!name) {
      const skills = this.skillLoader.list();
      if (skills.length === 0) {
        active.lines.push(fmtSystem('No skills found. Add SKILL.md files to .ddudu/skills/'));
      } else {
        active.lines.push(fmtSystem('Available skills:'));
        for (const skill of skills) {
          active.lines.push(fmtSystem(`  ${skill.name} — ${skill.description}`));
        }
      }
    } else {
      const skill = await this.skillLoader.load(name);
      if (skill) {
        this.systemPrompt += `\n\n<skill name="${skill.name}">\n${skill.content}\n</skill>`;
        active.lines.push(fmtSystem(`Skill "${skill.name}" loaded into context.`));
      } else {
        active.lines.push(fmtError(`Skill "${name}" not found.`));
      }
    }
    active.lines.push('');
    this.chatView.setLines(active.lines);
    this.renderer.requestRender();
  }

  private handleBriefing(active: Tab): void {
    const history = this.getTabHistory(active.id);
    const messages = history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    const briefing = generateBriefing(messages, this.epistemicState.getState());
    const formatted = formatBriefing(briefing);
    active.lines.push(...formatted.split('\n').map((l) => fmtSystem(l)));
    active.lines.push('');
    this.chatView.setLines(active.lines);
    this.renderer.requestRender();
  }

  private handleModeSwitch(active: Tab, modeInput: string): void {
    void active;
    const resolved = resolveModeName(modeInput);
    if (!resolved) return;

    const bpMode = BLACKPINK_MODES[resolved];
    if (!bpMode) return;

    this.config = { ...this.config, model: bpMode.model, provider: bpMode.provider };
    this.modelIndex = this.config.models.indexOf(bpMode.model);
    if (this.modelIndex < 0) this.modelIndex = 0;
    this.tokenCounter.setModel(bpMode.model);
    this.activeMode = resolved;

    this.systemPrompt = this.systemPrompt.replace(
      /\n\n<mode>[\s\S]*?<\/mode>/u,
      '',
    );
    this.systemPrompt += `\n\n<mode>${bpMode.promptAddition}</mode>`;
  }

  private async handleCompact(active: Tab): Promise<void> {
    const engine = new CompactionEngine();
    const history = this.getTabHistory(active.id);
    const messages = history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    try {
      const compacted = await engine.compact(messages);
      this.tabConversations.delete(active.id);
      const newHistory = this.getTabHistory(active.id);
      newHistory.push({ role: 'user', content: compacted });
      newHistory.push({ role: 'assistant', content: 'Context compacted. Ready to continue.' });

      active.lines.push(fmtSystem('Context compacted. Previous messages summarized.'));
    } catch (err: unknown) {
      active.lines.push(fmtError(err instanceof Error ? err.message : 'Compaction failed.'));
    }
    active.lines.push('');
    this.chatView.setLines(active.lines);
    this.renderer.requestRender();
  }

  private askUserInteractive(active: Tab, question: string, options?: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.clearSpinner(active);

      active.lines.push('');
      active.lines.push(fmtSystem(`❓ ${question}`));
      if (options && options.length > 0) {
        for (let i = 0; i < options.length; i++) {
          active.lines.push(fmtSystem(`  ${PINK}[${i + 1}]${RESET} ${options[i]}`));
        }
        active.lines.push(fmtSystem(`${DIM}Type a number to pick, or type your own answer.${RESET}`));
      }
      active.lines.push('');
      this.chatView.setLines(active.lines);
      this.renderer.requestRender();

      this.pendingQuestion = { resolve, reject, tabId: active.id };
    });
  }

  private resolveQuestion(answer: string): boolean {
    if (!this.pendingQuestion) return false;

    const pq = this.pendingQuestion;
    this.pendingQuestion = null;

    const active = this.tabManager.getActiveTab();
    if (!active || active.id !== pq.tabId) {
      pq.reject(new Error('Tab switched while waiting for answer.'));
      return true;
    }

    active.lines.push(fmtUser(answer));
    active.lines.push('');
    this.chatView.setLines(active.lines);
    this.renderer.requestRender();

    pq.resolve(answer);

    active.lines.push(fmtThinking(`${SPINNER[0] ?? '⠋'} ${BP_LYRICS[0] ?? 'Playing with fire...'}`));
    this.spinnerLineIdx = active.lines.length - 1;
    this.spinnerFrame = 0;
    this.spinnerTick = 0;
    this.bpLyricIndex = 0;
    this.spinnerGotOutput = false;
    this.chatView.setLines(active.lines);
    this.renderer.requestRender();

    return true;
  }

  private handleStatus(active: Tab): void {
    const stats = this.epistemicState.getStats();
    active.lines.push(fmtSystem('Epistemic State:'));
    active.lines.push(fmtSystem(`  Facts: ${stats.facts}  Conclusions: ${stats.conclusions}`));
    active.lines.push(fmtSystem(`  Uncertainties: ${stats.uncertainties}  Decisions: ${stats.decisions}`));
    if (stats.invalidated > 0) {
      active.lines.push(fmtSystem(`  Invalidated: ${stats.invalidated}`));
    }
    active.lines.push(fmtSystem(`  Tokens: ${this.tokenCounter.getTotalInputTokens()}→${this.tokenCounter.getTotalOutputTokens()}`));
    active.lines.push('');
    this.chatView.setLines(active.lines);
    this.renderer.requestRender();
  }

  private cycleMode(): void {
    const modeOrder = ['jennie', 'lisa', 'rosé', 'jisoo'];
    const currentIdx = modeOrder.indexOf(this.activeMode);
    const nextIdx = (currentIdx + 1) % modeOrder.length;
    const nextModeName = modeOrder[nextIdx] ?? 'jennie';
    const bpMode = BLACKPINK_MODES[nextModeName];
    if (!bpMode) return;

    this.config = { ...this.config, model: bpMode.model, provider: bpMode.provider };
    this.activeMode = nextModeName;
    this.tokenCounter.setModel(bpMode.model);

    this.systemPrompt = this.systemPrompt.replace(/\n\n<mode>[\s\S]*?<\/mode>/u, '');
    this.systemPrompt += `\n\n<mode>${bpMode.promptAddition}</mode>`;
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  private createTab(): void {
    const tabNumber = this.tabManager.getTabs().length + 1;
    const tab = this.tabManager.addTab(`tab${tabNumber}`);
    this.syncTabToView(tab);
  }

  private ensureInitialTab(): void {
    if (this.tabManager.getTabs().length > 0) return;

    const initialTab = this.tabManager.addTab('main');
    initialTab.lines = [
      '',
      `  ${PINK}DDUDUDDUDU${RESET}  ${DIM}v0.2.0${RESET}  ${DIM}🔥 PLAYING_WITH_FIRE${RESET}`,
      `  ${DIM}${this.config.provider} / ${this.config.model}${RESET}`,
      '',
    ];
    this.syncTabToView(initialTab);
  }

  private syncTabToView(tab: Tab): void {
    this.chatView.setLines(tab.lines);
  }

  private buildFooterContent(width: number, mode?: BlackpinkMode): string {
    const modeName = mode?.label ?? 'JENNIE';
    const shortModel = this.config.model.replace('claude-', '').replace('sonnet-', 's').replace('opus-', 'o').replace('haiku-', 'h');
    const queueLen = this.messageQueue?.length ?? 0;
    const queueTag = queueLen > 0 ? ` ${DIM}queue:${queueLen}${RESET}` : '';
    const tokenIn = this.tokenCounter.getTotalInputTokens();
    const tokenOut = this.tokenCounter.getTotalOutputTokens();
    const tokenTag = (tokenIn + tokenOut) > 0 ? `${DIM}${tokenIn}→${tokenOut}${RESET}` : '';
    const ctxPct = this.tokenCounter.getUsagePercent();
    const ctxTag = ctxPct > 0 ? `${DIM}ctx:${(ctxPct * 100).toFixed(0)}%${RESET} ` : '';
    const prefixTag = this.prefixMode ? `${PINK}⌨ PREFIX${RESET} ` : '';
    const fireMode = `${DIM}🔥 PLAYING_WITH_FIRE${RESET}`;

    const left = ` ${PINK}${modeName}${RESET} ${PINK_DIM}${shortModel}${RESET}${queueTag} ${fireMode}`;
    const right = `${prefixTag}${ctxTag}${tokenTag} ${GRAY}Ctrl+B cmds · /help${RESET} `;

    const leftVis = visibleLength(left);
    const rightVis = visibleLength(right);
    const gap = Math.max(1, width - leftVis - rightVis);
    return left + ' '.repeat(gap) + right;
  }

  private handleResize(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.renderer.invalidate();
      this.renderer.requestRender();
    }, 30);
  }

  private parseCtrlDigit(data: string): number | null {
    const csiU = data.match(/^\u001b\[(\d+);5u$/u);
    const csiTilde = data.match(/^\u001b\[(\d+);5~$/u);
    const code = csiU?.[1] ?? csiTilde?.[1];

    if (!code) return null;

    const value = Number.parseInt(code, 10);
    if (value >= 49 && value <= 56) {
      return value - 48;
    }

    return null;
  }
}

export type { TuiAppConfig };
