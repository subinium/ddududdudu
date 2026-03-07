import { constants } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { ensureProjectDirs, getDduduPaths } from './dirs.js';

export interface ProjectInitResult {
  projectDir: string;
  created: string[];
  alreadyInitialized: boolean;
}

export const DEFAULT_CONFIG_YAML = `providers:
  claude:
    command: claude
    args:
      - --dangerously-skip-permissions
    models:
      - id: claude-sonnet-4-6
        tier: medium
        default: true
      - id: claude-opus-4-6
        tier: expensive
  codex:
    command: codex
    models:
      - id: gpt-5.4
        tier: medium
        default: true
agent:
  default_provider: claude
  default_model: claude-sonnet-4-6
  max_turns: 50
  timeout_minutes: 30
tabs:
  max_tabs: 8
  default_layout: single
  restore_on_start: true
compaction:
  trigger: 0.8
  strategy: hierarchical
  preserve_recent_turns: 5
session:
  format: jsonl
  directory: .ddudu/sessions
  auto_save: true
openclaw:
  enabled: true
`;

export const buildProjectInstructionsTemplate = (
  projectName: string,
  createdDate: string,
): string => {
  return `# Project Instructions

<!-- Add project-specific instructions for ddudu here -->
<!-- These are injected into every AI interaction -->

## Project Context
- Name: ${projectName}
- Created: ${createdDate}

## Rules
<!-- Add project-specific rules and conventions -->

## Preferences
<!-- Add your preferred coding style, language, etc. -->
`;
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const initializeProject = async (
  cwd: string = process.cwd(),
  preset?: string | null,
): Promise<ProjectInitResult> => {
  const paths = getDduduPaths(cwd);
  await ensureProjectDirs(cwd);

  const configContent = preset
    ? `${DEFAULT_CONFIG_YAML}\n# init preset\nactive_preset: ${preset}\n`
    : DEFAULT_CONFIG_YAML;

  const created: string[] = [];

  if (!(await exists(paths.projectConfig))) {
    await writeFile(paths.projectConfig, configContent, 'utf8');
    created.push('.ddudu/config.yaml');
  }

  if (!(await exists(paths.projectInstructions))) {
    const projectName = basename(cwd);
    const createdDate = new Date().toISOString().slice(0, 10);
    const template = buildProjectInstructionsTemplate(projectName, createdDate);
    await writeFile(paths.projectInstructions, template, 'utf8');
    created.push('.ddudu/DDUDU.md');
  }

  return {
    projectDir: paths.projectDir,
    created,
    alreadyInitialized: created.length === 0,
  };
};
