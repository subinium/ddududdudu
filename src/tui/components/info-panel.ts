import type { Component } from '../terminal.js';
import {
  PINK, PINK_LIGHT, PINK_DIM, DIM, GRAY, GREEN, YELLOW, RED, RESET, BOLD, WHITE_BRIGHT,
  PANEL_BG, PANEL_HEADER_BG,
  visibleLength,
} from '../colors.js';

export interface InfoPanelState {
  model: string;
  provider: string;
  status: 'ready' | 'thinking' | 'streaming' | 'error';
  sessionId: string;
  cwd: string;
  tabCount: number;
  modelIndex: number;
  modelCount: number;
  mode?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  contextPercent?: number;
  taskCount?: number;
  mcpServers?: number;
  recentFiles?: string[];
  lastResponseMs?: number;
}

export const INFO_PANEL_WIDTH = 36;
export const INFO_PANEL_MIN_TERMINAL = 100;

export class InfoPanel implements Component {
  private state: InfoPanelState = {
    model: '',
    provider: '',
    status: 'ready',
    sessionId: '-',
    cwd: '',
    tabCount: 1,
    modelIndex: 0,
    modelCount: 1,
  };

  public update(next: Partial<InfoPanelState>): void {
    this.state = { ...this.state, ...next };
  }

  public render(width: number, height = 1): string[] {
    const innerW = Math.max(1, width);
    const contextPercent = this.clampPercent(this.state.contextPercent ?? 0);
    const barWidth = Math.max(1, innerW - 4);
    const filled = Math.round(barWidth * contextPercent);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`;
    const barColor = contextPercent > 0.8 ? RED : contextPercent >= 0.6 ? YELLOW : GREEN;

    const statusText = this.getStatusText();
    const statusIcon = statusText === 'error'
      ? `${RED}✗${RESET}`
      : statusText === 'streaming'
        ? `${PINK_LIGHT}▸${RESET}`
        : `${PINK}⚡${RESET}`;

    const tokenUsage = this.state.tokenUsage;
    const totalTokens = tokenUsage?.totalTokens ?? 0;
    const estimatedCost = tokenUsage?.estimatedCost ?? 0;
    const modeText = this.state.mode ? `${PINK_LIGHT}[${this.state.mode}]${RESET}` : `${DIM}[smart]${RESET}`;
    const recentFiles = (this.state.recentFiles ?? []).slice(-3);
    const shortModel = this.truncate(this.state.model || '-', innerW - 1);
    const shortProvider = this.truncate(this.state.provider || '-', innerW - 1);
    const shortCwd = this.truncate(this.state.cwd || '-', innerW - 1);
    const responseTime = this.state.lastResponseMs != null ? `${this.state.lastResponseMs}ms` : '-';

    const contentLines: string[] = [
      this.headerLine('♪ ddudu', innerW),
      this.emptyLine(innerW),
      this.sectionLine('CONTEXT', innerW),
      this.dataLine('tokens', totalTokens.toLocaleString(), innerW),
      this.dataLine('usage', `${(contextPercent * 100).toFixed(1)}%`, innerW),
      this.dataLine('cost', `$${this.formatCost(estimatedCost)}`, innerW),
      this.barLine(barColor, bar, innerW),
      this.emptyLine(innerW),
      this.sectionLine('MODEL', innerW),
      this.textLine(` ${PINK_LIGHT}${shortModel}${RESET}`, innerW),
      this.textLine(` ${DIM}${shortProvider}${RESET}`, innerW),
      this.textLine(` ${modeText}`, innerW),
      this.emptyLine(innerW),
      this.sectionLine('STATUS', innerW),
      this.textLine(` ${statusIcon} ${statusText}`, innerW),
      this.dataLine('last', responseTime, innerW),
      this.emptyLine(innerW),
      this.sectionLine('TASKS', innerW),
      this.dataLine('active', String(this.state.taskCount ?? 0), innerW),
      this.emptyLine(innerW),
      this.sectionLine('MCP', innerW),
      this.dataLine('servers', String(this.state.mcpServers ?? 0), innerW),
      this.emptyLine(innerW),
      this.sectionLine('FILES', innerW),
      this.textLine(` ${DIM}${this.truncate(recentFiles[0] ?? '-', innerW - 1)}${RESET}`, innerW),
      this.textLine(` ${DIM}${this.truncate(recentFiles[1] ?? '-', innerW - 1)}${RESET}`, innerW),
      this.textLine(` ${DIM}${this.truncate(recentFiles[2] ?? '-', innerW - 1)}${RESET}`, innerW),
      this.emptyLine(innerW),
      this.sectionLine('SESSION', innerW),
      this.textLine(` ${DIM}${this.truncate(this.state.sessionId || '-', innerW - 1)}${RESET}`, innerW),
      this.textLine(` ${DIM}${shortCwd}${RESET}`, innerW),
    ];

    const shortcuts: string[] = [
      this.emptyLine(innerW),
      this.textLine(` ${DIM}Ctrl+T  new tab${RESET}`, innerW),
      this.textLine(` ${DIM}Ctrl+W  close${RESET}`, innerW),
      this.textLine(` ${DIM}/help   commands${RESET}`, innerW),
    ];

    const lines: string[] = [];
    const maxContent = Math.max(0, height - shortcuts.length);

    for (let i = 0; i < maxContent && i < contentLines.length; i++) {
      lines.push(contentLines[i]);
    }

    while (lines.length < maxContent) {
      lines.push(this.emptyLine(innerW));
    }

    const shortcutStart = height - shortcuts.length;
    for (let i = 0; i < shortcuts.length; i++) {
      if (shortcutStart + i >= maxContent) {
        lines.push(shortcuts[i]);
      }
    }

    while (lines.length < height) {
      lines.push(this.emptyLine(innerW));
    }

    return lines.slice(0, height);
  }

  private headerLine(text: string, innerW: number): string {
    const content = ` ${PINK}${BOLD}${text}${RESET}`;
    return `${PANEL_HEADER_BG}${this.padBg(content, innerW, PANEL_HEADER_BG)}${RESET}`;
  }

  private sectionLine(label: string, innerW: number): string {
    const content = ` ${PINK}${BOLD}${label}${RESET}`;
    return `${PANEL_HEADER_BG}${this.padBg(content, innerW, PANEL_HEADER_BG)}${RESET}`;
  }

  private dataLine(label: string, value: string, innerW: number): string {
    const content = ` ${GRAY}${label}${RESET} ${WHITE_BRIGHT}${value}${RESET}`;
    return `${PANEL_BG}${this.padBg(content, innerW)}${RESET}`;
  }

  private barLine(color: string, bar: string, innerW: number): string {
    const content = ` ${color}${bar}${RESET}`;
    return `${PANEL_BG}${this.padBg(content, innerW)}${RESET}`;
  }

  private textLine(content: string, innerW: number): string {
    return `${PANEL_BG}${this.padBg(content, innerW)}${RESET}`;
  }

  private emptyLine(innerW: number): string {
    return `${PANEL_BG}${' '.repeat(innerW)}${RESET}`;
  }

  private padBg(text: string, width: number, bg: string = PANEL_BG): string {
    const vis = visibleLength(text);
    if (vis >= width) return text;
    return text + bg + ' '.repeat(width - vis);
  }

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + '…';
  }

  private clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  private formatCost(value: number): string {
    return value.toFixed(4);
  }

  private getStatusText(): 'idle' | 'streaming' | 'error' {
    if (this.state.status === 'error') return 'error';
    if (this.state.status === 'streaming') return 'streaming';
    return 'idle';
  }
}
