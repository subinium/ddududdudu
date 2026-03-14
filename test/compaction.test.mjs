import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CompactionEngine } from '../dist/core/compaction.js';

const msg = (role, content) => ({ role, content });

describe('CompactionEngine', () => {
  it('should warn only when usage is above 80%', () => {
    const engine = new CompactionEngine();

    assert.equal(engine.shouldWarn(81, 100), true);
    assert.equal(engine.shouldWarn(80, 100), false);
    assert.equal(engine.shouldWarn(100, 0), false);
  });

  it('legacy compact includes default instructions and preserves system/tool/recent context', async () => {
    const engine = new CompactionEngine();
    const result = await engine.compact([
      msg('system', 'System policy must stay.'),
      msg('assistant', 'tool stdout captured with details'),
      msg('assistant', 'normal note one'),
      msg('user', 'normal note two'),
      msg('assistant', 'normal note three'),
    ]);

    assert.match(result, /# Compacted Context/);
    assert.match(result, /Instructions: Continue from this compacted state\./);
    assert.match(result, /\[system\] System policy must stay\./);
    assert.match(result, /\[assistant\] tool stdout captured with details/);
    assert.match(result, /## Preserved Messages/);
  });

  it('legacy compact deduplicates preserved messages by role and content', async () => {
    const engine = new CompactionEngine();
    const duplicate = 'Repeated system guidance';
    const result = await engine.compact([
      msg('system', duplicate),
      msg('system', duplicate),
      msg('user', 'latest request'),
    ]);

    const preservedSection = result.split('## Preserved Messages\n')[1] ?? '';
    const matches = preservedSection.match(/\[system\] Repeated system guidance/g) ?? [];
    assert.equal(matches.length, 1);
  });

  it('llm compact strips code fences and prefixes structured summary', async () => {
    const engine = new CompactionEngine();
    const result = await engine.compact(
      [msg('user', 'Need a concise handoff')],
      {
        summarizer: async () => '```markdown\n## Goal\nFinish the task\n```',
      },
    );

    assert.match(result, /^# Compacted Context/);
    assert.ok(!result.includes('```'));
    assert.match(result, /## Goal\nFinish the task/);
  });

  it('llm compact prunes older tool-heavy content but preserves recent turns', async () => {
    const engine = new CompactionEngine();
    let capturedUserMessage = '';

    const long = 'A'.repeat(900);
    const messages = [
      msg('user', 'old request'),
      msg('assistant', `[tool:ok]\nline1\nline2\nline3\nline4\nline5\nline6\n${long}`),
      msg('assistant', 'old assistant response'),
      msg('user', 'most recent request'),
      msg('assistant', 'most recent response should remain untouched'),
    ];

    await engine.compact(messages, {
      preserveRecentTurns: 0,
      summarizer: async (_systemPrompt, userMessage) => {
        capturedUserMessage = userMessage;
        return '## Goal\nCaptured';
      },
    });

    assert.match(capturedUserMessage, /line1/);
    assert.match(capturedUserMessage, /line3/);
    assert.doesNotMatch(capturedUserMessage, /line6/);
    assert.match(capturedUserMessage, /most recent response should remain untouched/);
  });

  it('compact falls back to legacy mode when summarizer fails', async () => {
    const engine = new CompactionEngine();
    const result = await engine.compact(
      [msg('user', 'fallback please')],
      {
        instructions: 'Do not lose context',
        summarizer: async () => {
          throw new Error('upstream failed');
        },
      },
    );

    assert.match(result, /Instructions: Do not lose context/);
    assert.match(result, /## Summary/);
  });

  it('handoff extracts and sorts relevant files with llm summary', async () => {
    const engine = new CompactionEngine();
    const handoff = await engine.handoff(
      'Implement tests',
      [
        msg('user', 'Touched src/core/checks.ts and test/checks.test.mjs'),
        msg('assistant', 'Also updated src/core/compaction.ts'),
      ],
      {
        summarizer: async () => '## Goal\nContinue implementation',
      },
    );

    assert.deepEqual(handoff.relevantFiles, [
      'src/core/checks.ts',
      'src/core/compaction.ts',
      'test/checks.test.mjs',
    ]);
    assert.match(handoff.summary, /^# Compacted Context/);
    assert.equal(handoff.draftPrompt, 'Continue from this handoff. Goal: Implement tests');
  });
});
