import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { MarkdownText } from './MarkdownText.js';
import { Spinner } from './Spinner.js';
import type { ChatMessage, ToolCallInfo } from '../types.js';
import { BP, SPINNER_FRAMES } from '../theme.js';

interface ChatPanelProps {
  messages: ChatMessage[];
  scrollOffset: number;
  width: number;
  height: number;
  isLoading: boolean;
  loadingLyric: string;
}

const TOOL_ICONS: Record<ToolCallInfo['status'], string> = {
  pending: '○',
  running: '◐',
  done: '●',
  error: '✗',
};

const TOOL_COLORS: Record<ToolCallInfo['status'], string> = {
  pending: BP.pinkDim,
  running: BP.pink,
  done: BP.pinkDim,
  error: BP.red,
};

const truncateToolResult = (result: string | undefined, maxLen: number): string => {
  if (!result) return '';
  const oneLine = result.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
};

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  scrollOffset,
  width,
  height,
  isLoading,
  loadingLyric,
}) => {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(0, height);
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const [cursorVisible, setCursorVisible] = useState(true);
  const autoScrollRef = useRef(true);
  const prevCountRef = useRef(messages.length);

  useEffect(() => {
    const interval = setInterval(() => {
      setSpinnerIndex((p) => (p + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setCursorVisible((p) => !p);
    }, 480);
    return () => clearInterval(interval);
  }, []);

  if (messages.length > prevCountRef.current) {
    autoScrollRef.current = true;
  }
  prevCountRef.current = messages.length;

  if (scrollOffset > 0) {
    autoScrollRef.current = false;
  }

  if (safeHeight <= 0) {
    return null;
  }

  const frame = SPINNER_FRAMES[spinnerIndex] ?? '•';
  const contentWidth = Math.max(24, safeWidth - 4);

  const renderPrefixedLines = (
    prefix: string,
    prefixColor: string,
    text: string,
    keyPrefix: string,
    bodyColor: string = BP.white,
  ): React.ReactNode => {
    const lines = text.split('\n');

    return (
      <Box flexDirection="column">
        {lines.map((line, index) => (
          <Text key={`${keyPrefix}-${index}`} color={bodyColor}>
            <Text color={prefixColor}>{index === 0 ? prefix : ' '.repeat(prefix.length)}</Text>
            {line || ' '}
          </Text>
        ))}
      </Box>
    );
  };

  if (messages.length === 0 && !isLoading) {
    return (
      <Box width={safeWidth} height={safeHeight} flexDirection="column" paddingX={1}>
        <Box flexDirection="column" marginTop={1}>
          <Text color={BP.pink}>› Start with a task.</Text>
          <Text color={BP.pinkDim}>  Use `/` for commands, `@` for files.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box width={safeWidth} height={safeHeight} flexDirection="column" paddingX={1} overflow="hidden">
      {scrollOffset > 0 ? (
        <Box marginBottom={1}>
          <Text color={BP.yellow}>{`↑ ${scrollOffset} line${scrollOffset > 1 ? 's' : ''} above`}</Text>
        </Box>
      ) : null}

      <Box
        flexDirection="column"
        overflow="hidden"
        marginTop={autoScrollRef.current ? undefined : -Math.max(0, scrollOffset)}
      >
        {messages.map((msg) => {
          const toolCalls = msg.toolCalls ?? [];
          const content = msg.content ?? '';

          if (msg.role === 'user') {
            return (
              <Box key={msg.id} flexDirection="column" marginBottom={1}>
                {renderPrefixedLines('› ', BP.pink, content, msg.id)}
              </Box>
            );
          }

          if (msg.role === 'system') {
            return (
              <Box key={msg.id} flexDirection="column" marginBottom={1}>
                {renderPrefixedLines('! ', BP.yellow, content, msg.id, BP.yellow)}
              </Box>
            );
          }

          if (msg.role === 'assistant') {
            return (
              <Box key={msg.id} flexDirection="row" marginBottom={1}>
                <Text color={msg.isStreaming ? BP.pink : BP.pinkDim}>{'│ '}</Text>
                <Box flexDirection="column" flexGrow={1}>
                  {toolCalls.length > 0 ? (
                    <Box flexDirection="column" marginBottom={content ? 1 : 0}>
                      {toolCalls.map((toolCall) => {
                        const icon = toolCall.status === 'running' ? frame : TOOL_ICONS[toolCall.status];
                        const color = TOOL_COLORS[toolCall.status];
                        const resultPreview =
                          toolCall.status === 'done' ? truncateToolResult(toolCall.result, 64) : '';

                        return (
                          <Text key={toolCall.id} color={color}>
                            {icon} {toolCall.name}
                            {resultPreview ? (
                              <Text color={BP.pinkDim}>{` ${resultPreview}`}</Text>
                            ) : null}
                          </Text>
                        );
                      })}
                    </Box>
                  ) : null}

                  {content ? (
                    <Box flexDirection="column">
                      <MarkdownText content={content} width={contentWidth} />
                      {msg.isStreaming ? (
                        <Text color={BP.pink}>{cursorVisible ? '▋' : ' '}</Text>
                      ) : null}
                    </Box>
                  ) : msg.isStreaming ? (
                    <Text color={BP.pink}>{cursorVisible ? '▋' : ' '}</Text>
                  ) : null}
                </Box>
              </Box>
            );
          }

          return (
            <Box key={msg.id} flexDirection="column" marginBottom={1}>
              <Text color={BP.pinkDim}>
                [{msg.role}] {content}
              </Text>
            </Box>
          );
        })}

        {isLoading ? (
          <Box marginBottom={1} flexDirection="row">
            <Text color={BP.pinkDim}>{'│ '}</Text>
            <Spinner lyric={loadingLyric} />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
};
