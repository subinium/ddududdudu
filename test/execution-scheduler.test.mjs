import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ExecutionScheduler } from '../dist/core/execution-scheduler.js';

test('ExecutionScheduler enforces generic resource budgets independently of provider slots', async () => {
  const originalHome = process.env.HOME;
  const tempHome = await mkdtemp(join(tmpdir(), 'ddudu-scheduler-'));
  process.env.HOME = tempHome;

  try {
    const scheduler = new ExecutionScheduler({
      resourceBudgets: { search: 1 },
      pollMs: 25,
      staleMs: 1_000,
    });
    const firstLease = await scheduler.acquire({ resource: 'search' });
    const waits = [];
    let secondAcquired = false;

    const secondLeasePromise = scheduler.acquire({
      resource: 'search',
      onWait: (message) => {
        waits.push(message);
      },
    });

    const trackedSecondLease = secondLeasePromise.then(async (lease) => {
      secondAcquired = true;
      await lease.release();
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(secondAcquired, false);
    assert.ok(waits.some((message) => /search slot/i.test(message)));

    await firstLease.release();
    await trackedSecondLease;
    assert.equal(secondAcquired, true);
  } finally {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  }
});
