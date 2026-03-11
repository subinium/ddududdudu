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
      detail: {
        type: 'string',
        description: 'Optional extra context that helps the user answer the question.',
      },
      kind: {
        type: 'string',
        description: 'Question kind. Defaults to input. Use confirm or single_select for strict choices.',
        enum: ['input', 'confirm', 'single_select', 'number', 'path'],
      },
      placeholder: {
        type: 'string',
        description: 'Optional input hint shown when the user can type a custom answer.',
      },
      submit_label: {
        type: 'string',
        description: 'Optional custom action label for submitting the answer.',
      },
      allow_custom_answer: {
        type: 'boolean',
        description: 'Whether the user can type a custom answer instead of picking from suggestions. Defaults to true.',
      },
      required: {
        type: 'boolean',
        description: 'Whether the question requires an answer. Defaults to true.',
      },
      default_value: {
        type: 'string',
        description: 'Optional default answer value used when the user submits an empty response.',
      },
      validation_pattern: {
        type: 'string',
        description: 'Optional regex pattern that custom answers must match.',
      },
      validation_message: {
        type: 'string',
        description: 'Optional custom validation error message shown when the answer is invalid.',
      },
      min_length: {
        type: 'number',
        description: 'Optional minimum custom answer length.',
      },
      max_length: {
        type: 'number',
        description: 'Optional maximum custom answer length.',
      },
      options: {
        type: 'array',
        description:
          'Optional list of suggested answers. The user can pick one or type a custom response.',
        items: { type: 'string', description: 'A suggested option.' },
      },
      choices: {
        type: 'array',
        description:
          'Optional structured suggested answers with separate labels and descriptions.',
        items: {
          type: 'object',
          description: 'A suggested answer.',
          properties: {
            value: {
              type: 'string',
              description: 'The answer value to send back if this choice is selected.',
              required: true,
            },
            label: {
              type: 'string',
              description: 'Optional shorter label shown in the UI.',
            },
            description: {
              type: 'string',
              description: 'Optional one-line explanation shown under or beside the label.',
            },
            recommended: {
              type: 'boolean',
              description: 'Whether this is the recommended or default choice.',
            },
            danger: {
              type: 'boolean',
              description: 'Whether this choice is risky and should render with warning styling.',
            },
            shortcut: {
              type: 'string',
              description: 'Optional shortcut hint shown for the choice.',
            },
          },
        },
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

    const choices: Array<{
      value: string;
      label?: string;
      description?: string;
      recommended?: boolean;
      danger?: boolean;
      shortcut?: string;
    }> = [];
    if (Array.isArray(args.choices)) {
      for (const item of args.choices) {
        if (typeof item !== 'object' || item === null) {
          continue;
        }
        const value = typeof item.value === 'string' ? item.value.trim() : '';
        if (!value) {
          continue;
        }
        choices.push({
          value,
          ...(typeof item.label === 'string' && item.label.trim().length > 0
            ? { label: item.label.trim() }
            : {}),
          ...(typeof item.description === 'string' && item.description.trim().length > 0
            ? { description: item.description.trim() }
            : {}),
          ...(item.recommended === true ? { recommended: true } : {}),
          ...(item.danger === true ? { danger: true } : {}),
          ...(typeof item.shortcut === 'string' && item.shortcut.trim().length > 0
            ? { shortcut: item.shortcut.trim() }
            : {}),
        });
      }
    }

    try {
      const answer = await ctx.askUser({
        question: args.question.trim(),
        kind:
          args.kind === 'input'
          || args.kind === 'confirm'
          || args.kind === 'single_select'
          || args.kind === 'number'
          || args.kind === 'path'
            ? args.kind
            : undefined,
        detail: typeof args.detail === 'string' ? args.detail.trim() : undefined,
        placeholder: typeof args.placeholder === 'string' ? args.placeholder.trim() : undefined,
        submitLabel: typeof args.submit_label === 'string' ? args.submit_label.trim() : undefined,
        allowCustomAnswer: typeof args.allow_custom_answer === 'boolean' ? args.allow_custom_answer : true,
        required: typeof args.required === 'boolean' ? args.required : true,
        defaultValue: typeof args.default_value === 'string' ? args.default_value.trim() : undefined,
        validation: {
          pattern: typeof args.validation_pattern === 'string' ? args.validation_pattern.trim() : undefined,
          message: typeof args.validation_message === 'string' ? args.validation_message.trim() : undefined,
          minLength:
            typeof args.min_length === 'number' && Number.isFinite(args.min_length)
              ? Math.max(0, Math.floor(args.min_length))
              : undefined,
          maxLength:
            typeof args.max_length === 'number' && Number.isFinite(args.max_length)
              ? Math.max(0, Math.floor(args.max_length))
              : undefined,
        },
        options: choices.length > 0 ? choices : options.map((value) => ({ value })),
      });
      return {
        output: answer.value,
        metadata: {
          question: args.question,
          kind:
            args.kind === 'input'
            || args.kind === 'confirm'
            || args.kind === 'single_select'
            || args.kind === 'number'
            || args.kind === 'path'
              ? args.kind
              : undefined,
          detail: typeof args.detail === 'string' ? args.detail.trim() : undefined,
          placeholder: typeof args.placeholder === 'string' ? args.placeholder.trim() : undefined,
          submitLabel: typeof args.submit_label === 'string' ? args.submit_label.trim() : undefined,
          allowCustomAnswer:
            typeof args.allow_custom_answer === 'boolean' ? args.allow_custom_answer : true,
          required: typeof args.required === 'boolean' ? args.required : true,
          defaultValue: typeof args.default_value === 'string' ? args.default_value.trim() : undefined,
          validationPattern:
            typeof args.validation_pattern === 'string' ? args.validation_pattern.trim() : undefined,
          validationMessage:
            typeof args.validation_message === 'string' ? args.validation_message.trim() : undefined,
          minLength:
            typeof args.min_length === 'number' && Number.isFinite(args.min_length)
              ? Math.max(0, Math.floor(args.min_length))
              : undefined,
          maxLength:
            typeof args.max_length === 'number' && Number.isFinite(args.max_length)
              ? Math.max(0, Math.floor(args.max_length))
              : undefined,
          options: options.length > 0 ? options : undefined,
          choices: choices.length > 0 ? choices : undefined,
          answer,
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
