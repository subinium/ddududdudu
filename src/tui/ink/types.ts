import type { NamedMode } from '../../core/types.js';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ToolCallInfo {
  id: string;
  name: string;
  args: string;
  result?: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  thinking?: string;
  toolCalls?: ToolCallInfo[];
  isStreaming?: boolean;
}

export type AppScreen = 'splash' | 'chat';

export interface TabState {
  id: string;
  name: string;
  messages: ChatMessage[];
  scrollOffset: number;
  isActive: boolean;
}

export interface AutocompleteItem {
  label: string;
  description: string;
  value: string;
}

export type AutocompleteKind = 'slash' | 'path' | 'none';

export interface AutocompleteState {
  kind: AutocompleteKind;
  items: AutocompleteItem[];
  selectedIndex: number;
  visible: boolean;
  query: string;
}

export interface AskUserPrompt {
  question: string;
  options?: string[];
  selectedIndex: number;
}

export interface AppState {
  screen: AppScreen;
  mode: NamedMode;
  tabs: TabState[];
  activeTabIndex: number;
  isLoading: boolean;
  loadingLyric: string;
  inputValue: string;
  inputResetVersion: number;
  sidebarVisible: boolean;
  autocomplete: AutocompleteState;
  prefixMode: boolean;
  playingWithFire: boolean;
  contextPercent: number;
  tokenCount: { input: number; output: number; cost: number };
  queuedPrompts: string[];
  askUserPrompt: AskUserPrompt | null;
}

export type AppAction =
  | { type: 'SET_SCREEN'; screen: AppScreen }
  | { type: 'SET_MODE'; mode: NamedMode }
  | { type: 'CYCLE_MODE' }
  | { type: 'ADD_MESSAGE'; message: ChatMessage }
  | { type: 'UPDATE_MESSAGE'; id: string; content: string; thinking?: string; toolCalls?: ToolCallInfo[] }
  | { type: 'FINISH_MESSAGE'; id: string; content: string }
  | { type: 'SET_LOADING'; loading: boolean; lyric?: string }
  | { type: 'SET_INPUT'; value: string }
  | { type: 'SET_SCROLL'; offset: number }
  | { type: 'SCROLL_DELTA'; delta: number }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_PREFIX_MODE'; active: boolean }
  | { type: 'TOGGLE_FIRE_MODE' }
  | { type: 'SET_CONTEXT'; percent: number }
  | { type: 'SET_TOKENS'; input: number; output: number; cost: number }
  | { type: 'ADD_TAB'; name?: string }
  | { type: 'CLOSE_TAB'; index: number }
  | { type: 'SWITCH_TAB'; index: number }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'SET_AUTOCOMPLETE'; state: Partial<AutocompleteState> }
  | { type: 'HIDE_AUTOCOMPLETE' }
  | { type: 'ENQUEUE_PROMPT'; prompt: string }
  | { type: 'DEQUEUE_PROMPT' }
  | { type: 'SET_TOOL_STATUS'; messageId: string; toolId: string; status: ToolCallInfo['status']; result?: string }
  | { type: 'ASK_USER'; question: string; options?: string[] }
  | { type: 'SET_ASK_USER_SELECTION'; selectedIndex: number }
  | { type: 'ANSWER_USER' };

export const SLASH_COMMANDS: AutocompleteItem[] = [
  { label: '/clear', description: 'Clear current conversation', value: '/clear' },
  { label: '/compact', description: 'Compact context to save tokens', value: '/compact' },
  { label: '/mode', description: 'Switch BLACKPINK mode', value: '/mode' },
  { label: '/model', description: 'Change model within current provider', value: '/model' },
  { label: '/memory', description: 'View or edit memory', value: '/memory' },
  { label: '/session', description: 'Session management', value: '/session' },
  { label: '/config', description: 'Show current configuration', value: '/config' },
  { label: '/help', description: 'Show available commands', value: '/help' },
  { label: '/doctor', description: 'Check system health', value: '/doctor' },
  { label: '/quit', description: 'Exit ddudu', value: '/quit' },
  { label: '/fire', description: 'Toggle PLAYING_WITH_FIRE mode', value: '/fire' },
  { label: '/init', description: 'Initialize project config', value: '/init' },
  { label: '/skill', description: 'List loaded skills', value: '/skill' },
  { label: '/hook', description: 'List active hooks', value: '/hook' },
  { label: '/mcp', description: 'MCP server management', value: '/mcp' },
  { label: '/team', description: 'Team agent management', value: '/team' },
];
