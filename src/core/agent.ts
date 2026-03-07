import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';

export type AgentStatus = 'running' | 'stopped' | 'error';

export interface SpawnAgentOptions {
  id?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinMode?: 'pipe' | 'ignore';
  onOutput?: (event: AgentOutputEvent) => void;
}

export interface AgentOutputEvent {
  id: string;
  provider: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface AgentExitEvent {
  id: string;
  provider: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  status: AgentStatus;
  error?: string;
}

export interface AgentErrorEvent {
  id: string;
  provider: string;
  error: Error;
}

interface AgentRecord {
  id: string;
  provider: string;
  process: ChildProcess;
  status: AgentStatus;
  error?: string;
}

export interface AgentInfo {
  id: string;
  provider: string;
  status: AgentStatus;
  pid: number;
  error?: string;
}

export class AgentOrchestrator extends EventEmitter {
  private readonly agents = new Map<string, AgentRecord>();

  public spawn(provider: string, options: SpawnAgentOptions = {}): string {
    const trimmedProvider = provider.trim();
    if (!trimmedProvider) {
      throw new Error('Provider command must be a non-empty string.');
    }

    const agentId = options.id ?? randomUUID();
    if (this.agents.has(agentId)) {
      throw new Error(`Agent with id "${agentId}" already exists.`);
    }

    const stdinMode = options.stdinMode ?? 'pipe';
    const child = spawn(trimmedProvider, options.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [stdinMode, 'pipe', 'pipe'],
    });

    const record: AgentRecord = {
      id: agentId,
      provider: trimmedProvider,
      process: child,
      status: 'running',
    };

    this.agents.set(agentId, record);

    child.stdout?.on('data', (chunk: Buffer) => {
      const event: AgentOutputEvent = {
        id: agentId,
        provider: trimmedProvider,
        stream: 'stdout',
        text: chunk.toString(),
      };

      options.onOutput?.(event);
      this.emit('output', event);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const event: AgentOutputEvent = {
        id: agentId,
        provider: trimmedProvider,
        stream: 'stderr',
        text: chunk.toString(),
      };

      options.onOutput?.(event);
      this.emit('output', event);
    });

    child.on('error', (error) => {
      record.status = 'error';
      record.error = error.message;

      const event: AgentErrorEvent = {
        id: agentId,
        provider: trimmedProvider,
        error,
      };
      this.emit('error', event);
    });

    child.on('exit', (code, signal) => {
      if (record.status !== 'error') {
        const exitedBySignal = signal === 'SIGTERM' || signal === 'SIGKILL';
        record.status = code === 0 || exitedBySignal ? 'stopped' : 'error';
        if (record.status === 'error') {
          record.error = `Process exited with code ${String(code)}.`;
        }
      }

      const event: AgentExitEvent = {
        id: agentId,
        provider: trimmedProvider,
        code,
        signal,
        status: record.status,
        error: record.error,
      };

      this.emit('exit', event);
    });

    return agentId;
  }

  public send(agentId: string, input: string): void {
    const record = this.agents.get(agentId);
    if (!record) {
      throw new Error(`Unknown agent id "${agentId}".`);
    }

    if (record.status !== 'running') {
      throw new Error(`Agent "${agentId}" is not running.`);
    }

    const stdin = record.process.stdin;
    if (!stdin) {
      throw new Error(`Agent "${agentId}" stdin not available (spawned with stdinMode=ignore).`);
    }

    const payload = input.endsWith('\n') ? input : `${input}\n`;
    stdin.write(payload);
  }

  public kill(agentId: string): void {
    const record = this.agents.get(agentId);
    if (!record) {
      return;
    }

    const child = record.process;
    if (child.killed || child.exitCode !== null) {
      record.status = 'stopped';
      return;
    }

    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    }, 5000);
  }

  public getStatus(agentId: string): AgentStatus {
    const record = this.agents.get(agentId);
    return record?.status ?? 'stopped';
  }

  public listAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).map((record) => ({
      id: record.id,
      provider: record.provider,
      status: record.status,
      pid: record.process.pid ?? -1,
      error: record.error,
    }));
  }
}
