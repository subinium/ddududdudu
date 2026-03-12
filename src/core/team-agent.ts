import type { SpecialistRole } from './specialist-roles.js';
import type { NamedMode } from './types.js';
import type { WorkflowArtifactKind } from './workflow-state.js';

export interface AgentRole {
  id: string;
  name: string;
  role: 'lead' | 'worker' | 'reviewer';
  mode?: NamedMode;
  roleProfile?: SpecialistRole;
  model: string;
  provider: string;
  systemPrompt: string;
  tools?: string[];
  taskLabel?: string;
  taskBrief?: string;
  deliverable?: WorkflowArtifactKind;
  successCriteria?: string[];
  readOnly?: boolean;
  dependencyLabels?: string[];
  dependencyUnitIds?: string[];
  handoffTo?: string;
  workUnitId?: string;
}

export interface TeamMessage {
  from: string;
  to: string;
  type: 'task' | 'result' | 'review' | 'feedback' | 'status';
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface TeamConfig {
  name: string;
  agents: AgentRole[];
  strategy: 'parallel' | 'sequential' | 'delegate';
  maxRounds: number;
  sharedContext?: string;
  runAgent?: (agent: AgentRole, input: string, round: number) => Promise<string>;
  onMessage?: (message: TeamMessage) => void;
}

export interface TeamResult {
  success: boolean;
  output: string;
  messages: TeamMessage[];
  rounds: number;
  agentOutputs: Map<string, string>;
}

type AgentState = 'idle' | 'working' | 'done';

const DEFAULT_MAX_ROUNDS = 5;
const LEAD_COORDINATION_SUFFIX = [
  'You are the lead coordinator for a multi-agent team.',
  'Assign concrete subtasks, synthesize worker results, and provide clear next steps.',
  'When reviewers are present, include quality notes and a final decision.',
].join(' ');

export class TeamOrchestrator {
  private readonly config: TeamConfig;
  private readonly agentsById: Map<string, AgentRole>;
  private readonly workerIds: string[];
  private readonly reviewerIds: string[];
  private readonly leadId: string;
  private readonly workUnitToAgentId: Map<string, string>;

  private readonly messageQueues = new Map<string, TeamMessage[]>();
  private readonly messages: TeamMessage[] = [];
  private readonly agentStates = new Map<string, AgentState>();
  private readonly agentOutputs = new Map<string, string>();

  private running = false;
  private currentRound = 0;
  private activeTask = '';
  private activeSignal?: AbortSignal;

  public constructor(config: TeamConfig) {
    if (config.agents.length === 0) {
      throw new Error('TeamOrchestrator requires at least one agent.');
    }

    const normalizedMaxRounds = config.maxRounds > 0 ? config.maxRounds : DEFAULT_MAX_ROUNDS;
    const normalizedAgents = this.normalizeAgents(config.agents);

    this.config = {
      ...config,
      maxRounds: normalizedMaxRounds,
      agents: normalizedAgents,
    };

    this.agentsById = new Map<string, AgentRole>();
    for (const agent of this.config.agents) {
      if (this.agentsById.has(agent.id)) {
        throw new Error(`Duplicate agent id: ${agent.id}`);
      }
      this.agentsById.set(agent.id, agent);
    }

    const leadAgents = this.config.agents.filter((agent) => agent.role === 'lead');
    if (leadAgents.length !== 1) {
      throw new Error('TeamOrchestrator requires exactly one lead agent.');
    }

    this.leadId = leadAgents[0].id;
    this.workerIds = this.config.agents.filter((agent) => agent.role === 'worker').map((agent) => agent.id);
    this.reviewerIds = this.config.agents.filter((agent) => agent.role === 'reviewer').map((agent) => agent.id);
    this.workUnitToAgentId = new Map(
      this.config.agents
        .filter((agent) => typeof agent.workUnitId === 'string' && agent.workUnitId.length > 0)
        .map((agent) => [agent.workUnitId as string, agent.id]),
    );

    for (const agent of this.config.agents) {
      this.messageQueues.set(agent.id, []);
      this.agentStates.set(agent.id, 'idle');
    }
  }

