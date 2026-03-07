export interface HandoffResult {
  summary: string;
  relevantFiles: string[];
  draftPrompt: string;
}

export interface CompactionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const FILE_PATH_PATTERN =
  /(?:^|[\s`"'])([./]?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z0-9]+)(?=$|[\s`"',:;\])])/g;

const extractRelevantFiles = (messages: CompactionMessage[]): string[] => {
  const files = new Set<string>();

  for (const message of messages) {
    let match = FILE_PATH_PATTERN.exec(message.content);
    while (match) {
      files.add(match[1]);
      match = FILE_PATH_PATTERN.exec(message.content);
    }
    FILE_PATH_PATTERN.lastIndex = 0;
  }

  return Array.from(files).sort((a: string, b: string) => a.localeCompare(b));
};

const summarizeMessages = (messages: CompactionMessage[], maxItems: number): string[] => {
  const summaryLines: string[] = [];

  for (const message of messages) {
    const compacted = message.content.replace(/\s+/g, ' ').trim();
    if (!compacted) {
      continue;
    }

    const clipped = compacted.length > 220 ? `${compacted.slice(0, 217)}...` : compacted;
    summaryLines.push(`- [${message.role}] ${clipped}`);

    if (summaryLines.length >= maxItems) {
      break;
    }
  }

  return summaryLines;
};

export class CompactionEngine {
  public async handoff(
    goal: string,
    messages: CompactionMessage[]
  ): Promise<HandoffResult> {
    const relevantFiles = extractRelevantFiles(messages);
    const summaryBlocks = summarizeMessages(messages.slice(-12), 8);

    const summary = [
      `Goal: ${goal}`,
      'Conversation Highlights:',
      ...summaryBlocks,
      relevantFiles.length > 0
        ? `Relevant Files: ${relevantFiles.join(', ')}`
        : 'Relevant Files: none detected',
    ].join('\n');

    const secondaryPrompt =
      'Given this conversation, extract the key context needed to continue with the goal: ' +
      `${goal}. Include: key decisions, file paths, current state, what was tried.`;

    const draftPrompt = [
      secondaryPrompt,
      '',
      'Conversation Snapshot:',
      ...messages.map((message: CompactionMessage) => `[${message.role}] ${message.content}`),
    ].join('\n');

    return {
      summary,
      relevantFiles,
      draftPrompt,
    };
  }

  public async compact(
    messages: CompactionMessage[],
    instructions?: string
  ): Promise<string> {
    const systemMessages = messages.filter(
      (message: CompactionMessage) => message.role === 'system'
    );
    const recentMessages = messages.slice(-3);
    const toolLikeMessages = messages.filter((message: CompactionMessage) =>
      /\btool\b|\bstdout\b|\bstderr\b|```/i.test(message.content)
    );

    const preserved = [
      ...systemMessages,
      ...toolLikeMessages.slice(-3),
      ...recentMessages,
    ];

    const deduped: CompactionMessage[] = [];
    const seen = new Set<string>();
    for (const message of preserved) {
      const key = `${message.role}:${message.content}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(message);
    }

    const body = summarizeMessages(messages, 12).join('\n');

    return [
      '# Compacted Context',
      instructions ? `Instructions: ${instructions}` : 'Instructions: Continue from this compacted state.',
      '',
      '## Summary',
      body || '- No conversation history available.',
      '',
      '## Preserved Messages',
      ...deduped.map((message: CompactionMessage) =>
        `- [${message.role}] ${message.content.replace(/\s+/g, ' ').trim()}`
      ),
    ].join('\n');
  }

  public shouldWarn(tokenCount: number, contextLimit: number): boolean {
    if (contextLimit <= 0) {
      return false;
    }

    return tokenCount / contextLimit > 0.8;
  }
}
