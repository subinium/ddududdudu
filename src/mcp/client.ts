import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClient {
  connect(): Promise<void>;
  disconnect(): void;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  isConnected(): boolean;
  getServerName(): string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface InitializeResult {
  serverInfo?: {
    name?: string;
  };
}

interface ToolListResult {
  tools?: Array<{
    name?: string;
    description?: string;
    inputSchema?: unknown;
  }>;
}

const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_DELAY_MS = 1_000;
const MAX_STDOUT_BUFFER_SIZE = 10 * 1024 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const toError = (error: unknown, fallbackMessage: string): Error => {
  if (error instanceof Error) {
    return error;
  }

  return new Error(fallbackMessage);
};

const extractToolResultText = (result: unknown): string => {
  if (typeof result === 'string') {
    return result;
  }

  if (!isObject(result)) {
    return JSON.stringify(result);
  }

  const content = result.content;
  if (Array.isArray(content)) {
    const texts = content
      .map((item: unknown): string => {
        if (!isObject(item)) {
          return '';
        }

        if (typeof item.text === 'string') {
          return item.text;
        }

        return '';
      })
      .filter((value: string) => value.length > 0);

    if (texts.length > 0) {
      return texts.join('\n');
    }
  }

  if (typeof result.result === 'string') {
    return result.result;
  }

  return JSON.stringify(result, null, 2);
};

export class StdioMcpClient implements McpClient {
  private readonly name: string;
  private readonly config: McpServerConfig;
  private process: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private connected = false;
  private shouldReconnect = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<void> | null = null;
  private stdoutBuffer = '';
  private serverName: string;

  private readonly pending = new Map<number, PendingRequest>();

  public constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.serverName = name;
    this.config = {
      ...config,
      args: config.args ?? [],
      env: config.env ?? {},
    };
  }

  public async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.startConnection();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.connected = false;
    this.rejectAllPending(new Error(`MCP server ${this.name} disconnected.`));
    this.process?.kill();
    this.process = null;
  }

  public async listTools(): Promise<McpTool[]> {
    await this.ensureConnected();
    const result = await this.sendRequest('tools/list', {});
    const payload = result as ToolListResult;
    const tools = Array.isArray(payload.tools) ? payload.tools : [];

    return tools
      .map((tool): McpTool | null => {
        const toolName = typeof tool.name === 'string' ? tool.name : '';
        if (toolName.length === 0) {
          return null;
        }

        return {
          name: toolName,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: isObject(tool.inputSchema) ? tool.inputSchema : {},
        };
      })
      .filter((tool): tool is McpTool => tool !== null);
  }

  public async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureConnected();
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    });

    return extractToolResultText(result);
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getServerName(): string {
    return this.serverName;
  }

  private async startConnection(): Promise<void> {
    this.shouldReconnect = true;

    const child = spawn(this.config.command, this.config.args ?? [], {
      env: {
        ...process.env,
        ...(this.config.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process = child;
    this.stdoutBuffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      console.error(`[mcp:${this.name}] ${chunk.trimEnd()}`);
    });

    child.once('error', (err: unknown) => {
      const error = toError(err, `Failed to start MCP server ${this.name}.`);
      this.connected = false;
      this.rejectAllPending(error);
    });

    child.once('exit', () => {
      this.connected = false;
      this.process = null;
      this.rejectAllPending(new Error(`MCP server ${this.name} exited.`));

      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });

    try {
      const initializeResult = await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'ddudu',
          version: '0.6.0',
        },
      });

      const parsed = initializeResult as InitializeResult;
      const discoveredName = parsed.serverInfo?.name;
      if (typeof discoveredName === 'string' && discoveredName.trim().length > 0) {
        this.serverName = discoveredName.trim();
      }

      this.connected = true;
      this.sendNotification('notifications/initialized', {});
    } catch (err: unknown) {
      this.process?.kill();
      this.process = null;
      throw toError(err, `Failed to initialize MCP server ${this.name}.`);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.shouldReconnect) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((_err: unknown) => {
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    }, RECONNECT_DELAY_MS);
  }

  private ensureConnected = async (): Promise<void> => {
    if (!this.connected) {
      await this.connect();
    }
  };

  private sendNotification(method: string, params?: unknown): void {
    const payload: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.writeMessage(payload);
  }

  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.process?.stdin || !this.connected) {
      throw new Error(`MCP server ${this.name} is not connected.`);
    }

    const id = ++this.requestId;

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out for ${this.name}:${method}.`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timeout,
      });

      try {
        this.writeMessage(request);
      } catch (err: unknown) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(toError(err, `Failed to send MCP request ${method}.`));
      }
    });
  }

  private writeMessage(message: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.process?.stdin) {
      throw new Error(`MCP server ${this.name} is not connected.`);
    }

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;

    if (this.stdoutBuffer.length > MAX_STDOUT_BUFFER_SIZE) {
      this.stdoutBuffer = '';
      this.rejectAllPending(new Error(`MCP server ${this.name} stdout buffer overflow.`));
      return;
    }

    let boundary = this.stdoutBuffer.indexOf('\n');
    while (boundary !== -1) {
      const line = this.stdoutBuffer.slice(0, boundary).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(boundary + 1);

      if (line.length > 0) {
        this.handleMessageLine(line);
      }

      boundary = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleMessageLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return;
    }

    if (!isObject(parsed)) {
      return;
    }

    const response = parsed as JsonRpcResponse;
    if (typeof response.id !== 'number') {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);

    if (response.error) {
      const detail = response.error.message ?? `JSON-RPC request failed: ${pending.method}`;
      pending.reject(new Error(detail));
      return;
    }

    pending.resolve(response.result);
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }

    this.pending.clear();
  }
}

const parseNamespacedTool = (value: string): { server: string; tool: string } => {
  if (!value.startsWith('mcp__')) {
    throw new Error(`Invalid MCP tool name: ${value}`);
  }

  const rest = value.slice('mcp__'.length);
  const splitIndex = rest.indexOf('__');
  if (splitIndex <= 0 || splitIndex >= rest.length - 2) {
    throw new Error(`Invalid MCP tool name: ${value}`);
  }

  const server = rest.slice(0, splitIndex);
  const tool = rest.slice(splitIndex + 2);

  return {
    server,
    tool,
  };
};

export class McpManager {
  private readonly clients = new Map<string, StdioMcpClient>();
  private readonly toolsByServer = new Map<string, McpTool[]>();

  public constructor() {}

  public addServer(name: string, config: McpServerConfig): void {
    this.clients.set(name, new StdioMcpClient(name, config));
  }

  public async connectAll(): Promise<void> {
    await Promise.all(
      Array.from(this.clients.entries()).map(async ([serverName, client]) => {
        await client.connect();
        const tools = await client.listTools();
        this.toolsByServer.set(serverName, tools);
      }),
    );
  }

  public disconnectAll(): void {
    for (const client of this.clients.values()) {
      client.disconnect();
    }

    this.toolsByServer.clear();
  }

  public getAllTools(): McpTool[] {
    const namespaced: McpTool[] = [];

    for (const [serverName, tools] of this.toolsByServer.entries()) {
      for (const tool of tools) {
        namespaced.push({
          ...tool,
          name: `mcp__${serverName}__${tool.name}`,
        });
      }
    }

    return namespaced;
  }

  public async callTool(namespacedName: string, args: Record<string, unknown>): Promise<string> {
    const { server, tool } = parseNamespacedTool(namespacedName);
    const client = this.clients.get(server);
    if (!client) {
      throw new Error(`Unknown MCP server: ${server}`);
    }

    if (!client.isConnected()) {
      await client.connect();
      const tools = await client.listTools();
      this.toolsByServer.set(server, tools);
    }

    return client.callTool(tool, args);
  }

  public getConnectedServers(): string[] {
    return Array.from(this.clients.entries())
      .filter(([, client]) => client.isConnected())
      .map(([name]) => name);
  }
}
