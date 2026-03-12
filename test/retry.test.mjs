import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyError, computeBackoffMs, sleep, DEFAULT_RETRY_CONFIG } from '../dist/api/retry.js';

test('classifyError returns auth for 401 errors', () => {
  assert.equal(classifyError(new Error('HTTP 401 Unauthorized')), 'auth');
});

test('classifyError returns auth for forbidden errors', () => {
  assert.equal(classifyError(new Error('Request forbidden')), 'auth');
});

test('classifyError returns auth for invalid api key', () => {
  assert.equal(classifyError(new Error('invalid api key provided')), 'auth');
});

test('classifyError returns auth for expired token', () => {
  assert.equal(classifyError(new Error('expired token')), 'auth');
});

test('classifyError returns retryable for 429 rate limit', () => {
  assert.equal(classifyError(new Error('HTTP 429 Too Many Requests')), 'retryable');
});

test('classifyError returns retryable for 503 errors', () => {
  assert.equal(classifyError(new Error('HTTP 503 Service Unavailable')), 'retryable');
});

test('classifyError returns retryable for ECONNRESET', () => {
  assert.equal(classifyError(new Error('ECONNRESET')), 'retryable');
});

test('classifyError returns retryable for timeout', () => {
  assert.equal(classifyError(new Error('Request timeout after 30s')), 'retryable');
});

test('classifyError returns retryable for fetch failed', () => {
  assert.equal(classifyError(new Error('fetch failed')), 'retryable');
});

test('classifyError returns fatal for unknown errors', () => {
  assert.equal(classifyError(new Error('something unexpected')), 'fatal');
});

test('classifyError handles non-Error values', () => {
  assert.equal(classifyError('raw string 503'), 'retryable');
  assert.equal(classifyError(42), 'fatal');
});

test('classifyError prioritizes auth over retryable when both match', () => {
  assert.equal(classifyError(new Error('401 rate limit')), 'auth');
});

test('computeBackoffMs returns value within expected range', () => {
  const config = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 16000 };
  for (let attempt = 0; attempt < 4; attempt++) {
    const delay = computeBackoffMs(attempt, config);
    assert.ok(delay > 0, `attempt ${attempt} delay should be positive`);
    assert.ok(delay <= config.maxDelayMs, `attempt ${attempt} delay should not exceed max`);
  }
});

test('computeBackoffMs increases with attempt number', () => {
  const config = { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 100_000 };
  const samples = 20;
  let avg0 = 0;
  let avg2 = 0;
  for (let i = 0; i < samples; i++) {
    avg0 += computeBackoffMs(0, config);
    avg2 += computeBackoffMs(2, config);
  }
  avg0 /= samples;
  avg2 /= samples;
  assert.ok(avg2 > avg0, 'higher attempt should produce larger average delay');
});

test('computeBackoffMs respects maxDelayMs cap', () => {
  const config = { maxRetries: 10, baseDelayMs: 10000, maxDelayMs: 5000 };
  const delay = computeBackoffMs(5, config);
  assert.ok(delay <= config.maxDelayMs);
});

test('computeBackoffMs uses DEFAULT_RETRY_CONFIG when no config given', () => {
  const delay = computeBackoffMs(0);
  assert.ok(delay > 0);
  assert.ok(delay <= DEFAULT_RETRY_CONFIG.maxDelayMs);
});

test('sleep resolves after the given duration', async () => {
  const start = Date.now();
  await sleep(50);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 40, `expected ~50ms, got ${elapsed}ms`);
});

test('sleep rejects immediately if signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort('cancelled');
  await assert.rejects(() => sleep(10_000, controller.signal), (error) => error === 'cancelled');
});

test('sleep rejects when signal aborts during wait', async () => {
  const controller = new AbortController();
  const promise = sleep(10_000, controller.signal);
  setTimeout(() => controller.abort('stopped'), 20);
  await assert.rejects(() => promise, (error) => error === 'stopped');
});
