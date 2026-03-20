import { basename } from 'node:path';
import { loadOrchestratorPrompt, loadSystemPrompt } from '../../core/prompts.js';
import type { LoadedSkill } from '../../core/skill-loader.js';

export const refreshPromptPair = async (input: {
  model: string;
  provider: string;
  promptVersion: string;
  userInstructions: string;
  loadedSkills: LoadedSkill[];
  selectedMemory: string;
  hasMeaningfulMemory: (value: string) => boolean;
}): Promise<{ systemPrompt: string; orchestratorPrompt: string }> => {
  const cwd = process.cwd();
  const projectName = basename(cwd) || 'unknown-project';
  const promptContext = {
    model: input.model,
    provider: input.provider,
    cwd,
    projectName,
    version: input.promptVersion,
    timestamp: new Date().toISOString(),
    rules: [],
    skills: input.loadedSkills.map((skill) => skill.name),
    userInstructions: input.userInstructions.trim(),
  };

  let systemPrompt = await loadSystemPrompt(promptContext);
  const orchestratorPrompt = await loadOrchestratorPrompt(promptContext);

  if (input.loadedSkills.length > 0) {
    systemPrompt += `\n\n${input.loadedSkills
      .map((skill) => `<skill name="${skill.name}">\n${skill.content.trim()}\n</skill>`)
      .join('\n\n')}`;
  }

  if (input.hasMeaningfulMemory(input.selectedMemory)) {
    systemPrompt += `\n\n<stable_memory>\n${input.selectedMemory}\n</stable_memory>`;
  }

  return { systemPrompt, orchestratorPrompt };
};