  public async run(task: string, signal?: AbortSignal): Promise<TeamResult> {
    if (this.running) {
      throw new Error('TeamOrchestrator is already running.');
    }

    this.resetRunState(task);
    this.running = true;
    this.activeSignal = signal;

    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      while (!aborted && this.currentRound < this.config.maxRounds && !this.isRunComplete()) {
        this.currentRound += 1;
        await this.executeRound(this.currentRound);
      }

      if (aborted || signal?.aborted === true) {
        this.routeMessage({
          from: this.leadId,
          to: 'broadcast',
          type: 'status',
          content: 'Run cancelled by abort signal.',
          metadata: { round: this.currentRound },
          timestamp: Date.now(),
        });
      }

      const success = !aborted && signal?.aborted !== true && this.isRunComplete();
      return {
        success,
        output: this.buildFinalOutput(success),
        messages: [...this.messages],
        rounds: this.currentRound,
        agentOutputs: new Map(this.agentOutputs),
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.activeSignal = undefined;
      this.running = false;
    }
  }

  public getStatus(): { running: boolean; round: number; agents: Map<string, AgentState> } {
    return {
      running: this.running,
      round: this.currentRound,
      agents: new Map(this.agentStates),
    };
  }

  private routeMessage(msg: TeamMessage): void {
    this.messages.push(msg);
    this.config.onMessage?.(msg);

    if (msg.to === 'broadcast') {
      for (const queue of this.messageQueues.values()) {
        queue.push(msg);
      }
      return;
    }

    const queue = this.messageQueues.get(msg.to);
    if (queue !== undefined) {
      queue.push(msg);
    }
  }

  private async executeRound(round: number): Promise<void> {
    this.ensureNotAborted();

    this.routeMessage({
      from: this.leadId,
      to: 'broadcast',
      type: 'status',
      content: `Round ${round} started using ${this.config.strategy} strategy.`,
      metadata: { strategy: this.config.strategy },
      timestamp: Date.now(),
    });

    if (this.config.strategy === 'parallel') {
      await this.executeParallelRound(round);
      return;
    }

    if (this.config.strategy === 'sequential') {
      await this.executeSequentialRound(round);
      return;
    }

    await this.executeDelegateRound(round);
  }

  private async executeParallelRound(round: number): Promise<void> {
    const pending = new Set(this.workerIds);
    const completed = new Set<string>();
    const inFlight = new Map<string, Promise<{ workerId: string }>>();

    const scheduleReadyWorkers = (): void => {
      if (pending.size === 0) {
        return;
      }

      const ready = this.selectReadyWorkers(pending, completed).filter((workerId) => !inFlight.has(workerId));

      for (const workerId of ready) {
        const dependencyContext = this.collectDependencyOutputs(workerId, completed);
        const taskText = this.buildWorkerSubtask(workerId, round, dependencyContext);
        this.routeMessage({
          from: this.leadId,
          to: workerId,
          type: 'task',
          content: taskText,
          metadata: {
            strategy: 'parallel',
            round,
            dependencyCount: this.getWorkerDependencies(workerId).length,
            readyCount: ready.length,
          },
          timestamp: Date.now(),
        });
        inFlight.set(
          workerId,
          this.runWorkerFromQueue(workerId, round, dependencyContext).then(() => ({ workerId })),
        );
      }
    };

    while (pending.size > 0 || inFlight.size > 0) {
      scheduleReadyWorkers();
      if (inFlight.size === 0 && pending.size === 0) {
        break;
      }
      if (inFlight.size === 0) {
        this.ensureReadyWorkers(this.selectReadyWorkers(pending, completed), pending, completed);
        continue;
      }

      const finished = await Promise.race(inFlight.values());
      inFlight.delete(finished.workerId);
      pending.delete(finished.workerId);
      completed.add(finished.workerId);
    }

    await this.synthesizeLeadOutput(round);
    await this.runReviewers(round);
  }

