import React, { useCallback, useReducer, useRef } from 'react';
import { Box, Text } from 'ink';
import type { DduduConfig, NamedMode } from '../../core/types.js';
import { BLACKPINK_MODES, BP, MODE_ORDER } from './theme.js';
import { SIDEBAR_MIN_TERMINAL, SIDEBAR_WIDTH, useTerminal } from './hooks/useTerminal.js';
import type {
  AppAction,
  AppState,
  AskUserPrompt,
  AutocompleteItem,
  AutocompleteState,
  ChatMessage,
  ToolCallInfo,
  TabState,
} from './types.js';
import { SLASH_COMMANDS } from './types.js';
import { SplashScreen } from './components/SplashScreen.js';
import { StatusBar } from './components/StatusBar.js';
import { ChatPanel } from './components/ChatPanel.js';
import { Sidebar } from './components/Sidebar.js';
import { InputBar, INPUT_BAR_CURSOR_LINE, INPUT_BAR_HEIGHT } from './components/InputBar.js';
import { useHarness } from './hooks/useHarness.js';
import { useChat } from './hooks/useChat.js';
import { useKeyboard } from './hooks/useKeyboard.js';

interface AppProps {
  config: DduduConfig;
}

const createId = (prefix: string): string => {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
};

const ensureMode = (mode: NamedMode | undefined): NamedMode => {
  if (!mode) {
    return 'jennie';
  }

  return mode in BLACKPINK_MODES ? mode : 'jennie';
};

const createTab = (name: string, isActive: boolean): TabState => {
  return {
    id: createId('tab'),
    name,
    messages: [],
    scrollOffset: 0,
    isActive,
  };
};

const withActiveTab = (tabs: TabState[], index: number): TabState[] => {
  return tabs.map((tab, currentIndex) => ({
    ...tab,
    isActive: currentIndex === index,
  }));
};

const ensureTabs = (tabs: TabState[], activeTabIndex: number): { tabs: TabState[]; activeTabIndex: number } => {
  if (tabs.length === 0) {
    return {
      tabs: [createTab('Tab 1', true)],
      activeTabIndex: 0,
    };
  }

  const safeIndex = clamp(activeTabIndex, 0, tabs.length - 1);
  return {
    tabs: withActiveTab(tabs, safeIndex),
    activeTabIndex: safeIndex,
  };
};

const initialAutocompleteState: AutocompleteState = {
  kind: 'none',
  items: [],
  selectedIndex: 0,
  visible: false,
  query: '',
};

const makeInitialState = (config: DduduConfig): AppState => {
  const initialMode = ensureMode(config.mode);

  return {
    screen: 'splash',
    mode: initialMode,
    tabs: [createTab('Tab 1', true)],
    activeTabIndex: 0,
    isLoading: false,
    loadingLyric: '',
    inputValue: '',
    inputResetVersion: 0,
    sidebarVisible: true,
    autocomplete: initialAutocompleteState,
    prefixMode: false,
    playingWithFire: false,
    contextPercent: 0,
    tokenCount: { input: 0, output: 0, cost: 0 },
    queuedPrompts: [],
    askUserPrompt: null,
  };
};

const updateMessageToolStatus = (
  message: ChatMessage,
  toolId: string,
  status: ToolCallInfo['status'],
  result?: string
): ChatMessage => {
  if (!message.toolCalls || message.toolCalls.length === 0) {
    return message;
  }

  return {
    ...message,
    toolCalls: message.toolCalls.map((toolCall) => {
      if (toolCall.id !== toolId) {
        return toolCall;
      }

      return {
        ...toolCall,
        status,
        result,
      };
    }),
  };
};

