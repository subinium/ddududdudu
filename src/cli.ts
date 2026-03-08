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

const parseFlagsAndArgs = (tokens: string[]): ParsedArgs => {
  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!token.startsWith('--')) {
      args.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const eqIndex = withoutPrefix.indexOf('=');
    if (eqIndex >= 0) {
      const key = withoutPrefix.slice(0, eqIndex);
      const value = withoutPrefix.slice(eqIndex + 1);
      flags[key] = value;
      continue;
    }

    const next = tokens[index + 1];
    if (next && !next.startsWith('--')) {
      flags[withoutPrefix] = next;
      index += 1;
      continue;
    }

    flags[withoutPrefix] = true;
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