  private async executeSequentialRound(round: number): Promise<void> {
    const pending = new Set(this.workerIds);
    const completed = new Set<string>();
    let accumulated = '';

    while (pending.size > 0) {
      const ready = this.selectReadyWorkers(pending, completed);
      const workerId = this.ensureReadyWorkers(ready, pending, completed)[0]!;
      const dependencyContext = this.collectDependencyOutputs(workerId, completed);
      const taskText = this.buildWorkerSubtask(
        workerId,
        round,
        [accumulated, dependencyContext].filter((part) => part.length > 0).join('\n\n') || undefined,
      );
      this.routeMessage({
        from: this.leadId,
        to: workerId,
        type: 'task',
        content: taskText,
        metadata: {
          strategy: 'sequential',
          round,
          dependsOnPrior: Boolean(accumulated),
          dependencyCount: this.getWorkerDependencies(workerId).length,
        },
        timestamp: Date.now(),
      });

      const workerOutput = await this.runWorkerFromQueue(
        workerId,
        round,
        [accumulated, dependencyContext].filter((part) => part.length > 0).join('\n\n') || undefined,
      );
      accumulated = accumulated ? `${accumulated}\n${workerOutput}` : workerOutput;
      pending.delete(workerId);
      completed.add(workerId);
    }

    await this.synthesizeLeadOutput(round);
    await this.runReviewers(round);
  }

  private async executeDelegateRound(round: number): Promise<void> {
    this.routeMessage({
      from: this.leadId,
      to: 'broadcast',
      type: 'feedback',
      content: 'Lead delegated subtasks and is awaiting worker updates.',
      metadata: { strategy: 'delegate', round },
      timestamp: Date.now(),
    });

    const workerOutputs: string[] = [];
    const pending = new Set(this.workerIds);
    const completed = new Set<string>();

    while (pending.size > 0) {
      const ready = this.selectReadyWorkers(pending, completed);
      const workerId = this.ensureReadyWorkers(ready, pending, completed)[0]!;
      const dependencyContext = this.collectDependencyOutputs(workerId, completed);
      const subtask = this.buildWorkerSubtask(workerId, round, dependencyContext);
      this.routeMessage({
        from: this.leadId,
        to: workerId,
        type: 'task',
        content: subtask,
        metadata: {
          strategy: 'delegate',
          delegatedBy: this.leadId,
          round,
          dependencyCount: this.getWorkerDependencies(workerId).length,
        },
        timestamp: Date.now(),
      });

      const output = await this.runWorkerFromQueue(workerId, round, dependencyContext);
      workerOutputs.push(output);
      pending.delete(workerId);
      completed.add(workerId);
      this.routeMessage({
        from: this.leadId,
        to: workerId,
        type: 'feedback',
        content: `Received update from ${workerId}. Stand by for next instructions.`,
        metadata: { round },
        timestamp: Date.now(),
      });
    }

    await this.synthesizeLeadOutput(round, workerOutputs.join('\n'));
    await this.runReviewers(round);
  }

  private getWorkerDependencies(workerId: string): string[] {
    const agent = this.agentsById.get(workerId);
    if (!agent) {
      return [];
    }

    return (agent.dependencyUnitIds ?? [])
      .map((workUnitId) => this.workUnitToAgentId.get(workUnitId))
      .filter((dependencyId): dependencyId is string => typeof dependencyId === 'string');
  }

  private selectReadyWorkers(pending: Set<string>, completed: Set<string>): string[] {
    return this.workerIds.filter((workerId) => {
      if (!pending.has(workerId)) {
        return false;
      }

      const dependencies = this.getWorkerDependencies(workerId);
      return dependencies.every((dependencyId) => completed.has(dependencyId));
    });
  }

  private nextPendingWorker(pending: Set<string>): string {
    const workerId = this.workerIds.find((candidate) => pending.has(candidate));
    if (!workerId) {
      throw new Error('No pending worker available.');
    }
    return workerId;
  }

  private ensureReadyWorkers(ready: string[], pending: Set<string>, completed: Set<string>): string[] {
    if (ready.length > 0) {
      return ready;
    }

    const unresolved = Array.from(pending).map((workerId) => {
      const agent = this.agentsById.get(workerId);
      const dependencies = this.getWorkerDependencies(workerId)
        .filter((dependencyId) => !completed.has(dependencyId))
        .map((dependencyId) => this.agentsById.get(dependencyId)?.name ?? dependencyId);

      return {
        label: agent?.name ?? workerId,
        dependencies,
      };
    });

    const detail = unresolved
      .map(({ label, dependencies }) =>
        dependencies.length > 0
          ? `${label} waiting on ${dependencies.join(', ')}`
          : `${label} has unresolved dependencies`,
      )
      .join('; ');

    this.routeMessage({
      from: this.leadId,
      to: 'broadcast',
      type: 'status',
      content: `Team run blocked by unresolved dependencies: ${detail}`,
      metadata: {
        unresolved,
      },
      timestamp: Date.now(),
    });

    throw new Error(`Team run blocked by unresolved dependencies: ${detail}`);
  }

