import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AgentOutputEvent, AgentExitEvent, AgentErrorEvent, AgentStatus } from './agent.js';

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ApiStreamCallbacks {
  onText: (text: string) => void;
  onError: (error: Error) => void;
  onDone: (fullText: string, usage: { input: number; output: number }) => void;
}

interface ApiAgentRecord {
  id: string;
  model: string;
  status: AgentStatus;
  abortController: AbortController;
  history: ApiMessage[];
  error?: string;
}

export interface ApiAgentConfig {
  token: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  systemPrompt: string;
  isOpenRouter?: boolean;
}

interface SSEDelta {
  type?: string;
  text?: string;
}

interface SSEUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface SSEData {
  delta?: SSEDelta;
  message?: { usage?: SSEUsage };
  usage?: SSEUsage;
  error?: { message?: string };
}

export class ApiAgentOrchestrator extends EventEmitter {
  private readonly agents = new Map<string, ApiAgentRecord>();

  public async streamRequest(
    config: ApiAgentConfig,
    prompt: string,
    options: { id?: string } = {},
  ): Promise<string> {
    const agentId = options.id ?? randomUUID();
    const abortController = new AbortController();

    const record: ApiAgentRecord = {
      id: agentId,
      model: config.model,
      status: 'running',
      abortController,
      history: [],
    };

    this.agents.set(agentId, record);

    record.history.push({ role: 'user', content: prompt });

    const body = {
      model: config.model,
      max_tokens: config.maxTokens ?? 8192,
      system: config.systemPrompt,
      messages: record.history,
      stream: true,
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    if (config.isOpenRouter) {
      headers['authorization'] = `Bearer ${config.token}`;
    } else {
      headers['x-api-key'] = config.token;
    }

    try {
      const response = await fetch(`${config.baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`API ${response.status}: ${errorText}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      const fullText = await this.parseSSEStream(
        response.body,
        agentId,
        config.model,
      );

      record.history.push({ role: 'assistant', content: fullText });
      record.status = 'stopped';

      const exitEvent: AgentExitEvent = {
        id: agentId,
        provider: config.model,
        code: 0,
        signal: null,
        status: 'stopped',
      };
      this.emit('exit', exitEvent);

      return agentId;
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        record.status = 'stopped';
        const exitEvent: AgentExitEvent = {
          id: agentId,
          provider: config.model,
          code: null,
          signal: 'SIGTERM' as NodeJS.Signals,
          status: 'stopped',
        };
        this.emit('exit', exitEvent);
        return agentId;
      }

      record.status = 'error';
      const err = error instanceof Error ? error : new Error(String(error));
      record.error = err.message;

      const errorEvent: AgentErrorEvent = {
        id: agentId,
        provider: config.model,
        error: err,
      };
      this.emit('error', errorEvent);

      const exitEvent: AgentExitEvent = {
        id: agentId,
        provider: config.model,
        code: 1,
        signal: null,
        status: 'error',
        error: err.message,
      };
      this.emit('exit', exitEvent);

      return agentId;
    }
  }

  public abort(agentId: string): void {
    const record = this.agents.get(agentId);
    if (!record || record.status !== 'running') return;
    record.abortController.abort();
  }

  public getHistory(agentId: string): ApiMessage[] {
    return [...(this.agents.get(agentId)?.history ?? [])];
  }

  public getStatus(agentId: string): AgentStatus {
    return this.agents.get(agentId)?.status ?? 'stopped';
  }

  private async parseSSEStream(
    body: ReadableStream<Uint8Array>,
    agentId: string,
    provider: string,
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const eventBlock of events) {
          const parsed = this.parseSSEEvent(eventBlock);
          if (!parsed) continue;

          const { event, data } = parsed;

          if (event === 'content_block_delta' && data.delta?.type === 'text_delta') {
            const text = data.delta.text as string;
            fullText += text;

            const outputEvent: AgentOutputEvent = {
              id: agentId,
              provider,
              stream: 'stdout',
              text,
            };
            this.emit('output', outputEvent);
          }

          if (event === 'message_start' && data.message?.usage) {
            inputTokens = (data.message.usage.input_tokens as number) ?? 0;
          }

          if (event === 'message_delta' && data.usage) {
            outputTokens = (data.usage.output_tokens as number) ?? 0;
          }

          if (event === 'error') {
            const errMsg = (data.error?.message as string) ?? 'Stream error';
            throw new Error(errMsg);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return fullText;
  }

  private parseSSEEvent(block: string): { event: string; data: SSEData } | null {
    let event = '';
    let dataStr = '';

    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        event = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataStr += line.slice(6);
      }
    }

    if (!event || !dataStr) return null;

    try {
      const data = JSON.parse(dataStr) as SSEData;
      return { event, data };
    } catch {
      return null;
    }
  }
}
