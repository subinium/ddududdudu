import { useInput } from 'ink';
import { useEffect, useRef } from 'react';
import type React from 'react';
import type { AppAction, AppState } from '../types.js';

const PREFIX_TIMEOUT_MS = 2000;
const DOUBLE_ESC_MS = 300;

interface KeyboardCallbacks {
  onSubmit?: (value: string) => void;
  onAcceptAutocomplete?: () => void;
}

export const useKeyboard = (
  dispatch: React.Dispatch<AppAction>,
  state: AppState,
  callbacks?: KeyboardCallbacks
): void => {
  const lastEscAtRef = useRef(0);
  const prefixTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (prefixTimeoutRef.current) {
      clearTimeout(prefixTimeoutRef.current);
      prefixTimeoutRef.current = null;
    }

    if (state.prefixMode) {
      prefixTimeoutRef.current = setTimeout(() => {
        dispatch({ type: 'SET_PREFIX_MODE', active: false });
      }, PREFIX_TIMEOUT_MS);
    }

    return () => {
      if (prefixTimeoutRef.current) {
        clearTimeout(prefixTimeoutRef.current);
        prefixTimeoutRef.current = null;
      }
    };
  }, [dispatch, state.prefixMode]);

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === 'c') {
      process.exit(0);
    }

    if (state.prefixMode) {
      const tabsCount = state.tabs.length;
      const command = input.toLowerCase();

      if (command === 't') {
        dispatch({ type: 'ADD_TAB' });
      } else if (command === 'w') {
        dispatch({ type: 'CLOSE_TAB', index: state.activeTabIndex });
      } else if (command === 'n' && tabsCount > 0) {
        dispatch({
          type: 'SWITCH_TAB',
          index: (state.activeTabIndex + 1) % tabsCount,
        });
      } else if (command === 'p' && tabsCount > 0) {
        dispatch({
          type: 'SWITCH_TAB',
          index: (state.activeTabIndex - 1 + tabsCount) % tabsCount,
        });
      } else if (command === 'l') {
        dispatch({ type: 'TOGGLE_SIDEBAR' });
      } else if (/^[1-8]$/.test(command)) {
        dispatch({ type: 'SWITCH_TAB', index: Number.parseInt(command, 10) - 1 });
      }

      dispatch({ type: 'SET_PREFIX_MODE', active: false });
      return;
    }

    if (key.ctrl && input.toLowerCase() === 'b') {
      dispatch({ type: 'SET_PREFIX_MODE', active: true });
      return;
    }

    if (key.tab && key.shift) {
      dispatch({ type: 'CYCLE_MODE' });
      return;
    }

    if (key.tab && state.autocomplete.visible) {
      callbacks?.onAcceptAutocomplete?.();
      return;
    }

    if (key.escape) {
      const now = Date.now();
      const isDoubleEsc = now - lastEscAtRef.current <= DOUBLE_ESC_MS;
      lastEscAtRef.current = now;

      if (isDoubleEsc) {
        dispatch({ type: 'CLEAR_MESSAGES' });
        return;
      }

      if (state.autocomplete.visible) {
        dispatch({ type: 'HIDE_AUTOCOMPLETE' });
      } else if (state.inputValue.length > 0) {
        dispatch({ type: 'SET_INPUT', value: '' });
      }
      return;
    }

    if (key.return) {
      if (input === '\n') {
        dispatch({ type: 'SET_INPUT', value: state.inputValue + '\n' });
        return;
      }

      if (state.autocomplete.visible && state.autocomplete.items.length > 0) {
        callbacks?.onAcceptAutocomplete?.();
        return;
      }

      if (callbacks?.onSubmit && (state.askUserPrompt !== null || state.inputValue.trim().length > 0)) {
        callbacks.onSubmit(state.inputValue);
      }
      return;
    }

    if (key.upArrow || key.downArrow) {
      if (state.askUserPrompt?.options && state.askUserPrompt.options.length > 0) {
        const direction = key.upArrow ? -1 : 1;
        const count = state.askUserPrompt.options.length;
        const nextIndex = (state.askUserPrompt.selectedIndex + direction + count) % count;

        dispatch({
          type: 'SET_ASK_USER_SELECTION',
          selectedIndex: nextIndex,
        });
      } else if (state.autocomplete.visible && state.autocomplete.items.length > 0) {
        const direction = key.upArrow ? -1 : 1;
        const count = state.autocomplete.items.length;
        const nextIndex = (state.autocomplete.selectedIndex + direction + count) % count;

        dispatch({
          type: 'SET_AUTOCOMPLETE',
          state: { selectedIndex: nextIndex },
        });
      } else {
        dispatch({ type: 'SCROLL_DELTA', delta: key.upArrow ? -1 : 1 });
      }
    }
  });
};
