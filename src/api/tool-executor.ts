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

export const executeToolCalls = async (
  blocks: ToolUseBlock[],
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<ToolResultBlock[]> => {
  return Promise.all(
    blocks.map(async (block): Promise<ToolResultBlock> => {
      const tool = registry.get(block.name);
      if (!tool) {
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Unknown tool: ${block.name}`,
          is_error: true,
        };
      }

      try {
        const result = await tool.execute(block.input, ctx);
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.output,
          is_error: result.isError || undefined,
        };
      } catch (err: unknown) {
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: err instanceof Error ? err.message : String(err),
          is_error: true,
        };
      }
    }),
  );
};

export const formatToolsForApi = (
  registry: ToolRegistry,
): Array<{
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
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
