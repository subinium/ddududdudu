import type { Component } from '../terminal.js';
import type { Tab } from '../tab-manager.js';
import { PINK, PINK_BG, WHITE, DIM, RESET, visibleLength } from '../colors.js';

interface StatusBarState {
  tabs: readonly Tab[];
  activeTabId: string;
  provider: string;
  model: string;
  mode?: string;
  status: 'ready' | 'thinking' | 'streaming';
}

export class StatusBar implements Component {
  private state: StatusBarState = {
    tabs: [],
    activeTabId: '',
    provider: 'provider',
    model: 'model',
    status: 'ready',
  };

  public update(nextState: Partial<StatusBarState>): void {
    this.state = { ...this.state, ...nextState };
  }

  public render(width: number): string[] {
    const left = this.buildLeft();
    const right = this.buildRight();

    const leftVis = visibleLength(left);
    const rightVis = visibleLength(right);
    const gap = Math.max(1, width - leftVis - rightVis);

    return [left + ' '.repeat(gap) + right];
  }

  private buildLeft(): string {
    const brand = `${PINK}♪ ddudu${RESET}`;
    const tabText = this.state.tabs
      .map((tab, index) => {
        const working = tab.status === 'working' ? ' ⟳' : '';
        const label = `${index + 1}:${tab.name}${working}`;
        if (tab.id === this.state.activeTabId) {
          return `${PINK_BG}${WHITE} ${label} ${RESET}`;
        }
        return `${DIM} ${label} ${RESET}`;
      })
      .join('');

    return `${brand} ${tabText}`;
  }

  private buildRight(): string {
    const statusIcon = this.state.status === 'ready'
      ? `${PINK}⚡${RESET}`
      : this.state.status === 'thinking'
        ? `${DIM}⠋${RESET}`
        : `${PINK}▸${RESET}`;

    const shortModel = this.state.model.replace('claude-', '').replace('sonnet-', 's').replace('opus-', 'o');
    const modeBadge = this.state.mode
      ? `${DIM}[${this.state.mode}]${RESET} `
      : '';
    return `${statusIcon} ${modeBadge}${PINK}${this.state.provider}${RESET}${DIM}/${shortModel}${RESET} `;
  }
}
