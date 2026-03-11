import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../dist/cli.js';
import { SLASH_COMMANDS } from '../dist/tui/shared/types.js';

test('parseArgs keeps top-level resume alias available', () => {
  const parsed = parseArgs(['resume', 'abc123']);
  assert.equal(parsed.command, 'resume');
  assert.deepEqual(parsed.args, ['abc123']);
});

test('slash command list includes /resume alias', () => {
  assert.ok(SLASH_COMMANDS.some((command) => command.value === '/resume'));
});
