import { readdir, readFile } from 'node:fs/promises';
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

const readOptionalDirectoryFiles = async (directoryPath: string): Promise<string[]> => {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    const sections = await Promise.all(
      files.map(async (fileName: string): Promise<string> => {
        const filePath = resolve(directoryPath, fileName);
        const content = await readOptionalFile(filePath);
        if (!content) {
          return '';
        }

        return `# Rule: ${fileName}\n${content}`;
      }),
    );

    return sections.filter((section: string) => section.length > 0);
  } catch {
    return [];
  }
};

const readLegacyInstructionFiles = async (context: PromptContext): Promise<string[]> => {
  const provider = context.provider.trim().toLowerCase();
  const providerFile =
    provider === 'anthropic' || provider === 'claude'
      ? 'CLAUDE.md'
      : provider === 'openai' || provider === 'codex'
        ? 'CODEX.md'
        : provider === 'gemini' || provider === 'google'
          ? 'GEMINI.md'
          : null;

  const candidates = [
    ['AGENTS.md', resolve(context.cwd, 'AGENTS.md')],
    ...(providerFile ? [[providerFile, resolve(context.cwd, providerFile)]] : []),
  ] as const;

  const sections = await Promise.all(
    candidates.map(async ([label, filePath]): Promise<string> => {
      const content = await readOptionalFile(filePath);
      if (!content) {
        return '';
      }

      return `# Imported: ${label}\n${content}`;
    }),
  );

  return sections.filter((section: string) => section.length > 0);
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
  const [globalInstructions, projectInstructions, legacyInstructions, globalRules, projectRules] = await Promise.all([
    readOptionalFile(paths.globalInstructions),
    readOptionalFile(paths.projectInstructions),
    readLegacyInstructionFiles(context),
    readOptionalDirectoryFiles(paths.globalRules),
    readOptionalDirectoryFiles(paths.projectRules),
  ]);

  return mergeSections([
    context.userInstructions,
    globalInstructions,
    projectInstructions,
    ...legacyInstructions,
    ...globalRules,
    ...projectRules,
  ]);
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
