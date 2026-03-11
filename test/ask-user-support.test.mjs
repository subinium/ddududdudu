import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChoicePrompt,
  buildInputPrompt,
} from '../dist/tui/native/ask-user-support.js';

test('buildInputPrompt keeps freeform answers open while preserving structured suggestions', () => {
  const prompt = buildInputPrompt({
    question: 'What should I optimize for?',
    options: [
      {
        value: 'speed',
        label: 'Speed',
        description: 'Bias toward the fastest working result.',
      },
    ],
  });

  assert.equal(prompt.question, 'What should I optimize for?');
  assert.equal(prompt.kind, 'input');
  assert.equal(prompt.allowCustomAnswer, true);
  assert.equal(prompt.required, true);
  assert.equal(prompt.placeholder, 'Type your answer');
  assert.equal(
    prompt.detail,
    'Suggested answers are optional. You can type your own response.',
  );
  assert.deepEqual(prompt.options, [
    {
      value: 'speed',
      label: 'Speed',
      description: 'Bias toward the fastest working result.',
    },
  ]);
});

test('buildChoicePrompt keeps strict choice semantics for confirmation prompts', () => {
  const prompt = buildChoicePrompt({
    question: 'Allow this tool call?',
    detail: 'Risk: network, external',
    submitLabel: 'Resolve tool request',
    options: [
      {
        value: 'allow_once',
        label: 'Allow once',
        description: 'Run this tool call only once.',
      },
      {
        value: 'deny',
        label: 'Deny',
        description: 'Block this tool call.',
      },
    ],
  });

  assert.equal(prompt.question, 'Allow this tool call?');
  assert.equal(prompt.kind, 'single_select');
  assert.equal(prompt.allowCustomAnswer, false);
  assert.equal(prompt.submitLabel, 'Resolve tool request');
  assert.equal(prompt.detail, 'Risk: network, external');
  assert.deepEqual(prompt.options[0], {
    value: 'allow_once',
    label: 'Allow once',
    description: 'Run this tool call only once.',
  });
});
