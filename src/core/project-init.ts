import { constants } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { ensureProjectDirs, getDduduPaths } from './dirs.js';

export interface ProjectInitResult {
  projectDir: string;
  created: string[];
  alreadyInitialized: boolean;
}

const ROOT_AGENTS_TEMPLATE = `# Repository Instructions

<!-- Shared instructions for ddudu, Codex CLI, Claude Code, opencode, and similar tools -->

## Product Context
- What this repository does:
- Primary user or customer:
- Non-goals or explicit scope limits:

## Build And Verify
- Main dev command:
- Test command:
- Lint or format command:
- Required checks before completion:

## Codebase Rules
- Preferred architecture or layering constraints:
- File or package boundaries that should stay stable:
- Naming or API compatibility requirements:

## Workflow
- Keep changes focused and verification-ready.
- Prefer reading local docs and config before making assumptions.
- Surface blockers, tradeoffs, and follow-up work explicitly.
`;

const HOOKS_README = `# ddudu Hook Templates

Hooks in this folder run automatically when the filename starts with a supported event name.

Supported events:
- beforeToolCall
- afterToolCall
- beforeApiCall
- afterApiCall
- onSessionStart
- onSessionEnd
- onModeSwitch
- onError
- beforeSend
- afterResponse

Starter templates are included in this folder but are disabled by default.
Rename a template so the filename starts with the event name to enable it.

Examples:
- rename \`template-onSessionStart.mjs\` to \`onSessionStart.mjs\`
- rename \`template-afterResponse.mjs\` to \`afterResponse.mjs\`
`;

const TEMPLATE_ON_SESSION_START = `import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const readContext = async () => {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return JSON.parse(input);
};

const main = async () => {
  const ctx = await readContext();
  const logPath = resolve(process.cwd(), '.ddudu', 'session-events.log');
  const line = JSON.stringify({
    event: ctx.event,
    timestamp: ctx.timestamp,
  });
  await appendFile(logPath, \`\${line}\\n\`, 'utf8');
};

await main();
`;

const TEMPLATE_AFTER_RESPONSE = `const readContext = async () => {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return JSON.parse(input);
};

const main = async () => {
  const ctx = await readContext();
  const preview =
    typeof ctx.data?.response === 'string'
      ? ctx.data.response.replace(/\\s+/g, ' ').trim().slice(0, 120)
      : null;

  if (!preview) {
    return;
  }

  console.error(\`[hook:afterResponse] \${preview}\`);
};

await main();
`;

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
  directory: \${HOME}/.ddudu/sessions
  auto_save: true
openclaw:
  enabled: true
tools:
  permission: auto
  policies: {}
  network:
    allowed_hosts: []
    denied_hosts: []
    ask_on_new_host: false
  secrets:
    protected_paths:
      - .env
      - .env.*
      - ~/.ssh
      - ~/.aws
      - ~/.ddudu/auth.yaml
    protected_env:
      - OPENAI_API_KEY
      - ANTHROPIC_API_KEY
      - GEMINI_API_KEY
# Example:
# tools:
#   policies:
#     bash: ask
#     mcp__*: deny
#   network:
#     allowed_hosts:
#       - docs.anthropic.com
#       - platform.openai.com
#     ask_on_new_host: true
mcp:
  servers: {}
# Example:
# mcp:
#   servers:
#     memory:
#       command: npx
#       args:
#         - -y
#         - "@modelcontextprotocol/server-memory"
#       enabled: true
#       trust: ask
`;

export const buildProjectInstructionsTemplate = (
  projectName: string,
  createdDate: string,
): string => {
  return `# Project Instructions

<!-- Add project-specific instructions for ddudu here -->
<!-- These are injected into every AI interaction -->
<!-- AGENTS.md is also loaded automatically if you want one shared instruction file across tools -->

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
  const projectHooksExisted = await exists(paths.projectHooks);
  const rootAgentsPath = resolve(cwd, 'AGENTS.md');
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

  if (!(await exists(rootAgentsPath))) {
    await writeFile(rootAgentsPath, ROOT_AGENTS_TEMPLATE, 'utf8');
    created.push('AGENTS.md');
  }

  const hooksReadmePath = resolve(paths.projectHooks, 'README.md');
  if (!(await exists(hooksReadmePath))) {
    await writeFile(hooksReadmePath, HOOKS_README, 'utf8');
    created.push('.ddudu/hooks/README.md');
  }

  const sessionStartTemplatePath = resolve(paths.projectHooks, 'template-onSessionStart.mjs');
  if (!(await exists(sessionStartTemplatePath))) {
    await writeFile(sessionStartTemplatePath, TEMPLATE_ON_SESSION_START, 'utf8');
    created.push('.ddudu/hooks/template-onSessionStart.mjs');
  }

  const afterResponseTemplatePath = resolve(paths.projectHooks, 'template-afterResponse.mjs');
  if (!(await exists(afterResponseTemplatePath))) {
    await writeFile(afterResponseTemplatePath, TEMPLATE_AFTER_RESPONSE, 'utf8');
    created.push('.ddudu/hooks/template-afterResponse.mjs');
  }

  if (!projectHooksExisted) {
    created.push('.ddudu/hooks/');
  }

  return {
    projectDir: paths.projectDir,
    created,
    alreadyInitialized: created.length === 0,
  };
};
