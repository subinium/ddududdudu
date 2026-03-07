import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { AskUserPrompt, AutocompleteState } from '../types.js';
import { BP } from '../theme.js';
import { IMETextInput } from './IMETextInput.js';

export interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onEscape: () => void;
  isActive: boolean;
  placeholder?: string;
  width: number;
  cursorYOffset?: number;
  autocomplete: AutocompleteState;
  askUserPrompt: AskUserPrompt | null;
  isLoading: boolean;
}

export const INPUT_BAR_HEIGHT = 4;
export const INPUT_BAR_CURSOR_LINE = 1;

const DEFAULT_PLACEHOLDER = 'Type a message... (/ commands, @ files, Ctrl+J newline)';
const countNewlines = (text: string): number => {
  let count = 0;
  for (const ch of text) {
    if (ch === '\n') count += 1;
  }
  return count;
};

const renderAutocompleteHeadline = (autocomplete: AutocompleteState): string => {
  if (!autocomplete.visible || autocomplete.items.length === 0) {
    return '/help  Tab accept  Esc clear';
  }

  const selected =
    autocomplete.items[autocomplete.selectedIndex] ?? autocomplete.items[0];
  const total = autocomplete.items.length;

  return `${autocomplete.kind === 'slash' ? 'CMD' : 'PATH'} ${selected?.label ?? 'No selection'}  ${Math.min(
    autocomplete.selectedIndex + 1,
    total,
  )}/${total}`;
};

const renderAutocompleteDetail = (autocomplete: AutocompleteState): string => {
  if (!autocomplete.visible || autocomplete.items.length === 0) {
    return 'Shift+Tab mode  Ctrl+B tabs  Ctrl+J newline';
  }

  const selected =
    autocomplete.items[autocomplete.selectedIndex] ?? autocomplete.items[0];
  const total = autocomplete.items.length;

  return `${selected?.description ?? 'No matches'} ${total > 1 ? 'Use ↑/↓ then Enter/Tab.' : 'Press Enter or Tab.'}`;
};

const renderAskUserHeadline = (prompt: AskUserPrompt): string => {
  return `QUESTION ${prompt.question}`;
};

const renderAskUserDetail = (prompt: AskUserPrompt): string => {
  const optionsLabel = prompt.options?.length
    ? prompt.options
        .map((option, index) => `${index === prompt.selectedIndex ? '›' : ' '} ${index + 1}. ${option}`)
        .join('  ')
    : 'Type a free-form answer and press Enter.';

  return optionsLabel;
};

export const InputBar: React.FC<InputBarProps> = ({
  value,
  onChange,
  onEscape: _onEscape,
  isActive,
  placeholder = DEFAULT_PLACEHOLDER,
  width,
  cursorYOffset,
  autocomplete,
  askUserPrompt,
  isLoading,
}) => {
  const lineCount = countNewlines(value) + 1;
  const safeWidth = Math.max(20, width);
  const composerWidth = Math.max(10, safeWidth - 4);
  const cursorXOffset = 3;
  const headline = askUserPrompt
    ? renderAskUserHeadline(askUserPrompt)
    : renderAutocompleteHeadline(autocomplete);
  const detail = askUserPrompt
    ? renderAskUserDetail(askUserPrompt)
    : renderAutocompleteDetail(autocomplete);

  return (
    <Box width={safeWidth} height={INPUT_BAR_HEIGHT} flexDirection="column" overflow="hidden" paddingX={1}>
      <Box paddingX={1} justifyContent="space-between">
        <Text color={askUserPrompt ? BP.yellow : autocomplete.visible ? BP.pink : BP.pinkDim}>
          {headline}
        </Text>
        <Text color={isLoading ? BP.yellow : BP.pinkDim}>
          {isLoading ? 'Streaming... Esc aborts' : `Draft ${lineCount} line${lineCount > 1 ? 's' : ''}`}
        </Text>
      </Box>

      <Box paddingX={1}>
        <Text color={BP.pink} bold>{'❯ '}</Text>
        <Box width={composerWidth} overflow="hidden">
          <IMETextInput
            value={value}
            onChange={onChange}
            isDisabled={!isActive}
            placeholder={placeholder}
            cursorYOffset={cursorYOffset}
            cursorXOffset={cursorXOffset}
          />
        </Box>
      </Box>

      <Box paddingX={1}>
        <Text color={BP.pinkDim}>{detail}</Text>
      </Box>
    </Box>
  );
};
