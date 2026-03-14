import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeToolCalls } from '../dist/api/tool-executor.js';

const createRegistry = (tools) => ({
  get(name) {
    return tools.get(name);
  },
  toAnthropicFormat() {
    return [];
  },
});

describe('executeToolCalls concurrency and dispatch', () => {
  it('dispatches a known tool and returns tool_result', async () => {
    const registry = createRegistry(
      new Map([
        [
          'demo',
          {
            async execute(input) {
              return { output: `ok:${String(input.value)}` };
            },
          },
        ],
      ]),
    );

    const results = await executeToolCalls(
      [{ type: 'tool_use', id: '1', name: 'demo', input: { value: 7 } }],
      registry,
      { cwd: process.cwd() },
    );

    assert.deepEqual(results, [
      { type: 'tool_result', tool_use_id: '1', content: 'ok:7', is_error: undefined },
    ]);
  });

  it('returns an error result for unknown tools', async () => {
    const registry = createRegistry(new Map());

    const [result] = await executeToolCalls(
      [{ type: 'tool_use', id: 'u1', name: 'missing_tool', input: {} }],
      registry,
      { cwd: process.cwd() },
    );

    assert.equal(result.type, 'tool_result');
    assert.equal(result.tool_use_id, 'u1');
    assert.equal(result.is_error, true);
    assert.equal(result.content, 'Unknown tool: missing_tool');
  });

  it('converts tool exceptions into error tool_result blocks', async () => {
    const registry = createRegistry(
      new Map([
        [
          'boom',
          {
            async execute() {
              throw new Error('tool failed');
            },
          },
        ],
      ]),
    );

    const [result] = await executeToolCalls(
      [{ type: 'tool_use', id: 'e1', name: 'boom', input: {} }],
      registry,
      { cwd: process.cwd() },
    );

    assert.equal(result.is_error, true);
    assert.equal(result.content, 'tool failed');
  });

  it('applies augmenter when augmentationContext is provided', async () => {
    const registry = createRegistry(
      new Map([
        [
          'aug',
          {
            async execute() {
              return { output: 'base output', isError: false };
            },
          },
        ],
      ]),
    );

    const [result] = await executeToolCalls(
      [{ type: 'tool_use', id: 'a1', name: 'aug', input: { k: 1 } }],
      registry,
      { cwd: process.cwd() },
      {
        augmenter: {
          augment(name, input, toolResult) {
            assert.equal(name, 'aug');
            assert.deepEqual(input, { k: 1 });
            return { ...toolResult, output: `${toolResult.output} + augmented` };
          },
        },
        augmentationContext: { model: 'test' },
      },
    );

    assert.equal(result.content, 'base output + augmented');
    assert.equal(result.is_error, undefined);
  });

  it('emits before/after hook events for successful tool calls', async () => {
    const events = [];
    const registry = createRegistry(
      new Map([
        [
          'hooked',
          {
            async execute() {
              return { output: 'hooked output', isError: false };
            },
          },
        ],
      ]),
    );

    await executeToolCalls(
      [{ type: 'tool_use', id: 'h1', name: 'hooked', input: { v: true } }],
      registry,
      { cwd: process.cwd() },
      {
        hooks: {
          async emit(name, payload) {
            events.push({ name, payload });
          },
        },
      },
    );

    assert.equal(events.length, 2);
    assert.equal(events[0].name, 'beforeToolCall');
    assert.equal(events[1].name, 'afterToolCall');
    assert.equal(events[1].payload.isError, false);
  });

  it('limits concurrent execution to batch size and preserves ordering', async () => {
    let active = 0;
    let maxActive = 0;

    const registry = createRegistry(
      new Map([
        [
          'slow',
          {
            async execute(input) {
              active += 1;
              maxActive = Math.max(maxActive, active);
              await new Promise((resolve) => setTimeout(resolve, 10));
              active -= 1;
              return { output: `done:${String(input.index)}` };
            },
          },
        ],
      ]),
    );

    const blocks = Array.from({ length: 25 }, (_, index) => ({
      type: 'tool_use',
      id: `c${String(index)}`,
      name: 'slow',
      input: { index },
    }));

    const results = await executeToolCalls(blocks, registry, { cwd: process.cwd() });

    assert.equal(results.length, 25);
    assert.ok(maxActive <= 10);
    assert.deepEqual(
      results.map((result) => result.tool_use_id),
      blocks.map((block) => block.id),
    );
  });
});
