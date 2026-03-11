export interface TeamCommandDeps {
  state: { loading: boolean };
  abortController: AbortController | null;
  formatTeamSummary: () => string;
  canStartBackgroundJob: () => boolean;
  startBackgroundTeamRun: (
    strategy: 'parallel' | 'sequential' | 'delegate',
    task: string,
    options: { routeNote?: string; attempt?: number },
  ) => Promise<void>;
  executeTeamRun: (
    strategy: 'parallel' | 'sequential' | 'delegate',
    task: string,
    options?: { routeNote?: string },
  ) => Promise<string>;
}

export const runTeamCommand = async (args: string[], deps: TeamCommandDeps): Promise<string> => {
  if (args.length === 0 || args[0] === 'status') {
    return deps.formatTeamSummary();
  }

  if (args[0] !== 'run') {
    return 'Usage: /team run [parallel|sequential|delegate] <task>';
  }

  const strategyToken = args[1];
  const strategy =
    strategyToken === 'parallel' || strategyToken === 'sequential' || strategyToken === 'delegate'
      ? strategyToken
      : 'parallel';
  const taskStartIndex = strategyToken === strategy ? 2 : 1;
  const task = args.slice(taskStartIndex).join(' ').trim();
  if (!task) {
    return 'Usage: /team run [parallel|sequential|delegate] <task>';
  }

  if (deps.state.loading || deps.abortController) {
    if (!deps.canStartBackgroundJob()) {
      return 'Team run unavailable: background capacity full.';
    }
    await deps.startBackgroundTeamRun(strategy, task, {
      routeNote: `Team run background · ${strategy}`,
    });
    return `Team run started in background · ${strategy}`;
  }

  return deps.executeTeamRun(strategy, task);
};
