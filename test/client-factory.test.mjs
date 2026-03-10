import test from 'node:test';
import assert from 'node:assert/strict';

import { getClientCapabilities } from '../dist/api/client-factory.js';

test('getClientCapabilities reflects provider auth/runtime differences', () => {
  const anthropicOauth = getClientCapabilities('anthropic', 'oauth');
  assert.equal(anthropicOauth.executionMode, 'cli');
  assert.equal(anthropicOauth.supportsRemoteSession, true);
  assert.equal(anthropicOauth.supportsToolState, true);
  assert.equal(anthropicOauth.supportsApiToolCalls, false);

  const anthropicApi = getClientCapabilities('anthropic', 'api_key');
  assert.equal(anthropicApi.executionMode, 'api');
  assert.equal(anthropicApi.supportsApiToolCalls, true);
  assert.equal(anthropicApi.supportsRemoteSession, false);

  const openAiBearer = getClientCapabilities('openai', 'bearer');
  assert.equal(openAiBearer.executionMode, 'cli');
  assert.equal(openAiBearer.supportsRemoteSession, true);

  const openAiApi = getClientCapabilities('openai', 'api_key');
  assert.equal(openAiApi.executionMode, 'api');
  assert.equal(openAiApi.supportsApiToolCalls, false);

  const gemini = getClientCapabilities('gemini', 'api_key');
  assert.equal(gemini.executionMode, 'api');
  assert.equal(gemini.supportsApiToolCalls, false);
  assert.equal(gemini.supportsRemoteSession, false);
});
