import type { ToolResult } from '../tools/index.js';

export interface AugmentationContext {
  recentToolNames: string[];
  contextUsagePercent: number;
  pendingVerification: boolean;
  availableSkills: string[];
  currentMode: string | null;
}

interface AugmentationRule {
  id: string;
  trigger: (
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    ctx: AugmentationContext,
  ) => boolean;
  message: (
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    ctx: AugmentationContext,
  ) => string;
  cooldown: number;
}

const FILE_MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'patch_apply']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'codebase_search', 'symbol_search', 'reference_search']);
const READ_TOOLS = new Set(['read_file', 'list_dir']);

const rules: AugmentationRule[] = [
  {
    id: 'verify-after-edit',
    cooldown: 4,
    trigger: (toolName, _args, result) =>
      FILE_MUTATION_TOOLS.has(toolName) && !result.isError,
    message: () =>
      '\n\n[Nudge] File changed. Run `lint_runner` and `test_runner` before moving on.',
  },

  {
    id: 'context-pressure',
    cooldown: 8,
    trigger: (_toolName, _args, _result, ctx) =>
      ctx.contextUsagePercent >= 75,
    message: (_toolName, _args, _result, ctx) =>
      `\n\n[Nudge] Context usage at ${ctx.contextUsagePercent}%. Consider \`/compact\` soon.`,
  },

  {
    id: 'search-broadening',
    cooldown: 6,
    trigger: (toolName, _args, _result, ctx) => {
      if (!SEARCH_TOOLS.has(toolName)) return false;
      const recentSearchCount = ctx.recentToolNames
        .slice(-5)
        .filter((name) => SEARCH_TOOLS.has(name)).length;
      return recentSearchCount >= 3;
    },
    message: () =>
      '\n\n[Nudge] Multiple sequential searches detected. Consider `task` to delegate parallel exploration.',
  },

  {
    id: 'skill-awareness',
    cooldown: 12,
    trigger: (toolName, _args, _result, ctx) =>
      toolName === 'task' && ctx.availableSkills.length > 0,
    message: (_toolName, _args, _result, ctx) => {
      const skills = ctx.availableSkills.slice(0, 5).join(', ');
      return `\n\n[Nudge] Available skills: ${skills}. Pass relevant skills via the task prompt for better results.`;
    },
  },

  {
    id: 'verify-pending',
    cooldown: 6,
    trigger: (toolName, _args, _result, ctx) =>
      READ_TOOLS.has(toolName) && ctx.pendingVerification,
    message: () =>
      '\n\n[Nudge] Unverified edits pending. Run `lint_runner` / `test_runner` before reading more files.',
  },
];

export class ResultAugmenter {
  private readonly cooldowns = new Map<string, number>();
  private callCount = 0;

  public augment(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    ctx: AugmentationContext,
  ): ToolResult {
    if (result.isError) return result;

    const nudges: string[] = [];

    for (const rule of rules) {
      const lastFired = this.cooldowns.get(rule.id) ?? -Infinity;
      if (this.callCount - lastFired < rule.cooldown) continue;

      if (rule.trigger(toolName, args, result, ctx)) {
        nudges.push(rule.message(toolName, args, result, ctx));
        this.cooldowns.set(rule.id, this.callCount);
      }
    }

    this.callCount += 1;

    if (nudges.length === 0) return result;

    return {
      ...result,
      output: result.output + nudges.join(''),
    };
  }

  public reset(): void {
    this.cooldowns.clear();
    this.callCount = 0;
  }
}
