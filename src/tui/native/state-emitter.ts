import type { NativeBridgeEvent, NativeTuiState } from './protocol.js';

interface StateEmitterOptions {
  emit: (event: NativeBridgeEvent) => void;
  getState: () => NativeTuiState;
  syncUsageState: () => void;
  syncLspState: () => void;
}

const cloneState = (state: NativeTuiState): NativeTuiState => ({
  ...state,
  requestEstimate: state.requestEstimate ? { ...state.requestEstimate } : null,
  queuedPrompts: [...state.queuedPrompts],
  messages: state.messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls ? [...message.toolCalls] : undefined,
  })),
  providers: state.providers.map((provider) => ({ ...provider })),
  mcp: state.mcp
    ? {
        ...state.mcp,
        serverNames: [...state.mcp.serverNames],
        connectedNames: [...state.mcp.connectedNames],
      }
    : null,
  lsp: state.lsp
    ? {
        ...state.lsp,
        serverLabels: [...state.lsp.serverLabels],
        connectedLabels: [...state.lsp.connectedLabels],
      }
    : null,
  modes: state.modes.map((mode) => ({ ...mode })),
  slashCommands: state.slashCommands.map((command) => ({ ...command })),
  todos: state.todos.map((item) => ({ ...item })),
  backgroundJobs: state.backgroundJobs.map((job) => ({ ...job })),
  artifacts: state.artifacts.map((artifact) => ({ ...artifact })),
  askUser: state.askUser
    ? {
        ...state.askUser,
        validation: state.askUser.validation ? { ...state.askUser.validation } : null,
        options: state.askUser.options.map((option) => ({ ...option })),
      }
    : null,
});

export class StateEmitter {
  private flushTimer: NodeJS.Timeout | null = null;
  private stateVersion = 0;
  private lastEmittedStateVersion = -1;

  public constructor(private readonly options: StateEmitterOptions) {}

  public emitNow(): void {
    if (this.stateVersion === this.lastEmittedStateVersion) {
      return;
    }

    this.options.syncUsageState();
    this.options.syncLspState();

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.lastEmittedStateVersion = this.stateVersion;
    this.options.emit({
      type: 'state',
      state: cloneState(this.options.getState()),
    });
  }

  public schedule(): void {
    this.stateVersion += 1;
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.emitNow();
    }, 16);
  }

  public dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
