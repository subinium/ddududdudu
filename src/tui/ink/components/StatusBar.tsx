import React from 'react';
import { Box, Text } from 'ink';
import type { NamedMode } from '../../../core/types.js';
import { BP, BLACKPINK_MODES } from '../theme.js';
import type { TabState } from '../types.js';

interface StatusBarProps {
  tabs: TabState[];
  activeTabIndex: number;
  mode: NamedMode;
  prefixMode: boolean;
}

const truncateLabel = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(1, maxLength - 1))}…`;
};

export const StatusBar: React.FC<StatusBarProps> = ({ tabs, activeTabIndex, mode, prefixMode }) => {
  const activeMode = BLACKPINK_MODES[mode] ?? BLACKPINK_MODES.jennie;
  const safeTabs =
    tabs.length > 0
      ? tabs
      : [{ id: 'empty', name: 'No Tabs', messages: [], scrollOffset: 0, isActive: true }];

  return (
    <Box
      width="100%"
      height={1}
      backgroundColor={BP.black}
      justifyContent="space-between"
      overflow="hidden"
    >
      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {safeTabs.map((tab, index) => {
          const isActive = tabs.length > 0 ? index === activeTabIndex : false;
          const label = truncateLabel(tab.name || `Tab ${index + 1}`, 14);

          return (
            <Box key={tab.id} marginRight={1}>
              <Text
                color={isActive ? BP.black : BP.pinkDim}
                backgroundColor={isActive ? BP.pink : undefined}
                bold={isActive}
              >
                {` ${index + 1}:${label} `}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="row" flexShrink={0}>
        <Text color={BP.pink} bold>
          {activeMode.label}
        </Text>
        <Text color={BP.pinkDim}>
          {` ${activeMode.provider}/${activeMode.model}`}
        </Text>
        {prefixMode ? (
          <Text color={BP.yellow}>
            {'  '}PREFIX Ctrl+B
          </Text>
        ) : null}
      </Box>
    </Box>
  );
};
