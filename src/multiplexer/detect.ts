import type { Multiplexer } from './interface.js';
import { BuiltinMultiplexer } from './builtin.js';
import { TmuxMultiplexer } from './tmux.js';

let cachedMultiplexer: Multiplexer | null = null;

const normalizeBackend = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

export const detectMultiplexer = (): Multiplexer => {
  const explicit = normalizeBackend(process.env.DDUDU_BACKEND);
  if (explicit === 'tmux') {
    return new TmuxMultiplexer();
  }

  if (explicit === 'builtin') {
    return new BuiltinMultiplexer();
  }

  if (process.env.TMUX) {
    return new TmuxMultiplexer();
  }

  return new BuiltinMultiplexer();
};

export const getMultiplexer = (): Multiplexer => {
  if (!cachedMultiplexer) {
    cachedMultiplexer = detectMultiplexer();
  }

  return cachedMultiplexer;
};
