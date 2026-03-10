import { buildSpecialistPrompt, getSpecialistRoleProfile } from '../../core/specialist-roles.js';
import {
  TeamExecutionRuntime,
  formatTeamAgentDetail,
  formatTeamAgentLabel,
  isRunnableTeamAgent,
  teamAgentPurpose,
} from '../../core/team-execution.js';
import { type AgentRole as TeamAgentRole } from '../../core/team-agent.js';
import type { NamedMode } from '../../core/types.js';
import type { WorkAllocationPlan } from '../../core/work-allocation.js';
import type { TeamExecutionPlanDraft } from './routing-coordinator.js';
import { HARNESS_MODES } from '../shared/theme.js';

export { formatTeamAgentDetail, formatTeamAgentLabel, isRunnableTeamAgent, teamAgentPurpose } from '../../core/team-execution.js';

export interface TeamExecutionPlan {
  allocation: WorkAllocationPlan;
  agents: TeamAgentRole[];
}

interface TeamPlanCreationInput {
  draft: TeamExecutionPlanDraft;
  resolveRuntime: (mode: NamedMode) => { provider: string; model: string };
  orchestratorPrompt: string | null;
}

export class TeamExecutionCoordinator extends TeamExecutionRuntime {
  public createPlan(input: TeamPlanCreationInput): TeamExecutionPlan {
    const { allocation, leadMode } = input.draft;

    const makeAgent = (
      id: string,
      mode: NamedMode,
      role: 'lead' | 'worker' | 'reviewer',
      systemPrompt: string,
      options: Partial<TeamAgentRole> = {},
    ): TeamAgentRole => {
      const modeConfig = HARNESS_MODES[mode] ?? HARNESS_MODES.jennie;
      const runtime = input.resolveRuntime(mode);
      return {
        id,
        name: modeConfig.label,
        mode,
        role,
        provider: runtime.provider,
        model: runtime.model,
        systemPrompt,
        ...options,
      };
    };

    const orchestratorContract = input.orchestratorPrompt?.trim()
      ? ['<orchestrator_contract>', input.orchestratorPrompt.trim(), '</orchestrator_contract>'].join('\n')
      : '';

    const agents: TeamAgentRole[] = [
      makeAgent(
        'lead',
        leadMode,
        'lead',
        [
          buildSpecialistPrompt(
            'coordinator',
            'Coordinate specialists, merge their outputs, and return the best merged answer.',
          ),
          orchestratorContract || null,
        ]
          .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
          .join('\n\n'),
        {
          roleProfile: 'coordinator',
          taskLabel: 'Coordinate specialists and synthesize the result',
          readOnly: true,
        },
      ),
    ];

    let counter = 0;
    const unitsByLabel = new Map(allocation.units.map((unit) => [unit.label, unit]));
    for (const unit of allocation.units) {
      const mode = unit.preferredMode ?? leadMode;
      agents.push(
        makeAgent(
          `${unit.role}_${counter += 1}`,
          mode,
          unit.role === 'reviewer' ? 'reviewer' : 'worker',
          buildSpecialistPrompt(unit.role, unit.label, unit.successCriteria),
          {
            roleProfile: unit.role,
            taskLabel: unit.label,
            taskBrief: unit.brief,
            deliverable: unit.deliverable,
            successCriteria: unit.successCriteria,
            readOnly: unit.readOnly,
            dependencyLabels: [...unit.dependsOn],
            dependencyUnitIds: unit.dependsOn
              .map((label) => unitsByLabel.get(label)?.id ?? null)
              .filter((id): id is string => typeof id === 'string'),
            handoffTo: unit.handoffTo ? getSpecialistRoleProfile(unit.handoffTo).label : undefined,
            workUnitId: unit.id,
          },
        ),
      );
    }

    return { allocation, agents };
  }
}
