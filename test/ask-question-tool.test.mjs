import test from 'node:test';
import assert from 'node:assert/strict';

import { askQuestionTool } from '../dist/tools/ask-question-tool.js';

test('ask_question forwards a rich prompt to askUser and preserves metadata', async () => {
  let capturedPrompt = null;

  const result = await askQuestionTool.execute(
    {
      question: 'Which path should I take?',
      kind: 'single_select',
      detail: 'One option is safer, the other is faster.',
      placeholder: 'Explain your preference',
      submit_label: 'Continue',
      allow_custom_answer: false,
      required: true,
      default_value: 'safe',
      choices: [
        {
          value: 'safe',
          label: 'Safe path',
          description: 'Preserve compatibility and move carefully.',
          recommended: true,
          shortcut: '1',
        },
        {
          value: 'fast',
          label: 'Fast path',
          description: 'Optimize for speed over conservatism.',
          danger: true,
          shortcut: '2',
        },
      ],
    },
    {
      cwd: process.cwd(),
      askUser: async (prompt) => {
        capturedPrompt = prompt;
        return {
          value: 'safe',
          source: 'choice',
          optionIndex: 0,
          optionLabel: 'Safe path',
        };
      },
    },
  );

  assert.equal(result.output, 'safe');
  assert.equal(capturedPrompt.question, 'Which path should I take?');
  assert.equal(capturedPrompt.kind, 'single_select');
  assert.equal(capturedPrompt.detail, 'One option is safer, the other is faster.');
  assert.equal(capturedPrompt.placeholder, 'Explain your preference');
  assert.equal(capturedPrompt.submitLabel, 'Continue');
  assert.equal(capturedPrompt.allowCustomAnswer, false);
  assert.equal(capturedPrompt.required, true);
  assert.equal(capturedPrompt.defaultValue, 'safe');
  assert.equal(capturedPrompt.options.length, 2);
  assert.deepEqual(capturedPrompt.options[0], {
    value: 'safe',
    label: 'Safe path',
    description: 'Preserve compatibility and move carefully.',
    recommended: true,
    shortcut: '1',
  });
  assert.equal(result.metadata.submitLabel, 'Continue');
  assert.equal(result.metadata.allowCustomAnswer, false);
  assert.equal(result.metadata.kind, 'single_select');
  assert.equal(result.metadata.defaultValue, 'safe');
  assert.equal(result.metadata.choices.length, 2);
  assert.deepEqual(result.metadata.answer, {
    value: 'safe',
    source: 'choice',
    optionIndex: 0,
    optionLabel: 'Safe path',
  });
});
