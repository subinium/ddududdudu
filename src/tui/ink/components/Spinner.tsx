import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { BP, BP_LYRICS, SPINNER_FRAMES } from '../theme.js';

interface SpinnerProps {
  lyric?: string;
}

const pickRandomLyric = (): string => {
  if (BP_LYRICS.length === 0) {
    return 'Loading...';
  }

  const index = Math.floor(Math.random() * BP_LYRICS.length);
  return BP_LYRICS[index] ?? 'Loading...';
};

export const Spinner: React.FC<SpinnerProps> = ({ lyric }) => {
  const [frameIndex, setFrameIndex] = useState(0);

  const lyricText = useMemo(() => lyric ?? pickRandomLyric(), [lyric]);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);

    return () => {
      clearInterval(interval);
    };
  }, []);

  const frame = SPINNER_FRAMES[frameIndex] ?? '•';

  return (
    <Box>
      <Text>
        <Text color={BP.pink}>{frame}</Text>
        <Text color={BP.pinkDim}>{` ${lyricText}`}</Text>
      </Text>
    </Box>
  );
};
