import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveModeBinding } from '../dist/core/mode-resolution.js';

test('mode resolution keeps preferred Anthropic lineup when Claude auth is available', () => {
  const hasProvider = (provider) => provider === 'anthropic';

  assert.deepEqual(resolveModeBinding('jennie', hasProvider), {
    mode: 'jennie',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    fallback: false,
  });
  assert.deepEqual(resolveModeBinding('rosé', hasProvider), {
    mode: 'rosé',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    fallback: false,
  });
  assert.deepEqual(resolveModeBinding('lisa', hasProvider), {
    mode: 'lisa',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    fallback: true,
  });
});

test('mode resolution falls back to gpt-5.4 when only Codex auth is available', () => {
  const hasProvider = (provider) => provider === 'openai';

  assert.equal(resolveModeBinding('jennie', hasProvider).model, 'gpt-5.4');
  assert.equal(resolveModeBinding('lisa', hasProvider).model, 'gpt-5.4');
  assert.equal(resolveModeBinding('rosé', hasProvider).model, 'gpt-5.4');
  assert.equal(resolveModeBinding('jisoo', hasProvider).model, 'gpt-5.4');
});
