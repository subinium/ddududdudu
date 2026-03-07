import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { NamedMode } from '../../../core/types.js';
import { BP, BLACKPINK_MODES } from '../theme.js';

interface FooterProps {
  mode: NamedMode;
  playingWithFire: boolean;
  contextPercent: number;
  tokenCount: { input: number; output: number; cost: number };
  queueCount: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const formatUsd = (cost: number): string => {
  const safe = Number.isFinite(cost) ? Math.max(0, cost) : 0;
  return `$${safe.toFixed(4)}`;
};

const formatInt = (value: number): string => {
  const safe = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return safe.toLocaleString('en-US');
};

export const Footer: React.FC<FooterProps> = ({
  mode,
  playingWithFire,
  contextPercent,
  tokenCount,
  queueCount,
}) => {
  const { stdout } = useStdout();
  const activeMode = BLACKPINK_MODES[mode] ?? BLACKPINK_MODES.jennie;
  const showLongHints = (stdout.columns || 0) >= 110;
  const percentValue = Math.round(clamp01(contextPercent) * 100);
  const totalTokens = formatInt(tokenCount.input + tokenCount.output);

  let contextColor: string = BP.green;
  if (percentValue >= 80) contextColor = BP.red;
  else if (percentValue >= 60) contextColor = BP.yellow;

  return (
    <Box width="100%" height={1} backgroundColor={BP.darkGray} justifyContent="space-between" overflow="hidden">
      <Box flexDirection="row" flexShrink={0}>
        <Text color={BP.pink}>{activeMode.label}</Text>
        <Text color={BP.gray} dimColor>{` ${activeMode.provider}`}</Text>
        {playingWithFire ? <Text color={BP.red}>{'  FIRE'}</Text> : null}
        {queueCount > 0 ? <Text color={BP.yellow}>{`  Q:${queueCount}`}</Text> : null}
      </Box>

      <Box flexDirection="row" flexShrink={0}>
        <Text color={contextColor}>{`CTX ${percentValue}%`}</Text>
        <Text color={BP.gray} dimColor>{`  ${totalTokens} tok`}</Text>
        <Text color={BP.white}>{`  ${formatUsd(tokenCount.cost)}`}</Text>
        {showLongHints ? (
          <Text color={BP.gray} dimColor>
            {'  '}Tab accept | Esc clear | Ctrl+B tabs
          </Text>
        ) : null}
      </Box>
    </Box>
  );
};
