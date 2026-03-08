import { askQuestionTool } from './ask-question-tool.js';
import { bashTool } from './bash-tool.js';
import {
  changedFilesTool,
  codebaseSearchTool,
  definitionSearchTool,
  referenceSearchTool,
  referenceHotspotsTool,
  repoMapTool,
  symbolSearchTool,
} from './context-tools.js';
import { editFileTool, listDirTool, readFileTool, writeFileTool } from './file-tools.js';
import type { Tool, ToolDefinition, ToolParameter } from './index.js';
import { memoryTool } from './memory-tool.js';
import { oracleTool } from './oracle-tool.js';
import { globTool, grepTool } from './search-tools.js';
import { taskTool } from './task-tool.js';
import { updatePlanTool } from './update-plan-tool.js';
import { webFetchTool } from './web-tool.js';

interface JsonSchema {
  type: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
}

const parameterToSchema = (parameter: ToolParameter): JsonSchema => {
  const schema: JsonSchema = {
    type: parameter.type,
    description: parameter.description,
  };

  if (parameter.enum) {
    schema.enum = [...parameter.enum];
  }

  if (parameter.items) {
    schema.items = parameterToSchema(parameter.items);
  }

  if (parameter.properties) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [name, child] of Object.entries(parameter.properties)) {
      properties[name] = parameterToSchema(child);
      if (child.required) {
        required.push(name);
      }
    }

    schema.properties = properties;
    if (required.length > 0) {
      schema.required = required;
    }
    schema.additionalProperties = false;
  }

  return schema;
};

const definitionToInputSchema = (
  definition: ToolDefinition,
): {
  type: 'object';
  properties: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties: false;
} => {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [name, parameter] of Object.entries(definition.parameters)) {
    properties[name] = parameterToSchema(parameter);
    if (parameter.required) {
      required.push(name);
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false,
  };
};

const BUILTIN_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  bashTool,
  grepTool,
  globTool,
  repoMapTool,
  symbolSearchTool,
  definitionSearchTool,
  referenceSearchTool,
  referenceHotspotsTool,
  changedFilesTool,
  codebaseSearchTool,
  webFetchTool,
  taskTool,
  oracleTool,
  askQuestionTool,
  memoryTool,
  updatePlanTool,
];

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  public constructor() {
    for (const tool of BUILTIN_TOOLS) {
      this.register(tool);
    }
  }

  public register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  public get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => tool.definition);
  }

  public toAnthropicFormat(): Array<{
    name: string;
    description: string;
    input_schema: {
      type: 'object';
      properties: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties: false;
    };
  }> {
    return this.list().map((definition) => ({
      name: definition.name,
      description: definition.description,
      input_schema: definitionToInputSchema(definition),
    }));
  }
}

export const createDefaultRegistry = (): ToolRegistry => {
  return new ToolRegistry();
};
