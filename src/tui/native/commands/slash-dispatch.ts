import type { NamedMode } from '../../../core/types.js';

export interface SlashCommandDeps {
  clearMessages: () => void;
  toggleFire: () => void;
  setMode: (mode: NamedMode) => void;
  setModel: (model: string) => void;
  compactContext: () => Promise<void>;
  appendSystemMessage: (message: string) => void;
  formatPlanSummary: () => string;
  runTodoCommand: (args: string[]) => Promise<string>;
  runPermissionsCommand: (args: string[]) => Promise<string>;
  formatConfigSummary: () => string;
  formatDoctorSummary: () => string;
  formatContextSummary: () => Promise<string>;
  runReviewSummary: () => Promise<string>;
  runQueueCommand: (args: string[]) => Promise<string>;
  runJobsCommand: (args: string[]) => Promise<string>;
  formatArtifactSummary: () => string;
  runCheckpointCommand: (message: string) => Promise<string>;
  runUndoCommand: () => Promise<string>;
  runHandoffCommand: (goal: string) => Promise<string>;
  runForkCommand: (name: string) => Promise<string>;
  runBriefingCommand: () => Promise<string>;
  runDriftCommand: () => Promise<string>;
  runSessionCommand: (args: string[]) => Promise<string>;
  runResumeCommand: (args: string[]) => Promise<string>;
  runMemoryCommand: (args: string[]) => Promise<string>;
  formatSkillSummary: () => Promise<string>;
  loadSkillSummary: (name: string) => Promise<string>;
  runMcpCommand: (args: string[]) => Promise<string>;
  runHookCommand: (args: string[]) => Promise<string>;
  runTeamCommand: (args: string[]) => Promise<string>;
  runInitSummary: () => Promise<string>;
  steer: (content: string, role?: 'user' | 'system') => void;
  models: string[];
}

export const runSlashDispatch = async (command: string, deps: SlashCommandDeps): Promise<void> => {
  const trimmed = command.trim();
  if (!trimmed) {
    return;
  }

  const [head, ...rest] = trimmed.split(/\s+/);

  switch (head) {
    case '/clear':
      deps.clearMessages();
      return;
    case '/fire':
      deps.toggleFire();
      return;
    case '/mode': {
      const mode = rest[0];
      if (mode && (mode === 'jennie' || mode === 'lisa' || mode === 'rosé' || mode === 'jisoo')) {
        deps.setMode(mode);
      } else {
        deps.appendSystemMessage('Use /mode <jennie|lisa|rosé|jisoo>.');
      }
      return;
    }
    case '/model': {
      const model = rest[0];
      if (model) {
        deps.setModel(model);
      } else {
        deps.appendSystemMessage(`Current models: ${deps.models.join(', ')}`);
      }
      return;
    }
    case '/compact':
      await deps.compactContext();
      return;
    case '/help':
      deps.appendSystemMessage(
        'Available commands: /clear, /compact, /mode, /model, /steer, /plan, /todo, /permissions, /memory, /session, /resume, /config, /help, /doctor, /context, /review, /queue, /jobs, /artifacts, /checkpoint, /undo, /handoff, /fork, /briefing, /drift, /quit, /exit, /fire, /init, /skill, /hook, /mcp, /team (/jobs inspect|logs|result|retry|promote|cancel)',
      );
      return;
    case '/plan':
      deps.appendSystemMessage(deps.formatPlanSummary());
      return;
    case '/todo':
      deps.appendSystemMessage(await deps.runTodoCommand(rest));
      return;
    case '/permissions':
      deps.appendSystemMessage(await deps.runPermissionsCommand(rest));
      return;
    case '/config':
      deps.appendSystemMessage(deps.formatConfigSummary());
      return;
    case '/doctor':
      deps.appendSystemMessage(deps.formatDoctorSummary());
      return;
    case '/context':
      deps.appendSystemMessage(await deps.formatContextSummary());
      return;
    case '/review':
      deps.appendSystemMessage(await deps.runReviewSummary());
      return;
    case '/queue':
      deps.appendSystemMessage(await deps.runQueueCommand(rest));
      return;
    case '/jobs':
      deps.appendSystemMessage(await deps.runJobsCommand(rest));
      return;
    case '/artifacts':
      deps.appendSystemMessage(deps.formatArtifactSummary());
      return;
    case '/checkpoint':
      deps.appendSystemMessage(await deps.runCheckpointCommand(rest.join(' ')));
      return;
    case '/undo':
      deps.appendSystemMessage(await deps.runUndoCommand());
      return;
    case '/handoff':
      deps.appendSystemMessage(await deps.runHandoffCommand(rest.join(' ')));
      return;
    case '/fork':
      deps.appendSystemMessage(await deps.runForkCommand(rest.join(' ')));
      return;
    case '/briefing':
      deps.appendSystemMessage(await deps.runBriefingCommand());
      return;
    case '/drift':
      deps.appendSystemMessage(await deps.runDriftCommand());
      return;
    case '/session':
      deps.appendSystemMessage(await deps.runSessionCommand(rest));
      return;
    case '/resume':
      deps.appendSystemMessage(await deps.runResumeCommand(rest));
      return;
    case '/memory':
      deps.appendSystemMessage(await deps.runMemoryCommand(rest));
      return;
    case '/skill':
      if (rest.length === 0) {
        deps.appendSystemMessage(await deps.formatSkillSummary());
      } else {
        deps.appendSystemMessage(await deps.loadSkillSummary(rest.join(' ')));
      }
      return;
    case '/mcp':
      deps.appendSystemMessage(await deps.runMcpCommand(rest));
      return;
    case '/hook':
      deps.appendSystemMessage(await deps.runHookCommand(rest));
      return;
    case '/team':
      deps.appendSystemMessage(await deps.runTeamCommand(rest));
      return;
    case '/init':
      deps.appendSystemMessage(await deps.runInitSummary());
      return;
    case '/steer': {
      const payload = rest.join(' ').trim();
      if (!payload) {
        deps.appendSystemMessage('Use /steer <guidance>. The message will be injected before the next request turn.');
      } else {
        deps.steer(payload, 'user');
      }
      return;
    }
    case '/quit':
    case '/exit':
      deps.appendSystemMessage('Use /quit from the native TUI directly to exit.');
      return;
    default:
      deps.appendSystemMessage(`Unknown command: ${trimmed}`);
      return;
  }
};
