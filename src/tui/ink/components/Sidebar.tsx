import React from 'react';
import { Box, Text } from 'ink';
import type { NamedMode } from '../../../core/types.js';
import { BP, BLACKPINK_MODES } from '../theme.js';

interface SidebarProps {
  width: number;
  height: number;
  mode: NamedMode;
  contextPercent: number;
  tokenCount: { input: number; output: number; cost: number };
  playingWithFire: boolean;
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

const makeBar = (percent: number, width: number): string => {
  const safePercent = clamp01(percent);
  const filled = Math.round(width * safePercent);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
};

export const Sidebar: React.FC<SidebarProps> = ({
  width,
  height,
  mode,
  contextPercent,
  tokenCount,
  playingWithFire,
}) => {
  const activeMode = BLACKPINK_MODES[mode] ?? BLACKPINK_MODES.jennie;
  const safePercent = clamp01(contextPercent);
  const contentWidth = Math.max(14, width - 4);
  const rule = '─'.repeat(contentWidth);
  const progressWidth = Math.max(8, contentWidth - 2);

  return (
    <Box width={width} height={height} paddingLeft={1} overflow="hidden">
      <Box width={Math.max(1, width - 1)} height={height} flexDirection="column" paddingX={1} overflow="hidden">
        <Text color={BP.pink} bold>
          INSPECTOR
        </Text>

        <Text color={BP.pinkDim}>
          {rule}
        </Text>

        <Text color={BP.pink}>MODE</Text>
        <Text color={BP.white}>{activeMode.label}</Text>
        <Text color={BP.pinkDim}>{activeMode.tagline}</Text>
        <Text color={BP.pinkDim}>{activeMode.model}</Text>

        <Text color={BP.pinkDim}>
          {rule}
        </Text>

        <Text color={BP.pink}>CONTEXT</Text>
        <Text color={BP.pink}>{makeBar(safePercent, progressWidth)}</Text>
        <Text color={BP.white}>{Math.round(safePercent * 100)}%</Text>

        <Text color={BP.pinkDim}>
          {rule}
        </Text>

        <Text color={BP.pink}>USAGE</Text>
        <Text color={BP.white}>{`In   ${formatInt(tokenCount.input)}`}</Text>
        <Text color={BP.white}>{`Out  ${formatInt(tokenCount.output)}`}</Text>
        <Text color={BP.pinkDim}>{`Cost ${formatUsd(tokenCount.cost)}`}</Text>

        <Text color={BP.pinkDim}>
          {rule}
        </Text>

        <Text color={BP.pink}>STATUS</Text>
        <Text color={playingWithFire ? BP.red : BP.green}>
          {playingWithFire ? 'PLAYING_WITH_FIRE' : 'SAFE MODE'}
        </Text>
      </Box>
    </Box>
  );
};