export const appReducer = (state: AppState, action: AppAction): AppState => {
  switch (action.type) {
    case 'SET_SCREEN': {
      return {
        ...state,
        screen: action.screen,
      };
    }

    case 'SET_MODE': {
      return {
        ...state,
        mode: ensureMode(action.mode),
      };
    }

    case 'CYCLE_MODE': {
      const currentIndex = MODE_ORDER.findIndex((mode) => mode === state.mode);
      const safeIndex = currentIndex < 0 ? 0 : currentIndex;
      const nextMode = MODE_ORDER[(safeIndex + 1) % MODE_ORDER.length] ?? MODE_ORDER[0];

      return {
        ...state,
        mode: nextMode,
      };
    }

    case 'ADD_MESSAGE': {
      const safe = ensureTabs(state.tabs, state.activeTabIndex);
      const nextTabs = safe.tabs.map((tab, index) => {
        if (index !== safe.activeTabIndex) {
          return tab;
        }

        return {
          ...tab,
          messages: [...tab.messages, action.message],
        };
      });

      return {
        ...state,
        tabs: nextTabs,
        activeTabIndex: safe.activeTabIndex,
      };
    }

    case 'UPDATE_MESSAGE': {
      const safe = ensureTabs(state.tabs, state.activeTabIndex);
      const nextTabs = safe.tabs.map((tab, index) => {
        if (index !== safe.activeTabIndex) {
          return tab;
        }

        return {
          ...tab,
          messages: tab.messages.map((message) => {
            if (message.id !== action.id) {
              return message;
            }

            return {
              ...message,
              content: action.content,
              thinking: action.thinking,
              toolCalls: action.toolCalls ?? message.toolCalls,
            };
          }),
        };
      });

      return {
        ...state,
        tabs: nextTabs,
      };
    }

    case 'FINISH_MESSAGE': {
      const safe = ensureTabs(state.tabs, state.activeTabIndex);
      const nextTabs = safe.tabs.map((tab, index) => {
        if (index !== safe.activeTabIndex) {
          return tab;
        }

        return {
          ...tab,
          messages: tab.messages.map((message) => {
            if (message.id !== action.id) {
              return message;
            }

            return {
              ...message,
              content: action.content,
              isStreaming: false,
            };
          }),
        };
      });

      return {
        ...state,
        tabs: nextTabs,
      };
    }

    case 'SET_LOADING': {
      return {
        ...state,
        isLoading: action.loading,
        loadingLyric: action.lyric ?? state.loadingLyric,
      };
    }

    case 'SET_INPUT': {
      return {
        ...state,
        inputValue: action.value,
      };
    }

    case 'SET_SCROLL': {
      const safe = ensureTabs(state.tabs, state.activeTabIndex);
      const nextTabs = safe.tabs.map((tab, index) => {
        if (index !== safe.activeTabIndex) {
          return tab;
        }

        return {
          ...tab,
          scrollOffset: Math.max(0, action.offset),
        };
      });

      return {
        ...state,
        tabs: nextTabs,
      };
    }

    case 'SCROLL_DELTA': {
      const safe = ensureTabs(state.tabs, state.activeTabIndex);
      const nextTabs = safe.tabs.map((tab, index) => {
        if (index !== safe.activeTabIndex) {
          return tab;
        }

        return {
          ...tab,
          scrollOffset: Math.max(0, tab.scrollOffset + action.delta),
        };
      });

      return {
        ...state,
        tabs: nextTabs,
      };
    }

    case 'TOGGLE_SIDEBAR': {
      return {
        ...state,
        sidebarVisible: !state.sidebarVisible,
      };
    }

    case 'SET_PREFIX_MODE': {
      return {
        ...state,
        prefixMode: action.active,
      };
    }

    case 'TOGGLE_FIRE_MODE': {
      return {
        ...state,
        playingWithFire: !state.playingWithFire,
      };
    }

    case 'SET_CONTEXT': {
      return {
        ...state,
        contextPercent: clamp(action.percent, 0, 1),
      };
    }

    case 'SET_TOKENS': {
      return {
        ...state,
        tokenCount: {
          input: Math.max(0, Math.floor(action.input)),
          output: Math.max(0, Math.floor(action.output)),
          cost: Math.max(0, action.cost),
        },
      };
    }

    case 'ADD_TAB': {
      const nextName = action.name?.trim() || `Tab ${state.tabs.length + 1}`;
      const appended = [...state.tabs, createTab(nextName, true)];
      const nextIndex = appended.length - 1;

      return {
        ...state,
        tabs: withActiveTab(appended, nextIndex),
        activeTabIndex: nextIndex,
      };
    }

    case 'CLOSE_TAB': {
      if (action.index < 0 || action.index >= state.tabs.length) {
        return state;
      }

      const remainingTabs = state.tabs.filter((_, index) => index !== action.index);
      const ensured = ensureTabs(remainingTabs, state.activeTabIndex);

      if (action.index < state.activeTabIndex) {
        return {
          ...state,
          tabs: withActiveTab(ensured.tabs, Math.max(0, ensured.activeTabIndex - 1)),
          activeTabIndex: Math.max(0, ensured.activeTabIndex - 1),
        };
      }

      return {
        ...state,
        tabs: ensured.tabs,
        activeTabIndex: ensured.activeTabIndex,
      };
    }

    case 'SWITCH_TAB': {
      if (action.index < 0 || action.index >= state.tabs.length) {
        return state;
      }

      return {
        ...state,
        tabs: withActiveTab(state.tabs, action.index),
        activeTabIndex: action.index,
      };
    }

    case 'CLEAR_MESSAGES': {
      const safe = ensureTabs(state.tabs, state.activeTabIndex);
      const nextTabs = safe.tabs.map((tab, index) => {
        if (index !== safe.activeTabIndex) {
          return tab;
        }

        return {
          ...tab,
          messages: [],
          scrollOffset: 0,
        };
      });

      return {
        ...state,
        tabs: nextTabs,
      };
    }

    case 'SET_AUTOCOMPLETE': {
      const merged = {
        ...state.autocomplete,
        ...action.state,
      };
      const maxIndex = Math.max(0, merged.items.length - 1);

      return {
        ...state,
        autocomplete: {
          ...merged,
          selectedIndex: clamp(merged.selectedIndex, 0, maxIndex),
        },
      };
    }

    case 'HIDE_AUTOCOMPLETE': {
      return {
        ...state,
        autocomplete: initialAutocompleteState,
      };
    }

    case 'ENQUEUE_PROMPT': {
      if (!action.prompt.trim()) {
        return state;
      }

      return {
        ...state,
        queuedPrompts: [...state.queuedPrompts, action.prompt],
      };
    }

    case 'DEQUEUE_PROMPT': {
      if (state.queuedPrompts.length === 0) {
        return state;
      }

      return {
        ...state,
        queuedPrompts: state.queuedPrompts.slice(1),
      };
    }

    case 'SET_TOOL_STATUS': {
      return {
        ...state,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          messages: tab.messages.map((message) => {
            if (message.id !== action.messageId) {
              return message;
            }

            return updateMessageToolStatus(message, action.toolId, action.status, action.result);
          }),
        })),
      };
    }

    case 'ASK_USER': {
      const options = action.options?.filter((option) => option.trim().length > 0);
      return {
        ...state,
        askUserPrompt: {
          question: action.question,
          options: options && options.length > 0 ? options : undefined,
          selectedIndex: 0,
        },
      };
    }

    case 'SET_ASK_USER_SELECTION': {
      if (!state.askUserPrompt) {
        return state;
      }

      const options = state.askUserPrompt.options ?? [];
      const maxIndex = Math.max(0, options.length - 1);

      return {
        ...state,
        askUserPrompt: {
          ...state.askUserPrompt,
          selectedIndex: clamp(action.selectedIndex, 0, maxIndex),
        },
      };
    }

    case 'ANSWER_USER': {
      return {
        ...state,
        askUserPrompt: null,
      };
    }

    default: {
      const _exhaustiveCheck: never = action;
      return state;
    }
  }
};

