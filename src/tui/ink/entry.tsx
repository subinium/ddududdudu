import React from 'react';
import { withFullScreen } from 'fullscreen-ink';
import { App } from './App.js';
import type { DduduConfig } from '../../core/types.js';

export const startInkTui = async (config: DduduConfig): Promise<void> => {
  const ink = withFullScreen(<App config={config} />);

  let hasExited = false;
  const handleSigint = (): void => {
    if (hasExited) {
      return;
    }

    hasExited = true;
    process.off('SIGINT', handleSigint);
    ink.instance.unmount();
    process.exit(0);
  };

  process.on('SIGINT', handleSigint);

  try {
    await ink.start();
    await ink.waitUntilExit();
  } finally {
    process.off('SIGINT', handleSigint);
  }
};
