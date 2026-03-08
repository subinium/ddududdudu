import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { SessionManager } from '../dist/core/session.js';

test('SessionManager.list derives readable title, provider, model, and preview', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-session-list-'));
  try {
    const manager = new SessionManager(resolve(root, 'sessions'));
    const header = await manager.create({
      provider: 'openai',
      model: 'gpt-5.4',
    });

    await manager.append(header.id, {
      type: 'message',
      timestamp: new Date().toISOString(),
      data: {
        user: 'fix the queue ordering and improve session resume UX',
        assistant: 'done',
        mode: 'lisa',
        provider: 'openai',
        model: 'gpt-5.4',
      },
    });

    const sessions = await manager.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.provider, 'openai');
    assert.equal(sessions[0]?.model, 'gpt-5.4');
    assert.equal(sessions[0]?.mode, 'lisa');
    assert.match(sessions[0]?.title ?? '', /fix the queue ordering/i);
    assert.match(sessions[0]?.preview ?? '', /fix the queue ordering/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
