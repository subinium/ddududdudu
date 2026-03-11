import { randomUUID } from 'node:crypto';

import { DriftDetector } from '../../../core/drift-detector.js';
import { formatBriefing, generateBriefing, loadBriefing, saveBriefing } from '../../../core/briefing.js';
import type { EpistemicState } from '../../../core/epistemic-state.js';
import type { SessionListItem } from '../../../core/types.js';
import type { NamedMode } from '../../../core/types.js';
import type { AskUserPrompt } from '../../../tools/index.js';
import { buildInputPrompt } from '../ask-user-support.js';
import type { NativeMessageState } from '../protocol.js';

interface SessionManagerLike {
  list: () => Promise<SessionListItem[]>;
  create: (input: {
    parentId?: string;
    provider: string;
    model: string;
    title: string;
    metadata: { mode: NamedMode };
  }) => Promise<{ id: string }>;
}

interface CompactionEngineLike {
  handoff: (goal: string, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => Promise<{
    summary: string;
    relevantFiles: string[];
  }>;
}

interface EpistemicStateLike {
  getState: () => EpistemicState;
  save: (artifactDir: string) => Promise<void>;
}

export interface SessionCommandDeps {
  sessionManager: SessionManagerLike | null;
  state: {
    sessionId: string | null;
    messages: NativeMessageState[];
  };
  currentMode: NamedMode;
  getCurrentProvider: () => string;
  getCurrentModel: () => string;
  formatSessionSummary: () => Promise<string>;
  formatSessionListItem: (session: SessionListItem) => string;
  formatSessionTitle: (session: SessionListItem) => string;
  resolveSessionReference: (sessions: SessionListItem[], reference: string) => SessionListItem | null;
  resumeSessionById: (sessionId: string) => Promise<void>;
  promptForQuestionValue: (prompt: AskUserPrompt) => Promise<string>;
  seedSessionMessages: (sessionId: string, messages: NativeMessageState[]) => Promise<void>;
  restoreEpistemicState: () => Promise<void>;
  appendSystemMessage: (message: string) => void;
  persistWorkflowState: (reason: string) => Promise<void>;
  compactionEngine: CompactionEngineLike;
  toCompactionMessages: (messages: NativeMessageState[]) => Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  remoteSessionsClear: () => void;
  updateRemoteSessionState: () => void;
  scheduleStatePush: () => void;
  getSessionArtifactDirectory: () => string | null;
  invalidateDerivedCaches: (flags: { briefing?: boolean }) => void;
  epistemicState: EpistemicStateLike;
}

export const runSessionCommand = async (args: string[], deps: SessionCommandDeps): Promise<string> => {
  const command = args[0]?.trim().toLowerCase() ?? '';
  if (!command || command === 'status') {
    return deps.formatSessionSummary();
  }

  if (!deps.sessionManager) {
    return 'Session manager unavailable.';
  }

  if (command === 'list') {
    const sessions = await deps.sessionManager.list();
    if (sessions.length === 0) {
      return 'Sessions: none';
    }
    return ['Sessions', ...sessions.slice(0, 12).map((session, index) => `${index + 1}. ${deps.formatSessionListItem(session)}`)].join('\n');
  }

  if (command === 'last') {
    const sessions = await deps.sessionManager.list();
    const latest = sessions[0];
    if (!latest) {
      return 'No saved sessions yet.';
    }
    await deps.resumeSessionById(latest.id);
    return `Resumed ${deps.formatSessionTitle(latest)}.`;
  }

  if (command === 'pick') {
    const sessions = await deps.sessionManager.list();
    if (sessions.length === 0) {
      return 'No saved sessions yet.';
    }

    const answer = await deps.promptForQuestionValue(buildInputPrompt({
      question: 'Which session do you want to resume?',
      detail: 'Pick a recent session or type an index / session id prefix.',
      placeholder: 'Type a session number or id prefix',
      submitLabel: 'Resume session',
      options: sessions.slice(0, 12).map((session, index) => ({
        value: String(index + 1),
        label: `${index + 1}. ${deps.formatSessionTitle(session)}`,
        description: [
          [session.mode, session.provider, session.model].filter((part): part is string => Boolean(part)).join(' · ') || null,
          `${session.entryCount} entries`,
          session.updatedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z'),
          `#${session.id.slice(0, 8)}`,
        ]
          .filter((part): part is string => Boolean(part))
          .join(' · '),
      })),
    }));
    const selected = deps.resolveSessionReference(sessions, answer);
    if (!selected) {
      return 'Session selection cancelled.';
    }

    await deps.resumeSessionById(selected.id);
    return `Resumed ${deps.formatSessionTitle(selected)}.`;
  }

  if (command === 'resume') {
    const reference = args[1]?.trim();
    if (!reference) {
      return 'Usage: /session resume <id|index> or /session pick';
    }
    const sessions = await deps.sessionManager.list();
    const resolved = deps.resolveSessionReference(sessions, reference);
    if (!resolved) {
      return `Session not found: ${reference}`;
    }
    await deps.resumeSessionById(resolved.id);
    return `Resumed ${deps.formatSessionTitle(resolved)}.`;
  }

  return 'Usage: /session [list|last|pick|resume <id|index>]';
};

export const runResumeCommand = async (args: string[], deps: SessionCommandDeps): Promise<string> => {
  const reference = args[0]?.trim().toLowerCase() ?? '';
  if (!reference || reference === 'last') {
    return runSessionCommand(['last'], deps);
  }
  if (reference === 'pick') {
    return runSessionCommand(['pick'], deps);
  }
  return runSessionCommand(['resume', args[0] ?? ''], deps);
};

export const runForkCommand = async (name: string, deps: SessionCommandDeps): Promise<string> => {
  if (!deps.sessionManager) {
    return 'Fork unavailable: no session manager.';
  }

  const parentId = deps.state.sessionId ?? undefined;
  const session = await deps.sessionManager.create({
    parentId,
    provider: deps.getCurrentProvider(),
    model: deps.getCurrentModel(),
    title: name.trim() || `fork:${deps.currentMode}`,
    metadata: {
      mode: deps.currentMode,
    },
  });
  await deps.seedSessionMessages(session.id, deps.state.messages);
  deps.state.sessionId = session.id;
  await deps.restoreEpistemicState();
  deps.appendSystemMessage(`Forked session ${session.id.slice(0, 8)} from parent ${parentId?.slice(0, 8) ?? 'none'}.`);
  void deps.persistWorkflowState('fork');
  return `Forked to new session: ${session.id}`;
};

export const runHandoffCommand = async (goal: string, deps: SessionCommandDeps): Promise<string> => {
  if (!deps.sessionManager) {
    return 'Handoff unavailable: no session manager.';
  }

  const trimmedGoal = goal.trim();
  if (!trimmedGoal) {
    return 'Usage: /handoff <goal>';
  }

  const handoff = await deps.compactionEngine.handoff(trimmedGoal, deps.toCompactionMessages(deps.state.messages));
  const session = await deps.sessionManager.create({
    parentId: deps.state.sessionId ?? undefined,
    provider: deps.getCurrentProvider(),
    model: deps.getCurrentModel(),
    title: `handoff:${trimmedGoal.slice(0, 48)}`,
    metadata: {
      mode: deps.currentMode,
    },
  });

  const now = Date.now();
  const nextMessages: NativeMessageState[] = [
    {
      id: randomUUID(),
      role: 'system',
      content: `Handoff created from previous session. Goal: ${trimmedGoal}`,
      timestamp: now,
    },
    {
      id: randomUUID(),
      role: 'user',
      content: handoff.summary,
      timestamp: now + 1,
    },
    {
      id: randomUUID(),
      role: 'assistant',
      content: 'Handoff loaded. Continue from this compact context.',
      timestamp: now + 2,
    },
  ];

  await deps.seedSessionMessages(session.id, nextMessages);
  deps.state.sessionId = session.id;
  deps.state.messages = nextMessages;
  deps.remoteSessionsClear();
  deps.updateRemoteSessionState();
  await deps.restoreEpistemicState();
  void deps.persistWorkflowState('handoff');
  deps.scheduleStatePush();
  return [`Handoff created: ${session.id}`, `Relevant files: ${handoff.relevantFiles.join(', ') || 'none'}`, '', handoff.summary].join('\n');
};

export const runBriefingCommand = async (deps: SessionCommandDeps): Promise<string> => {
  const artifactDir = deps.getSessionArtifactDirectory();
  if (!artifactDir) {
    return 'Briefing unavailable: no active session.';
  }

  const briefing = generateBriefing(deps.toCompactionMessages(deps.state.messages), deps.epistemicState.getState());
  await saveBriefing(briefing, artifactDir);
  deps.invalidateDerivedCaches({ briefing: true });
  await deps.epistemicState.save(artifactDir);
  return formatBriefing(briefing);
};

export const runDriftCommand = async (deps: SessionCommandDeps): Promise<string> => {
  const artifactDir = deps.getSessionArtifactDirectory();
  if (!artifactDir) {
    return 'Drift check unavailable: no active session.';
  }

  const briefing = await loadBriefing(artifactDir);
  if (!briefing) {
    return 'Drift check unavailable: run /briefing first.';
  }

  const detector = new DriftDetector(process.cwd());
  return detector.formatReport(await detector.detect(briefing));
};
