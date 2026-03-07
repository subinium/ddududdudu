import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { CompactionMessage } from './compaction.js';
import type { EpistemicState } from './epistemic-state.js';

export interface SessionBriefing {
  summary: string;
  keyDecisions: string[];
  openQuestions: string[];
  filesModified: string[];
  nextSteps: string[];
  epistemicHighlights: {
    newFacts: string[];
    unresolvedUncertainties: string[];
    keyDesignChoices: string[];
  };
  timestamp: string;
}

const BRIEFING_FILE_NAME = 'briefing.json';

const FILE_PATH_PATTERN =
  /(?:^|[\s`"'])([./]?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z0-9]+)(?=$|[\s`"',:;\])])/g;

const toUniqueList = (items: string[]): string[] => {
  return Array.from(
    new Set(
      items
        .map((item: string) => item.trim())
        .filter((item: string) => item.length > 0)
    )
  );
};

const extractMatchingLines = (messages: CompactionMessage[], pattern: RegExp): string[] => {
  const matches: string[] = [];

  for (const message of messages) {
    const lines = message.content.split('\n');
    for (const line of lines) {
      if (pattern.test(line)) {
        matches.push(line.trim());
      }
      pattern.lastIndex = 0;
    }
  }

  return toUniqueList(matches);
};

const extractFiles = (messages: CompactionMessage[]): string[] => {
  const files: string[] = [];

  for (const message of messages) {
    let match = FILE_PATH_PATTERN.exec(message.content);
    while (match) {
      files.push(match[1]);
      match = FILE_PATH_PATTERN.exec(message.content);
    }
    FILE_PATH_PATTERN.lastIndex = 0;
  }

  return toUniqueList(files).sort((a: string, b: string) => a.localeCompare(b));
};

const extractNextSteps = (message: CompactionMessage | undefined): string[] => {
  if (!message) {
    return [];
  }

  const lines = message.content.split('\n').map((line: string) => line.trim());
  const actionLikeLines = lines.filter((line: string) => {
    return /^(?:[-*]|\d+\.)\s+/.test(line) || /\b(next|then|run|verify|update|add|fix|create)\b/i.test(line);
  });

  return toUniqueList(actionLikeLines).slice(0, 8);
};

const createSummary = (messages: CompactionMessage[]): string => {
  const userMessage = messages.find((message: CompactionMessage) => message.role === 'user');
  const assistantMessage = [...messages]
    .reverse()
    .find((message: CompactionMessage) => message.role === 'assistant');

  const userPart = userMessage?.content.replace(/\s+/g, ' ').trim() ?? 'No explicit user goal found.';
  const assistantPart =
    assistantMessage?.content.replace(/\s+/g, ' ').trim() ?? 'No assistant progress found.';

  const clippedUser = userPart.length > 180 ? `${userPart.slice(0, 177)}...` : userPart;
  const clippedAssistant =
    assistantPart.length > 180 ? `${assistantPart.slice(0, 177)}...` : assistantPart;

  return `Goal: ${clippedUser} Progress: ${clippedAssistant}`;
};

export const generateBriefing = (
  messages: CompactionMessage[],
  epistemic?: EpistemicState
): SessionBriefing => {
  const keyDecisions = extractMatchingLines(
    messages,
    /\b(decided|chose|will use|going with)\b/i
  );
  const openQuestions = extractMatchingLines(messages, /\?|\b(unsure|unclear|todo)\b/i);
  const filesModified = extractFiles(messages);
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((message: CompactionMessage) => message.role === 'assistant');
  const nextSteps = extractNextSteps(lastAssistantMessage);

  return {
    summary: createSummary(messages),
    keyDecisions,
    openQuestions,
    filesModified,
    nextSteps,
    epistemicHighlights: {
      newFacts: (epistemic?.knownFacts ?? []).map((item) => item.content).slice(-8),
      unresolvedUncertainties: (epistemic?.activeUncertainties ?? []).map((item) => item.content),
      keyDesignChoices: (epistemic?.designDecisions ?? []).map((item) => item.content).slice(-8),
    },
    timestamp: new Date().toISOString(),
  };
};

export const formatBriefing = (briefing: SessionBriefing): string => {
  const list = (items: string[]): string => {
    return items.length > 0 ? items.map((item: string) => `- ${item}`).join('\n') : '- none';
  };

  return [
    '# Session Briefing',
    `Timestamp: ${briefing.timestamp}`,
    '',
    '## Summary',
    briefing.summary,
    '',
    '## Key Decisions',
    list(briefing.keyDecisions),
    '',
    '## Open Questions',
    list(briefing.openQuestions),
    '',
    '## Files Modified',
    list(briefing.filesModified),
    '',
    '## Next Steps',
    list(briefing.nextSteps),
    '',
    '## Epistemic Highlights',
    '### New Facts',
    list(briefing.epistemicHighlights.newFacts),
    '',
    '### Unresolved Uncertainties',
    list(briefing.epistemicHighlights.unresolvedUncertainties),
    '',
    '### Key Design Choices',
    list(briefing.epistemicHighlights.keyDesignChoices),
  ].join('\n');
};

export const saveBriefing = async (
  briefing: SessionBriefing,
  sessionDir: string
): Promise<void> => {
  await mkdir(sessionDir, { recursive: true });
  const filePath = resolve(sessionDir, BRIEFING_FILE_NAME);
  await writeFile(filePath, JSON.stringify(briefing, null, 2), 'utf8');
};

export const loadBriefing = async (sessionDir: string): Promise<SessionBriefing | null> => {
  const filePath = resolve(sessionDir, BRIEFING_FILE_NAME);

  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as SessionBriefing;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return null;
    }

    throw err;
  }
};
