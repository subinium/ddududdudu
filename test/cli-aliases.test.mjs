import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../dist/cli.js';
import { SLASH_COMMANDS } from '../dist/tui/shared/types.js';

test('parseArgs keeps top-level resume alias available', () => {
  const parsed = parseArgs(['resume', 'abc123']);
  assert.equal(parsed.command, 'resume');
  assert.deepEqual(parsed.args, ['abc123']);
});

test('parseArgs supports help and short flags without treating them as positional args', () => {
  const sessionHelp = parseArgs(['session', '--help']);
  assert.equal(sessionHelp.command, 'session');
  assert.equal(sessionHelp.flags.help, true);

  const initHelpWithTarget = parseArgs(['init', '--help', '/tmp/project']);
  assert.equal(initHelpWithTarget.command, 'init');
  assert.equal(initHelpWithTarget.flags.help, true);
  assert.deepEqual(initHelpWithTarget.args, ['/tmp/project']);

  const initHelp = parseArgs(['init', '-h']);
  assert.equal(initHelp.command, 'init');
  assert.equal(initHelp.flags.h, true);

  const authMethod = parseArgs(['auth', 'login', 'codex', '-m', 'vendor']);
  assert.equal(authMethod.command, 'auth');
  assert.equal(authMethod.subcommand, 'login');
  assert.equal(authMethod.flags.m, 'vendor');
});

test('slash command list includes /resume alias', () => {
  assert.ok(SLASH_COMMANDS.some((command) => command.value === '/resume'));
});
