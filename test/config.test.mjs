import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { loadConfig } from '../dist/core/config.js';

test('default config uses global-first session storage', async () => {
  const config = await loadConfig();
  assert.equal(config.session.directory, resolve(homedir(), '.ddudu', 'sessions'));
});
