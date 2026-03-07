import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { BP } from '../theme.js';
import type { AutocompleteItem } from '../types.js';

export interface AutocompletePopupProps {
  items: AutocompleteItem[];
  selectedIndex: number;
  visible: boolean;
  query: string;
  kind: 'slash' | 'path' | 'none';
  onSelect: (item: AutocompleteItem) => void;
}

const MAX_VISIBLE_ITEMS = 8;

export const AutocompletePopup: React.FC<AutocompletePopupProps> = ({
  items,
  selectedIndex,
  visible,
  query,
  kind,
  onSelect,
}) => {
  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (normalizedQuery.length === 0) {
      return items;
    }

    return items.filter((item) => item.label.toLowerCase().startsWith(normalizedQuery));
  }, [items, query]);

  const safeSelectedIndex = useMemo(() => {
    if (filteredItems.length === 0) {
      return -1;
    }

    if (selectedIndex < 0) {
      return 0;
    }

    if (selectedIndex >= filteredItems.length) {
      return filteredItems.length - 1;
    }

    return selectedIndex;
  }, [filteredItems, selectedIndex]);

  const visibleStartIndex = useMemo(() => {
    if (safeSelectedIndex < 0) {
      return 0;
    }

    const maxStart = Math.max(filteredItems.length - MAX_VISIBLE_ITEMS, 0);
    const centeredStart = safeSelectedIndex - Math.floor(MAX_VISIBLE_ITEMS / 2);

    return Math.min(Math.max(centeredStart, 0), maxStart);
  }, [filteredItems.length, safeSelectedIndex]);

  const visibleItems = useMemo(
    () => filteredItems.slice(visibleStartIndex, visibleStartIndex + MAX_VISIBLE_ITEMS),
    [filteredItems, visibleStartIndex],
  );

  if (!visible || kind === 'none') {
    return null;
  }

  return (
    <Box borderStyle="single" borderColor={BP.pink} backgroundColor={BP.darkGray} flexDirection="column" paddingX={1}>
      {visibleItems.length === 0 ? (
        <Text color={BP.gray} dimColor>
          No matches
        </Text>
      ) : (
        visibleItems.map((item, index) => {
          const absoluteIndex = visibleStartIndex + index;
          const isSelected = absoluteIndex === safeSelectedIndex;

          return (
            <Box key={`${item.value}-${absoluteIndex}`}>
              <Text color={BP.pink}>{isSelected ? '> ' : '  '}</Text>
              <Text color={BP.pink} bold={isSelected} backgroundColor={isSelected ? BP.pinkDim : undefined}>
                {item.label}
              </Text>
              <Text> </Text>
              <Text color={BP.gray} dimColor>
                {item.description}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
};
