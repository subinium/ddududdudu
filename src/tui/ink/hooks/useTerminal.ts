import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export const useTerminal = (): TerminalDimensions => {
  const { stdout } = useStdout();
  const [dims, setDims] = useState<TerminalDimensions>({
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
  });

  useEffect(() => {
    const handler = (): void => {
      setDims({
        cols: stdout.columns || 80,
        rows: stdout.rows || 24,
      });
    };

    stdout.on('resize', handler);
    return () => {
      stdout.off('resize', handler);
    };
  }, [stdout]);

  return dims;
};

export const SIDEBAR_WIDTH = 36;
export const SIDEBAR_MIN_TERMINAL = 120;
