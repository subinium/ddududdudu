import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('auth store reads, writes, and deletes provider auth under DDUDU_HOME', async () => {
  const dduduHome = await mkdtemp(join(tmpdir(), 'ddudu-auth-store-'));
  const previousHome = process.env.DDUDU_HOME;
  process.env.DDUDU_HOME = dduduHome;

  try {
    const store = await import('../dist/auth/store.js');

    assert.match(store.getAuthStorePath(), /auth\.yaml$/);
    assert.equal(await store.getStoredProviderAuth('claude'), null);

    const path = await store.setStoredProviderAuth('claude', {
      token: 'sk-test-claude',
      tokenType: 'apikey',
      source: 'ddudu-auth-store',
      label: 'Anthropic API key',
    });

    assert.equal(path, store.getAuthStorePath());

    const stored = await store.getStoredProviderAuth('claude');
    assert.equal(stored?.token, 'sk-test-claude');
    assert.equal(stored?.tokenType, 'apikey');
    assert.equal(stored?.source, 'ddudu-auth-store');
    assert.equal(stored?.label, 'Anthropic API key');
    assert.ok(stored?.updatedAt);

    await store.deleteStoredProviderAuth('claude');
    assert.equal(await store.getStoredProviderAuth('claude'), null);
  } finally {
    if (previousHome === undefined) {
      delete process.env.DDUDU_HOME;
    } else {
      process.env.DDUDU_HOME = previousHome;
    }
    await rm(dduduHome, { recursive: true, force: true });
  }
});
