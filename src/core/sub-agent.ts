import { AnthropicClient, type ApiMessage } from '../api/anthropic-client.js';

export type AgentRole = 'coder' | 'reviewer' | 'researcher' | 'orchestrator' | 'oracle' | 'general';

export interface TaskSpec {
  id: string;
  prompt: string;
  role: AgentRole;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  context?: ApiMessage[];
}

export interface TaskResult {
  taskId: string;
  text: string;
  usage: { input: number; output: number };
  status: 'completed' | 'failed' | 'cancelled';
  error?: string;
  durationMs: number;
}

export interface PoolConfig {
  token: string;
  baseUrl: string;
  defaultModel: string;
  defaultSystemPrompt: string;
  maxConcurrent?: number;
}

export class SubAgentPool {
  private readonly config: PoolConfig;
  private readonly activeControllers = new Map<string, AbortController>();
  private runningCount = 0;

  public constructor(config: PoolConfig) {
    this.config = config;
  }

  public async runTask(
    task: TaskSpec,
    onText?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<TaskResult> {
    const startTime = Date.now();
    const taskAbort = new AbortController();
    this.activeControllers.set(task.id, taskAbort);
    this.runningCount++;

    const onExternalAbort = (): void => { taskAbort.abort(); };
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    const client = new AnthropicClient({
      token: this.config.token,
      baseUrl: this.config.baseUrl,
      model: task.model ?? this.config.defaultModel,
      maxTokens: task.maxTokens ?? 8192,
    });

    const systemPrompt = task.systemPrompt ?? this.config.defaultSystemPrompt;
    const messages: ApiMessage[] = [
      ...(task.context ?? []),
      { role: 'user', content: task.prompt },
    ];

    let fullText = '';
    let usage = { input: 0, output: 0 };

    try {
      await client.stream(
        systemPrompt,
        messages,
        {
          onText: (text: string) => {
            fullText += text;
            onText?.(text);
          },
          onError: () => {},
          onDone: (_text: string, u: { input: number; output: number }) => {
            usage = u;
          },
        },
        taskAbort.signal,
      );

      return {
        taskId: task.id,
        text: fullText,
        usage,
        status: 'completed',
        durationMs: Date.now() - startTime,
      };
    } catch (error: unknown) {
      return {
        taskId: task.id,
        text: fullText,
        usage,
        status: taskAbort.signal.aborted ? 'cancelled' : 'failed',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    } finally {
      this.activeControllers.delete(task.id);
      this.runningCount--;
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  public async runParallel(
    tasks: TaskSpec[],
    onTaskText?: (taskId: string, text: string) => void,
    signal?: AbortSignal,
  ): Promise<TaskResult[]> {
    const maxConcurrent = this.config.maxConcurrent ?? 5;

    if (tasks.length <= maxConcurrent) {
      return Promise.all(
        tasks.map((task) =>
          this.runTask(
            task,
            onTaskText ? (text) => onTaskText(task.id, text) : undefined,
            signal,
          ),
        ),
      );
    }

    const results: TaskResult[] = [];
    for (let i = 0; i < tasks.length; i += maxConcurrent) {
      if (signal?.aborted) {
        const remaining = tasks.slice(i).map((t) => ({
          taskId: t.id,
          text: '',
          usage: { input: 0, output: 0 },
          status: 'cancelled' as const,
          durationMs: 0,
        }));
        results.push(...remaining);
        break;
      }

      const batch = tasks.slice(i, i + maxConcurrent);
      const batchResults = await Promise.all(
        batch.map((task) =>
          this.runTask(
            task,
            onTaskText ? (text) => onTaskText(task.id, text) : undefined,
            signal,
          ),
        ),
      );
      results.push(...batchResults);
    }

    return results;
  }

  public async runSequential(
    tasks: TaskSpec[],
    onTaskText?: (taskId: string, text: string) => void,
    signal?: AbortSignal,
  ): Promise<TaskResult[]> {
    const results: TaskResult[] = [];

    for (const task of tasks) {
      if (signal?.aborted) {
        results.push({
          taskId: task.id,
          text: '',
          usage: { input: 0, output: 0 },
          status: 'cancelled',
          durationMs: 0,
        });
        continue;
      }

      const result = await this.runTask(
        task,
        onTaskText ? (text) => onTaskText(task.id, text) : undefined,
        signal,
      );
      results.push(result);

      if (result.status === 'failed') break;
    }

    return results;
  }

  public abortTask(taskId: string): void {
    this.activeControllers.get(taskId)?.abort();
  }

  public abortAll(): void {
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
  }

  public getRunningCount(): number {
    return this.runningCount;
  }

  public getActiveTasks(): string[] {
    return Array.from(this.activeControllers.keys());
  }
}