export const App: React.FC<AppProps> = ({ config }) => {
  const [state, dispatch] = useReducer(appReducer, config, makeInitialState);
  const { cols, rows } = useTerminal();
  const harness = useHarness(config, state.mode);
  const { sendMessage, abortCurrentRequest, resolveAskUser } = useChat(dispatch, state, harness, config);

  const submitRef = useRef<((value: string) => void) | null>(null);
  const acceptAutocompleteRef = useRef<(() => void) | null>(null);
  useKeyboard(dispatch, state, {
    onSubmit: (v) => submitRef.current?.(v),
    onAcceptAutocomplete: () => acceptAutocompleteRef.current?.(),
  });

  const width = Math.max(1, cols || 0);
  const height = Math.max(1, rows || 0);
  const mode = ensureMode(state.mode);
  const modeTheme = BLACKPINK_MODES[mode] ?? BLACKPINK_MODES.jennie;
  const modeDisplay = `${modeTheme.label} (${modeTheme.tagline})`;
  const showSidebar = state.sidebarVisible && width >= SIDEBAR_MIN_TERMINAL;
  const sidebarWidth = showSidebar ? Math.min(SIDEBAR_WIDTH, Math.max(24, width - 40)) : 0;
  const mainWidth = Math.max(1, width - sidebarWidth);

  const safeTabs = state.tabs.length > 0 ? state.tabs : [createTab('Tab 1', true)];
  const activeTab = safeTabs[state.activeTabIndex] ?? safeTabs[0];
  const activeMessages = activeTab?.messages ?? [];
  const activeScrollOffset = activeTab?.scrollOffset ?? 0;

  const setAutocomplete = useCallback(
    (nextState: Partial<AutocompleteState>): void => {
      dispatch({ type: 'SET_AUTOCOMPLETE', state: nextState });
    },
    []
  );

  const hideAutocomplete = useCallback((): void => {
    dispatch({ type: 'HIDE_AUTOCOMPLETE' });
  }, []);

  const detectAutocomplete = useCallback(
    (value: string): void => {
      const trimmedStart = value.trimStart();

      if (trimmedStart.startsWith('/')) {
        const query = trimmedStart.toLowerCase();
        const items = SLASH_COMMANDS.filter((command) => command.value.startsWith(query));
        setAutocomplete({
          kind: 'slash',
          visible: true,
          items,
          selectedIndex: 0,
          query,
        });
        return;
      }

      const atIndex = value.lastIndexOf('@');
      if (atIndex >= 0) {
        const query = value.slice(atIndex + 1).trim();
        const placeholder: AutocompleteItem = {
          label: 'File autocomplete coming soon',
          description: 'Path discovery is not implemented yet',
          value: `@${query}`,
        };

        setAutocomplete({
          kind: 'path',
          visible: true,
          items: [placeholder],
          selectedIndex: 0,
          query,
        });
        return;
      }

      hideAutocomplete();
    },
    [hideAutocomplete, setAutocomplete]
  );

  const onInputChange = useCallback(
    (value: string): void => {
      const SHIFT_ENTER_LEAK = /\[27;2;13~/g;
      if (SHIFT_ENTER_LEAK.test(value)) {
        const cleaned = value.replace(SHIFT_ENTER_LEAK, '');
        dispatch({ type: 'SET_INPUT', value: cleaned + '\n' });
        return;
      }

      dispatch({ type: 'SET_INPUT', value });
      detectAutocomplete(value);
    },
    [detectAutocomplete]
  );

  const selectAutocompleteItem = useCallback((): void => {
    if (!state.autocomplete.visible || state.autocomplete.items.length === 0) {
      return;
    }

    const selected =
      state.autocomplete.items[state.autocomplete.selectedIndex] ?? state.autocomplete.items[0];

    if (!selected) {
      hideAutocomplete();
      return;
    }

    const nextValue =
      state.autocomplete.kind === 'slash' ? `${selected.value} ` : selected.value || state.inputValue;

    dispatch({ type: 'SET_INPUT', value: nextValue });
    hideAutocomplete();
  }, [hideAutocomplete, state.autocomplete, state.inputValue]);

  acceptAutocompleteRef.current = selectAutocompleteItem;

  const onEscape = useCallback((): void => {
    if (state.isLoading && abortCurrentRequest) {
      abortCurrentRequest();
      return;
    }

    if (state.autocomplete.visible) {
      hideAutocomplete();
      return;
    }

    if (state.inputValue.length > 0) {
      dispatch({ type: 'SET_INPUT', value: '' });
      return;
    }
  }, [abortCurrentRequest, hideAutocomplete, state.autocomplete.visible, state.inputValue.length, state.isLoading]);

  const onSubmit = useCallback(
    (value: string): void => {
      const trimmed = value.trim();

      if (state.askUserPrompt) {
        const options = state.askUserPrompt.options ?? [];
        const selectedOption =
          options[state.askUserPrompt.selectedIndex] ?? options[0];
        const answer = trimmed || selectedOption;

        if (!answer) {
          return;
        }

        resolveAskUser(answer);
        dispatch({ type: 'SET_INPUT', value: '' });
        return;
      }

      if (!trimmed) {
        return;
      }

      if (state.screen === 'splash') {
        dispatch({ type: 'SET_SCREEN', screen: 'chat' });
      }

      hideAutocomplete();

      if (trimmed === '/clear') {
        dispatch({ type: 'CLEAR_MESSAGES' });
        dispatch({ type: 'SET_INPUT', value: '' });
        return;
      }
      if (trimmed === '/quit') {
        process.exit(0);
      }
      if (trimmed === '/fire') {
        dispatch({ type: 'TOGGLE_FIRE_MODE' });
        dispatch({ type: 'SET_INPUT', value: '' });
        return;
      }
      if (trimmed.startsWith('/mode')) {
        dispatch({ type: 'CYCLE_MODE' });
        dispatch({ type: 'SET_INPUT', value: '' });
        return;
      }
      if (trimmed === '/compact') {
        // TODO: trigger compaction via harness.compactionEngine
        dispatch({ type: 'SET_INPUT', value: '' });
        return;
      }

      if (trimmed === '/help') {
        dispatch({
          type: 'ADD_MESSAGE',
          message: {
            id: `sys-${Date.now()}`,
            role: 'system',
            content:
              'Available commands: /clear, /compact, /mode, /model, /memory, /session, /config, /help, /doctor, /quit, /fire, /init, /skill, /hook, /mcp, /team',
            timestamp: Date.now(),
          },
        });
        dispatch({ type: 'SET_INPUT', value: '' });
        return;
      }
      if (trimmed === '/config') {
        dispatch({
          type: 'ADD_MESSAGE',
          message: {
            id: `sys-${Date.now()}`,
            role: 'system',
            content: `Mode: ${modeDisplay}\nProvider: ${modeTheme.provider}\nModel: ${modeTheme.model}\nReady: ${harness.isReady}\nError: ${harness.error ?? 'none'}`,
            timestamp: Date.now(),
          },
        });
        dispatch({ type: 'SET_INPUT', value: '' });
        return;
      }
      if (trimmed.startsWith('/')) {
        dispatch({
          type: 'ADD_MESSAGE',
          message: {
            id: `sys-${Date.now()}`,
            role: 'system',
            content: `Command "${trimmed}" is not yet implemented.`,
            timestamp: Date.now(),
          },
        });
        dispatch({ type: 'SET_INPUT', value: '' });
        return;
      }

      void sendMessage(trimmed);
    },
    [dispatch, harness, hideAutocomplete, modeDisplay, modeTheme, resolveAskUser, sendMessage, state.askUserPrompt, state.screen]
  );

  submitRef.current = onSubmit;

  if (state.screen === 'splash') {
    return (
      <Box width={width} height={height} flexDirection="column" backgroundColor={BP.black}>
        <SplashScreen
          inputValue={state.inputValue}
          onInputChange={onInputChange}
          onSubmit={onSubmit}
          width={width}
          height={height}
          mode={mode}
          modeDisplay={modeDisplay}
        />
      </Box>
    );
  }

  const harnessStatusMessages: ChatMessage[] = harness.error
    ? [
        {
          id: 'sys-harness-error',
          role: 'system',
          content: `[harness error] ${harness.error}`,
          timestamp: Date.now(),
        },
      ]
    : !harness.isReady
      ? [
          {
            id: 'sys-harness-booting',
            role: 'system',
            content: 'Booting harness...',
            timestamp: Date.now(),
          },
        ]
      : [];

  const panelMessages = harnessStatusMessages.length > 0 ? [...harnessStatusMessages, ...activeMessages] : activeMessages;

  const chromeHeight = 1 + INPUT_BAR_HEIGHT;
  const middleHeight = Math.max(1, height - chromeHeight);
  const inputCursorY = Math.max(0, height - INPUT_BAR_HEIGHT + INPUT_BAR_CURSOR_LINE);

  return (
    <Box width={width} height={height} flexDirection="column" backgroundColor={BP.black}>
      <StatusBar
        tabs={safeTabs}
        activeTabIndex={state.activeTabIndex}
        mode={mode}
        prefixMode={state.prefixMode}
      />

      <Box flexGrow={1} height={middleHeight}>
        <Box width={mainWidth} flexGrow={1}>
          <ChatPanel
            messages={panelMessages}
            scrollOffset={activeScrollOffset}
            isLoading={state.isLoading}
            loadingLyric={state.loadingLyric}
            width={mainWidth}
            height={middleHeight}
          />
        </Box>

        {showSidebar ? (
          <Sidebar
            width={sidebarWidth}
            height={middleHeight}
            mode={mode}
            contextPercent={state.contextPercent}
            tokenCount={state.tokenCount}
            playingWithFire={state.playingWithFire}
          />
        ) : null}
      </Box>

      <InputBar
        value={state.inputValue}
        onChange={onInputChange}
        onEscape={onEscape}
        isActive
        width={width}
        cursorYOffset={inputCursorY}
        autocomplete={state.autocomplete}
        askUserPrompt={state.askUserPrompt}
        isLoading={state.isLoading}
      />
    </Box>
  );
};
