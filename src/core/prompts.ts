import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { DEFAULT_ORCHESTRATOR_PROMPT, DEFAULT_SYSTEM_PROMPT } from './default-prompts.js';
import { getDduduPaths } from './dirs.js';

export interface PromptContext {
  model: string;
  provider: string;
  cwd: string;
  projectName: string;
  version: string;
  timestamp: string;
  rules: string[];
  skills: string[];
  userInstructions: string;
}

const readOptionalFile = async (filePath: string): Promise<string> => {
  try {
    const content = await readFile(filePath, 'utf8');
    return content.trim();
  } catch {
    return '';
  }
};

const mergeSections = (sections: string[]): string => {
  return sections
    .map((section: string) => section.trim())
    .filter((section: string) => section.length > 0)
    .join('\n\n');
};

const buildVariables = (context: PromptContext, userInstructions: string): Record<string, string> => {
  return {
    model: context.model,
    provider: context.provider,
    cwd: context.cwd,
    projectName: context.projectName,
    version: context.version,
    timestamp: context.timestamp,
    rules: context.rules.join(', '),
    skills: context.skills.join(', '),
    userInstructions,
  };
};

const interpolatePrompt = (template: string, variables: Record<string, string>): string => {
  return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match: string, name: string) => {
    return variables[name] ?? '';
  });
};

const loadInstructionText = async (context: PromptContext): Promise<string> => {
  const paths = getDduduPaths(context.cwd);
  const [globalInstructions, projectInstructions] = await Promise.all([
    readOptionalFile(paths.globalInstructions),
    readOptionalFile(paths.projectInstructions),
  ]);

  return mergeSections([context.userInstructions, globalInstructions, projectInstructions]);
};

export const loadSystemPrompt = async (context: PromptContext): Promise<string> => {
  const paths = getDduduPaths(context.cwd);
  const [globalPrompt, projectPrompt, instructionText] = await Promise.all([
    readOptionalFile(resolve(paths.globalPrompts, 'system.md')),
    readOptionalFile(resolve(paths.projectPrompts, 'system.md')),
    loadInstructionText(context),
  ]);

  const prompt = mergeSections([DEFAULT_SYSTEM_PROMPT, globalPrompt, projectPrompt]);
  return interpolatePrompt(prompt, buildVariables(context, instructionText));
};

export const loadOrchestratorPrompt = async (context: PromptContext): Promise<string> => {
  const paths = getDduduPaths(context.cwd);
  const [globalPrompt, projectPrompt, instructionText] = await Promise.all([
    readOptionalFile(resolve(paths.globalPrompts, 'orchestrator.md')),
    readOptionalFile(resolve(paths.projectPrompts, 'orchestrator.md')),
    loadInstructionText(context),
  ]);

  const prompt = mergeSections([DEFAULT_ORCHESTRATOR_PROMPT, globalPrompt, projectPrompt]);
  return interpolatePrompt(prompt, buildVariables(context, instructionText));
};