  private collectDependencyOutputs(workerId: string, completed: Set<string>): string | undefined {
    const dependencyOutputs = this.getWorkerDependencies(workerId)
      .filter((dependencyId) => completed.has(dependencyId))
      .map((dependencyId) => {
        const agent = this.agentsById.get(dependencyId);
        const output = this.agentOutputs.get(dependencyId);
        if (!agent || !output) {
          return null;
        }
        return `${agent.name}:\n${output}`;
      })
      .filter((fragment): fragment is string => typeof fragment === 'string' && fragment.length > 0);

    if (dependencyOutputs.length === 0) {
      return undefined;
    }

    return `Dependency outputs:\n${dependencyOutputs.join('\n\n')}`;
  }

  private async runWorkerFromQueue(workerId: string, round: number, priorOutput?: string): Promise<string> {
    this.ensureNotAborted();
    this.agentStates.set(workerId, 'working');

    const queue = this.messageQueues.get(workerId);
    const taskIndex = queue?.findIndex((message) => message.type === 'task') ?? -1;
    const assignedTask = queue && taskIndex >= 0 ? queue.splice(taskIndex, 1)[0] : undefined;
    const taskContent = assignedTask?.content ?? this.buildWorkerSubtask(workerId, round, priorOutput);

    const workerOutput = await this.simulateAgentOutput(workerId, taskContent, round);
    this.agentOutputs.set(workerId, workerOutput);
    this.agentStates.set(workerId, 'done');

    this.routeMessage({
      from: workerId,
      to: this.leadId,
      type: 'result',
      content: workerOutput,
      metadata: { round, basedOnTask: taskContent },
      timestamp: Date.now(),
    });

    return workerOutput;
  }

  private async synthesizeLeadOutput(round: number, delegateNotes?: string): Promise<void> {
    this.ensureNotAborted();
    this.agentStates.set(this.leadId, 'working');

    const workerOutputs = this.workerIds
      .map((workerId) => this.agentOutputs.get(workerId))
      .filter((output): output is string => output !== undefined && output.length > 0);

    const synthesisInput = [
      `Task: ${this.activeTask}`,
      this.config.sharedContext ? `Shared context: ${this.config.sharedContext}` : '',
      delegateNotes ? `Delegate notes: ${delegateNotes}` : '',
      workerOutputs.length > 0 ? `Worker outputs:\n${workerOutputs.join('\n')}` : 'Worker outputs: none',
      `Assignments:\n${this.workerIds
        .map((workerId) => {
          const agent = this.agentsById.get(workerId);
          return agent ? `- ${agent.name}: ${agent.taskLabel ?? agent.role}` : null;
        })
        .filter((item): item is string => Boolean(item))
        .join('\n')}`,
    ]
      .filter((part) => part.length > 0)
      .join('\n\n');

    const leadOutput = await this.simulateAgentOutput(this.leadId, synthesisInput, round);
    this.agentOutputs.set(this.leadId, leadOutput);
    this.agentStates.set(this.leadId, 'done');

    this.routeMessage({
      from: this.leadId,
      to: 'broadcast',
      type: 'result',
      content: leadOutput,
      metadata: { round, source: 'lead-synthesis' },
      timestamp: Date.now(),
    });
  }

  private async runReviewers(round: number): Promise<void> {
    if (this.reviewerIds.length === 0) {
      return;
    }

    const allOutputs = this.collectAllOutputs();
    const reviewTasks = this.reviewerIds.map(async (reviewerId) => {
      this.ensureNotAborted();
      this.agentStates.set(reviewerId, 'working');

      this.routeMessage({
        from: this.leadId,
        to: reviewerId,
        type: 'review',
        content: allOutputs,
        metadata: { round, requestedBy: this.leadId },
        timestamp: Date.now(),
      });

      const reviewOutput = await this.simulateAgentOutput(reviewerId, allOutputs, round);
      this.agentOutputs.set(reviewerId, reviewOutput);
      this.agentStates.set(reviewerId, 'done');

      this.routeMessage({
        from: reviewerId,
        to: this.leadId,
        type: 'review',
        content: reviewOutput,
        metadata: { round },
        timestamp: Date.now(),
      });
    });

    await Promise.all(reviewTasks);
  }

