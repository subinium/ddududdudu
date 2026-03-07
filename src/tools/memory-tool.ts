import {
  appendMemory,
  clearMemory,
  loadMemory,
  saveMemory,
  type MemoryScope,
} from '../core/memory.js';
import type { Tool } from './index.js';

type MemoryAction = 'read' | 'write' | 'append' | 'clear';

const isMemoryAction = (value: unknown): value is MemoryAction => {
  return value === 'read' || value === 'write' || value === 'append' || value === 'clear';
};

const isMemoryScope = (value: unknown): value is MemoryScope => {
  return value === 'global' || value === 'project';
};

const parseScope = (value: unknown): MemoryScope | null => {
  if (value === undefined) {
    return 'project';
  }

  if (isMemoryScope(value)) {
    return value;
  }

  return null;
};

const getScopedMemory = (combinedMemory: string, scope: MemoryScope): string => {
  const globalHeader = '## Global Memory\n';
  const projectHeader = '\n\n## Project Memory\n';
  const projectIndex = combinedMemory.indexOf(projectHeader);

  if (scope === 'global') {
    if (!combinedMemory.startsWith(globalHeader)) {
      return combinedMemory;
    }

    if (projectIndex === -1) {
      return combinedMemory.slice(globalHeader.length);
    }

    return combinedMemory.slice(globalHeader.length, projectIndex);
  }

  if (projectIndex === -1) {
    return '';
  }

  return combinedMemory.slice(projectIndex + projectHeader.length);
};

export const memoryTool: Tool = {
  definition: {
    name: 'memory',
    description: 'Read and manage ddudu memory context files.',
    parameters: {
      action: {
        type: 'string',
        description: 'Memory action: read, write, append, or clear.',
        required: true,
        enum: ['read', 'write', 'append', 'clear'],
      },
      content: {
        type: 'string',
        description: 'Memory content used by write and append actions.',
      },
      scope: {
        type: 'string',
        description: 'Memory scope to target (global or project).',
        enum: ['global', 'project'],
      },
    },
  },
  async execute(args, ctx) {
    if (!isMemoryAction(args.action)) {
      return {
        output: 'Missing or invalid required argument: action',
        isError: true,
      };
    }

    const scope = parseScope(args.scope);
    if (!scope) {
      return {
        output: 'Invalid argument: scope must be global or project',
        isError: true,
      };
    }

    try {
      if (args.action === 'read') {
        const memory = await loadMemory(ctx.cwd);
        if (args.scope === undefined) {
          return { output: memory };
        }

        return { output: getScopedMemory(memory, scope) };
      }

      if (args.action === 'write') {
        if (typeof args.content !== 'string') {
          return { output: 'Missing required argument: content', isError: true };
        }

        await saveMemory(ctx.cwd, args.content, scope);
        return { output: `Memory written to ${scope} scope.` };
      }

      if (args.action === 'append') {
        if (typeof args.content !== 'string') {
          return { output: 'Missing required argument: content', isError: true };
        }

        await appendMemory(ctx.cwd, args.content, scope);
        return { output: `Memory appended in ${scope} scope.` };
      }

      await clearMemory(ctx.cwd, scope);
      return { output: `Memory cleared in ${scope} scope.` };
    } catch (error: unknown) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  },
};
