import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGeminiLoginHelp,
  normalizeAuthProviderName,
  resolveRequestedAuthProvider,
} from '../dist/auth/login.js';

test('normalizeAuthProviderName supports provider aliases', () => {
  assert.equal(normalizeAuthProviderName('claude'), 'claude');
  assert.equal(normalizeAuthProviderName('codex'), 'codex');
  assert.equal(normalizeAuthProviderName('openai'), 'codex');
  assert.equal(normalizeAuthProviderName('gemini'), 'gemini');
  assert.equal(normalizeAuthProviderName('unknown'), null);
});

test('resolveRequestedAuthProvider reads flags and args', () => {
  assert.equal(resolveRequestedAuthProvider(['claude'], {}), 'claude');
  assert.equal(resolveRequestedAuthProvider([], { provider: 'codex' }), 'codex');
  assert.equal(resolveRequestedAuthProvider([], { p: 'openai' }), 'codex');
  assert.equal(resolveRequestedAuthProvider(['all'], {}), 'all');
  assert.equal(resolveRequestedAuthProvider([], {}), null);
});

test('buildGeminiLoginHelp returns guided setup text', () => {
  const lines = buildGeminiLoginHelp().join('\n');
  assert.match(lines, /GEMINI_API_KEY/);
  assert.match(lines, /\.gemini\/oauth_creds\.json/);
  assert.match(lines, /ddudu auth/);
});
