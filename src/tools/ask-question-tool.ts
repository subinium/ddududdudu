import type { Tool } from './index.js';

export const askQuestionTool: Tool = {
  definition: {
    name: 'ask_question',
    description:
      'Ask the user a clarifying question during execution. ' +
      'Use this when you need user input to proceed — preferences, ' +
      'ambiguous instructions, implementation choices, or confirmation. ' +
      'Optionally provide a list of suggested options. ' +
      'The user can always type a custom answer.',
    parameters: {
      question: {
        type: 'string',
        description: 'The question to ask the user.',
        required: true,
      },
      options: {
        type: 'array',
        description:
          'Optional list of suggested answers. The user can pick one or type a custom response.',
        items: { type: 'string', description: 'A suggested option.' },
      },
    },
  },
  async execute(args, ctx) {
    if (typeof args.question !== 'string' || args.question.trim().length === 0) {
      return { output: 'Missing required argument: question', isError: true };
    }

    if (!ctx.askUser) {
      return {
        output:
          'ask_question is not available in this context (no interactive TUI session).',
        isError: true,
      };
    }

    const options: string[] = [];
    if (Array.isArray(args.options)) {
      for (const opt of args.options) {
        if (typeof opt === 'string' && opt.trim().length > 0) {
          options.push(opt.trim());
        }
      }
    }

    try {
      const answer = await ctx.askUser(args.question, options.length > 0 ? options : undefined);
      return {
        output: answer,
        metadata: {
          question: args.question,
          options: options.length > 0 ? options : undefined,
          answeredAt: new Date().toISOString(),
        },
      };
    } catch (err: unknown) {
      return {
        output: err instanceof Error ? err.message : 'User did not answer.',
        isError: true,
      };
    }
  },
};
