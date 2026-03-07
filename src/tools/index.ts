export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
}

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  onProgress?: (text: string) => void;
  askUser?: (question: string, options?: string[]) => Promise<string>;
  authToken?: string;
  authBaseUrl?: string;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export * from './registry.js';
export * from './file-tools.js';
export * from './bash-tool.js';
export * from './search-tools.js';
export * from './web-tool.js';
export * from './task-tool.js';
export * from './oracle-tool.js';
export * from './toolbox.js';
export * from './ask-question-tool.js';
