export interface ParsedCommand {
  command: string;
  subcommand?: string;
  args: string[];
  flags: Record<string, string | boolean>;
}

interface ParsedArgs {
  args: string[];
  flags: Record<string, string | boolean>;
}

const GLOBAL_HELP_FLAGS = new Set(['--help', '-h']);
const GLOBAL_VERSION_FLAGS = new Set(['--version', '-v']);
const BOOLEAN_LONG_FLAGS = new Set(['help', 'version']);
const BOOLEAN_SHORT_FLAGS = new Set(['h', 'v']);

const parseFlagsAndArgs = (tokens: string[]): ParsedArgs => {
  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === '--') {
      args.push(...tokens.slice(index + 1));
      break;
    }

    if (!token.startsWith('-') || token === '-') {
      args.push(token);
      continue;
    }

    if (token.startsWith('--')) {
      const withoutPrefix = token.slice(2);
      const eqIndex = withoutPrefix.indexOf('=');
      if (eqIndex >= 0) {
        const key = withoutPrefix.slice(0, eqIndex);
        const value = withoutPrefix.slice(eqIndex + 1);
        flags[key] = value;
        continue;
      }

      if (BOOLEAN_LONG_FLAGS.has(withoutPrefix)) {
        flags[withoutPrefix] = true;
        continue;
      }

      const next = tokens[index + 1];
      if (next && !next.startsWith('-')) {
        flags[withoutPrefix] = next;
        index += 1;
        continue;
      }

      flags[withoutPrefix] = true;
      continue;
    }

    const withoutPrefix = token.slice(1);
    const eqIndex = withoutPrefix.indexOf('=');
    if (eqIndex >= 0) {
      const key = withoutPrefix.slice(0, eqIndex);
      const value = withoutPrefix.slice(eqIndex + 1);
      flags[key] = value;
      continue;
    }

    if (/^[A-Za-z]$/.test(withoutPrefix)) {
      if (BOOLEAN_SHORT_FLAGS.has(withoutPrefix)) {
        flags[withoutPrefix] = true;
        continue;
      }

      const next = tokens[index + 1];
      if (next && !next.startsWith('-')) {
        flags[withoutPrefix] = next;
        index += 1;
        continue;
      }

      flags[withoutPrefix] = true;
      continue;
    }

    if (/^[A-Za-z]+$/.test(withoutPrefix)) {
      for (const key of withoutPrefix) {
        flags[key] = true;
      }
      continue;
    }

    args.push(token);
  }

  return { args, flags };
};

export const parseArgs = (argv: string[]): ParsedCommand => {
  const tokens = argv.slice();
  if (tokens.length === 0) {
    return { command: 'tui', args: [], flags: {} };
  }

  const first = tokens[0];
  if (GLOBAL_HELP_FLAGS.has(first)) {
    return { command: 'help', args: [], flags: {} };
  }

  if (GLOBAL_VERSION_FLAGS.has(first)) {
    return { command: 'version', args: [], flags: {} };
  }

  if (first === 'help') {
    return {
      command: 'help',
      args: tokens.slice(1),
      flags: {},
    };
  }

  const command = first;
  const tail = tokens.slice(1);
  const parsed = parseFlagsAndArgs(tail);

  if (
    command === 'config' ||
    command === 'provider' ||
    command === 'session' ||
    command === 'auth' ||
    command === 'job'
  ) {
    const [subcommand, ...restArgs] = parsed.args;
    return {
      command,
      subcommand,
      args: restArgs,
      flags: parsed.flags,
    };
  }

  return {
    command,
    args: parsed.args,
    flags: parsed.flags,
  };
};
