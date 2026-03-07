import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import type { NamedMode } from '../../../core/types.js';
import { BP } from '../theme.js';
import { IMETextInput } from './IMETextInput.js';

export interface SplashScreenProps {
  inputValue: string;
  onInputChange: (value: string) => void;
  onSubmit: (value: string) => void;
  width: number;
  height: number;
  mode: NamedMode;
  modeDisplay: string;
}

const RAW_FULL = [
  "      d8b       d8b                d8b                    d8b       d8b                d8b",
  "      88P       88P                88P                    88P       88P                88P",
  "     d88       d88                d88                    d88       d88                d88",
  " d888888   d888888  ?88   d8P d888888  ?88   d8P     d888888   d888888  ?88   d8P d888888  ?88   d8P",
  "d8P' ?88  d8P' ?88  d88   88 d8P' ?88  d88   88     d8P' ?88  d8P' ?88  d88   88 d8P' ?88  d88   88",
  "88b  ,88b 88b  ,88b ?8(  d88 88b  ,88b ?8(  d88     88b  ,88b 88b  ,88b ?8(  d88 88b  ,88b ?8(  d88",
  "`?88P'`88b`?88P'`88b`?88P'?8b`?88P'`88b`?88P'?8b    `?88P'`88b`?88P'`88b`?88P'?8b`?88P'`88b`?88P'?8b",
];

const RAW_COMPACT = [
  "      d8b       d8b                d8b",
  "      88P       88P                88P",
  "     d88       d88                d88",
  " d888888   d888888  ?88   d8P d888888  ?88   d8P",
  "d8P' ?88  d8P' ?88  d88   88 d8P' ?88  d88   88",
  "88b  ,88b 88b  ,88b ?8(  d88 88b  ,88b ?8(  d88",
  "`?88P'`88b`?88P'`88b`?88P'?8b`?88P'`88b`?88P'?8b",
];

const padLines = (lines: string[]): string[] => {
  const maxLen = Math.max(...lines.map((l) => l.length));
  return lines.map((l) => l.padEnd(maxLen));
};

const FULL_LOGO_LINES = padLines(RAW_FULL);
const COMPACT_LOGO_LINES = padLines(RAW_COMPACT);
const GLITCH_CHARS = ['░', '▒', '▓', '?', '8', 'd'] as const;

const getLogoLines = (terminalWidth: number): string[] => {
  return terminalWidth < 100 ? [...COMPACT_LOGO_LINES] : [...FULL_LOGO_LINES];
};

export const SplashScreen: React.FC<SplashScreenProps> = ({
  inputValue,
  onInputChange,
  width,
  height,
  modeDisplay,
}) => {
  const activeLogoLines = getLogoLines(width);
  const [displayLines, setDisplayLines] = useState<string[]>(() => activeLogoLines);
  const restoreTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setDisplayLines([...activeLogoLines]);
  }, [activeLogoLines]);

  const logoPositions = useMemo(() => {
    const positions: Array<{ line: number; column: number }> = [];
    activeLogoLines.forEach((line, lineIndex) => {
      Array.from(line).forEach((character, columnIndex) => {
        if (character !== ' ') {
          positions.push({ line: lineIndex, column: columnIndex });
        }
      });
    });
    return positions;
  }, [activeLogoLines]);

  const applyGlitch = useCallback((): void => {
    if (logoPositions.length === 0) {
      return;
    }

    const glitchCount = 5 + Math.floor(Math.random() * 4);
    const chosenIndexes = new Set<number>();

    while (chosenIndexes.size < glitchCount) {
      chosenIndexes.add(Math.floor(Math.random() * logoPositions.length));
    }

    const nextLines = activeLogoLines.map((line) => Array.from(line));
    for (const positionIndex of chosenIndexes) {
      const position = logoPositions[positionIndex];
      if (!position || !nextLines[position.line]) {
        continue;
      }
      nextLines[position.line][position.column] =
        GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)] ?? '?';
    }

    setDisplayLines(nextLines.map((lineChars) => lineChars.join('')));
  }, [activeLogoLines, logoPositions]);

  useEffect(() => {
    if (width <= 0 || height <= 0) {
      return;
    }

    const interval = setInterval(() => {
      applyGlitch();
      if (restoreTimeoutRef.current) {
        clearTimeout(restoreTimeoutRef.current);
      }

      restoreTimeoutRef.current = setTimeout(() => {
        setDisplayLines([...activeLogoLines]);
      }, 120);
    }, 200);

    return () => {
      clearInterval(interval);
      if (restoreTimeoutRef.current) {
        clearTimeout(restoreTimeoutRef.current);
      }
    };
  }, [activeLogoLines, applyGlitch, height, width]);

  if (width <= 0 || height <= 0) {
    return null;
  }

  const cardWidth = Math.max(40, Math.min(width - 8, 86));
  const layoutHeight = displayLines.length + 8;
  const topOffset = Math.max(0, Math.floor((height - layoutHeight) / 2));
  const inputCursorY = topOffset + displayLines.length + 6;

  return (
    <Box width={width} height={height} justifyContent="center" alignItems="center" backgroundColor={BP.black}>
      <Box flexDirection="column" alignItems="center" width={width}>
        <Box flexDirection="column">
          {displayLines.map((line, index) => (
            <Text key={`logo-line-${index}`} color={BP.pink}>
              {line}
            </Text>
          ))}
        </Box>

        <Box marginTop={1}>
          <Text color={BP.pink} bold>
            BL4CKP1NK 1N Y0UR AREA
          </Text>
        </Box>

        <Text color={BP.pinkDim}>
          Harness first. Prompt second.
        </Text>

        <Text color={BP.pinkDim}>
          {modeDisplay}
        </Text>

        <Box
          marginTop={2}
          width={cardWidth}
          flexDirection="column"
          borderStyle="round"
          borderColor={BP.pinkDim}
          paddingX={1}
        >
          <Box justifyContent="space-between">
            <Text color={BP.pink} bold>
              FIRST PROMPT
            </Text>
            <Text color={BP.pinkDim}>
              Enter sends
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={BP.pink}>WRITE ❯ </Text>
            <IMETextInput
              value={inputValue}
              onChange={onInputChange}
              placeholder="Describe the task you want the harness to take over."
              cursorYOffset={inputCursorY}
              cursorXOffset={10}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  );
};
