import type { HookRegistry } from '../core/hooks.js';
import type { AugmentationContext, ResultAugmenter } from '../core/result-augmentation.js';
import type { ToolContext } from '../tools/index.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ToolExecutionOptions {
  augmenter?: ResultAugmenter;
  augmentationContext?: AugmentationContext;
  hooks?: HookRegistry;
}

const MAX_CONCURRENT_TOOLS = 10;

export const executeToolCalls = async (
  blocks: ToolUseBlock[],
  registry: ToolRegistry,
  ctx: ToolContext,
  options?: ToolExecutionOptions,
): Promise<ToolResultBlock[]> => {
  if (blocks.length <= MAX_CONCURRENT_TOOLS) {
    return Promise.all(blocks.map((block) => executeSingleTool(block, registry, ctx, options)));
  }

  const results: ToolResultBlock[] = [];
  for (let i = 0; i < blocks.length; i += MAX_CONCURRENT_TOOLS) {
    const batch = blocks.slice(i, i + MAX_CONCURRENT_TOOLS);
    const batchResults = await Promise.all(batch.map((block) => executeSingleTool(block, registry, ctx, options)));
    results.push(...batchResults);
  }
  return results;
};

const executeSingleTool = async (
  block: ToolUseBlock,
  registry: ToolRegistry,
  ctx: ToolContext,
  options?: ToolExecutionOptions,
): Promise<ToolResultBlock> => {
  const tool = registry.get(block.name);
  if (!tool) {
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: `Unknown tool: ${block.name}`,
      is_error: true,
    };
  }

  if (options?.hooks) {
    await options.hooks.emit('beforeToolCall', { name: block.name, input: block.input });
  }

  try {
    let result = await tool.execute(block.input, ctx);

    if (options?.augmenter && options.augmentationContext) {
      result = options.augmenter.augment(block.name, block.input, result, options.augmentationContext);
    }

    if (options?.hooks) {
      await options.hooks.emit('afterToolCall', {
        name: block.name,
        input: block.input,
        output: result.output,
        isError: result.isError ?? false,
      });
    }

    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: result.output,
      is_error: result.isError || undefined,
    };
  } catch (err: unknown) {
    if (options?.hooks) {
      await options.hooks.emit('afterToolCall', {
        name: block.name,
        input: block.input,
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      });
    }

    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: err instanceof Error ? err.message : String(err),
      is_error: true,
    };
  }
};

export const formatToolsForApi = (
  registry: ToolRegistry,
): Array<{
  name: string;
  description?: string;
  input_schema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}> => {
  return registry.toAnthropicFormat().map((item) => ({
    name: item.name,
    description: item.description,
    input_schema: {
      type: item.input_schema.type,
      properties: item.input_schema.properties,
      required: item.input_schema.required,
      additionalProperties: item.input_schema.additionalProperties,
    },
  }));
};
