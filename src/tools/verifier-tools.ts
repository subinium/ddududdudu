import {
  runStructuredVerifierCommand,
  type StructuredRunnerResult,
} from '../core/structured-runners.js';
import { VerificationRunner, type VerificationMode, type VerificationSummary } from '../core/verifier.js';
import type { Tool } from './index.js';

const createRunnerTool = (kind: 'lint' | 'test' | 'build'): Tool => ({
  definition: {
    name: `${kind}_runner`,
    description: `Run project ${kind} in a structured way with summarized failures and highlights.`,
    parameters: {
      script: {
        type: 'string',
        description: `Optional package.json script override for ${kind}.`,
      },
      command: {
        type: 'string',
        description: `Optional explicit shell command override for ${kind}.`,
      },
      timeout_ms: {
        type: 'number',
        description: `Timeout for the ${kind} run in milliseconds.`,
      },
    },
  },
  async execute(args, ctx) {
    const result = await runStructuredVerifierCommand(ctx.cwd, {
      kind,
      script: args.script,
      command: args.command,
      timeoutMs: args.timeout_ms,
    });

    return {
      output: [
        `Runner: ${kind}`,
        `Command: ${result.command}`,
        `Status: ${result.ok ? 'passed' : 'failed'}`,
        result.summary ? `Summary: ${result.summary}` : null,
        '',
        result.output,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n'),
      isError: !result.ok,
      metadata: {
        kind,
        command: result.command,
        ok: result.ok,
        exitCode: result.exitCode,
        summary: result.summary,
        highlights: result.highlights,
        truncated: result.truncated,
      },
    };
  },
});

const serializeVerificationSummary = (verification: VerificationSummary): string => {
  const lines = [
    `Status: ${verification.status}`,
    `Summary: ${verification.summary}`,
    verification.changedFiles.length > 0
      ? `Changed files: ${verification.changedFiles.join(', ')}`
      : 'Changed files: none detected',
    '',
    verification.report,
  ];
  return lines.join('\n');
};

export const lintRunnerTool = createRunnerTool('lint');
export const testRunnerTool = createRunnerTool('test');
export const buildRunnerTool = createRunnerTool('build');

export const verifyChangesTool: Tool = {
  definition: {
    name: 'verify_changes',
    description: 'Run the harness verification loop against the current working tree diff.',
    parameters: {
      mode: {
        type: 'string',
        description: 'Verification depth to run.',
        enum: ['checks', 'full'],
      },
    },
  },
  async execute(args, ctx) {
    const mode =
      args.mode === 'full' || args.mode === 'checks'
        ? (args.mode as Exclude<VerificationMode, 'none'>)
        : 'checks';
    const verification = await new VerificationRunner(ctx.cwd).run(mode);
    return {
      output: serializeVerificationSummary(verification),
      isError: verification.status === 'failed',
      metadata: {
        mode,
        verification,
      },
    };
  },
};

export type { StructuredRunnerResult };