  private async simulateAgentOutput(agentId: string, input: string, round: number): Promise<string> {
    this.ensureNotAborted();

    const agent = this.agentsById.get(agentId);
    if (agent === undefined) {
      throw new Error(`Unknown agent id: ${agentId}`);
    }

    if (this.config.runAgent) {
      return this.config.runAgent(agent, input, round);
    }

    const roleLabel = agent.role.toUpperCase();
    return [
      `[${roleLabel}] ${agent.name} (${agent.provider}/${agent.model})`,
      `Round: ${round}`,
      `Prompt seed: ${agent.systemPrompt}`,
      `Planned response for task fragment:`,
      input,
    ].join('\n');
  }

  private buildWorkerSubtask(workerId: string, round: number, priorOutput?: string): string {
    const agent = this.agentsById.get(workerId);
    const sharedContext = this.config.sharedContext ? `Shared context: ${this.config.sharedContext}` : '';
    const prior = priorOutput ? `Prior output:\n${priorOutput}` : '';
    const label = agent?.taskLabel ? `Focused task: ${agent.taskLabel}` : `Focused subtask for round ${round}`;
    const brief = agent?.taskBrief ? `Brief: ${agent.taskBrief}` : '';
    const deliverable = agent?.deliverable ? `Deliverable: ${agent.deliverable}` : '';
    const criteria =
      agent?.successCriteria && agent.successCriteria.length > 0
        ? ['Success criteria:', ...agent.successCriteria.map((item) => `- ${item}`)].join('\n')
        : '';
    const readOnly = agent?.readOnly ? 'Constraint: stay read-only unless explicitly instructed otherwise.' : '';

    return [`Main task: ${this.activeTask}`, label, sharedContext, brief, deliverable, criteria, readOnly, prior]
      .filter((part) => part.length > 0)
      .join('\n\n');
  }

  private collectAllOutputs(): string {
    const fragments: string[] = [];
    for (const [agentId, output] of this.agentOutputs.entries()) {
      fragments.push(`${agentId}:\n${output}`);
    }
    return fragments.join('\n\n');
  }

  private isRunComplete(): boolean {
    const leadDone = this.agentStates.get(this.leadId) === 'done';
    const workersDone = this.workerIds.every((workerId) => this.agentStates.get(workerId) === 'done');
    const reviewersDone = this.reviewerIds.every((reviewerId) => this.agentStates.get(reviewerId) === 'done');
    return leadDone && workersDone && reviewersDone;
  }

  private buildFinalOutput(success: boolean): string {
    if (success) {
      const leadOutput = this.agentOutputs.get(this.leadId) ?? '';
      return leadOutput.length > 0 ? leadOutput : 'Team run completed without lead synthesis output.';
    }

    if (this.activeSignal?.aborted === true) {
      return 'Team run cancelled by caller.';
    }

    return `Team run reached max rounds (${this.config.maxRounds}) without completion.`;
  }

  private ensureNotAborted(): void {
    if (this.activeSignal?.aborted === true) {
      throw new Error('Team run aborted.');
    }
  }

  private resetRunState(task: string): void {
    this.activeTask = task;
    this.currentRound = 0;
    this.messages.length = 0;
    this.agentOutputs.clear();

    for (const agentId of this.agentsById.keys()) {
      this.agentStates.set(agentId, 'idle');
      this.messageQueues.set(agentId, []);
    }
  }

  private normalizeAgents(agents: AgentRole[]): AgentRole[] {
    return agents.map((agent) => {
      if (agent.role !== 'lead') {
        return { ...agent };
      }

      const prompt = agent.systemPrompt.includes(LEAD_COORDINATION_SUFFIX)
        ? agent.systemPrompt
        : `${agent.systemPrompt}\n\n${LEAD_COORDINATION_SUFFIX}`;

      return {
        ...agent,
        systemPrompt: prompt,
      };
    });
  }
}
