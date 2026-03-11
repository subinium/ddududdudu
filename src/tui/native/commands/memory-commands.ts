import { appendMemory, clearMemory, loadMemory, saveMemory, type MemoryScope } from '../../../core/memory.js';

const MEMORY_SCOPES: MemoryScope[] = ['global', 'project', 'working', 'episodic', 'semantic', 'procedural'];

const hasMeaningfulMemory = (memory: string): boolean => {
  return memory
    .replace(/## Global Memory/gu, '')
    .replace(/## Project Memory/gu, '')
    .trim()
    .length > 0;
};

const previewText = (value: string, maxLength: number = 96): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

export interface MemoryCommandDeps {
  parseMemoryScope: (value: string | undefined) => MemoryScope | null;
  formatMemorySummary: () => Promise<string>;
  invalidateDerivedCaches: (flags: { memory?: boolean }) => void;
  refreshSystemPrompt: () => Promise<void>;
  scheduleStatePush: () => void;
}

export const runMemoryCommand = async (args: string[], deps: MemoryCommandDeps): Promise<string> => {
  const command = args[0]?.trim().toLowerCase() ?? '';
  if (!command || command === 'read') {
    if (command === 'read' && args[1]) {
      const scope = deps.parseMemoryScope(args[1]?.trim().toLowerCase());
      if (!scope) {
        return 'Usage: /memory read [global|project|working|episodic|semantic|procedural]';
      }
      const memory = await loadMemory(process.cwd());
      const title = `## ${scope.charAt(0).toUpperCase() + scope.slice(1)} Memory\n`;
      const section = memory.split(/\n(?=## )/u).find((entry) => entry.startsWith(title));
      return section ? `Memory\n${section.replace(title, '')}` : `Memory (${scope}) is empty.`;
    }
    return deps.formatMemorySummary();
  }

  if (command === 'write' || command === 'append') {
    const scope = deps.parseMemoryScope(args[1]?.trim().toLowerCase());
    if (!scope) {
      return `Usage: /memory ${command} <global|project|working|episodic|semantic|procedural> <content>`;
    }
    const content = args.slice(2).join(' ').trim();
    if (!content) {
      return `Usage: /memory ${command} <global|project|working|episodic|semantic|procedural> <content>`;
    }
    if (command === 'write') {
      await saveMemory(process.cwd(), content, scope);
    } else {
      await appendMemory(process.cwd(), content, scope);
    }
    deps.invalidateDerivedCaches({ memory: true });
    await deps.refreshSystemPrompt();
    deps.scheduleStatePush();
    return `Memory ${command === 'write' ? 'written' : 'appended'} in ${scope}.`;
  }

  if (command === 'clear') {
    const scope = deps.parseMemoryScope(args[1]?.trim().toLowerCase());
    if (!scope) {
      return 'Usage: /memory clear <global|project|working|episodic|semantic|procedural>';
    }
    await clearMemory(process.cwd(), scope);
    deps.invalidateDerivedCaches({ memory: true });
    await deps.refreshSystemPrompt();
    deps.scheduleStatePush();
    return `Memory cleared in ${scope}.`;
  }

  return 'Usage: /memory [read [scope]|write <scope> <content>|append <scope> <content>|clear <scope>]';
};

export const formatMemorySummary = async (): Promise<string> => {
  try {
    const memory = await loadMemory(process.cwd());
    if (!hasMeaningfulMemory(memory)) {
      return 'Memory is empty.';
    }
    const preview = previewText(memory, 400);
    return preview ? `Memory\n${preview}` : 'Memory is empty.';
  } catch (error: unknown) {
    const message = error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
    return `Memory read failed: ${message}`;
  }
};

export const parseMemoryScope = (value: string | undefined): MemoryScope | null => {
  if (!value) {
    return null;
  }

  return MEMORY_SCOPES.includes(value as MemoryScope) ? (value as MemoryScope) : null;
};
