export interface HandoffResult {
  summary: string;
  relevantFiles: string[];
  draftPrompt: string;
}

export interface CompactionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export type CompactionSummarizer = (
  systemPrompt: string,
  userMessage: string,
) => Promise<string>;

export interface CompactionOptions {
  instructions?: string;
  summarizer?: CompactionSummarizer;
  preserveRecentTurns?: number;
}

const PRUNE_RECENT_TURNS = 5;

const COMPACTION_SYSTEM_PROMPT = [
  'You are performing a CONTEXT COMPACTION for a coding assistant session.',
  'Create a comprehensive, structured summary that allows another AI agent to continue this conversation seamlessly.',
  '',
  'Rules:',
  '- Preserve ALL technical details: file paths, function names, variable names, error messages, configuration values, code snippets.',
  '- Include the user\'s original goal and every refinement or scope change.',
  '- Document key decisions and their rationale.',
  '- List completed work with specifics (what files changed, what was added/removed).',
  '- The next agent has NO access to the original conversation. Your summary is their ONLY context.',
  '- Be thorough but concise. Every sentence should carry information.',
].join('\n');

const COMPACTION_TEMPLATE = [
  'Analyze the conversation below and create a structured summary using this exact format.',
  'Do NOT wrap the output in a code fence. Output the markdown directly.',
  '',
  '## Goal',
  '[The user\'s primary objective. Include the original request and any refinements or scope changes.]',
  '',
  '## Instructions',
  '[Important instructions the user gave — coding style, constraints, things to avoid, environment requirements. Each as a bullet.]',
  '',
  '## Discoveries',
  '[Notable things learned during the conversation — architecture details, bugs found, patterns identified, performance findings.]',
  '',
  '## Accomplished',
  '[What work has been completed. Be specific: file paths, functions created/modified, tests added, commits made.]',
  '',
  '## In Progress',
  '[What is currently being worked on but not yet finished.]',
  '',
  '## Remaining',
  '[What still needs to be done. Include any blocked items.]',
  '',
  '## Relevant Files',
  '[Structured list of files that were read, edited, or created — with a brief note on each.]',
  '',
  '## Active Context',
  '[Critical technical details the next agent needs immediately: variable names, API endpoints, error messages, configuration values, code patterns being followed.]',
  '',
  '---',
  '',
  'Conversation:',
  '',
].join('\n');

const SUMMARY_PREFIX = [
  '# Compacted Context',
  '',
  'This is a structured summary of the previous conversation, produced to enable seamless continuation.',
  'Build on the work described below — do not duplicate completed work.',
  '',
].join('\n');

const FILE_PATH_PATTERN =
  /(?:^|[\s`"'])([./]?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z0-9]+)(?=$|[\s`"',:;\])])/g;

const TOOL_OUTPUT_PATTERN = /\[tool:(?:ok|error|running)\]|\bstdout\b|\bstderr\b/;

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
  /**
   * Compact a conversation.
   *
   * When a `summarizer` is provided (via CompactionOptions), uses LLM-powered
   * 2-phase compaction: prune old tool outputs → LLM structured summary.
   *
   * Falls back to the legacy string-clip approach when no summarizer is available.
   * Backward-compatible: passing a plain string is treated as `{ instructions }`.
   */
  public async compact(
    messages: CompactionMessage[],
    optionsOrInstructions?: CompactionOptions | string,
  ): Promise<string> {
    const options: CompactionOptions =
      typeof optionsOrInstructions === 'string'
        ? { instructions: optionsOrInstructions }
        : optionsOrInstructions ?? {};

    if (options.summarizer) {
      return this.llmCompact(messages, options);
    }

    return this.legacyCompact(messages, options.instructions);
  }

  public async handoff(
    goal: string,
    messages: CompactionMessage[],
    options?: { summarizer?: CompactionSummarizer },
  ): Promise<HandoffResult> {
    const relevantFiles = extractRelevantFiles(messages);

    if (options?.summarizer) {
      return this.llmHandoff(goal, messages, relevantFiles, options.summarizer);
    }

    return this.legacyHandoff(goal, messages, relevantFiles);
  }

  public shouldWarn(tokenCount: number, contextLimit: number): boolean {
    if (contextLimit <= 0) {
      return false;
    }

    return tokenCount / contextLimit > 0.8;
  }

  private async llmCompact(
    messages: CompactionMessage[],
    options: CompactionOptions,
  ): Promise<string> {
    const pruned = this.pruneForSummarization(messages, options.preserveRecentTurns);
    const conversation = this.formatConversation(pruned);
    const userMessage = `${COMPACTION_TEMPLATE}${conversation}`;

    try {
      const summary = await options.summarizer!(COMPACTION_SYSTEM_PROMPT, userMessage);
      const trimmed = summary.replace(/^```(?:markdown)?\n?/m, '').replace(/\n?```$/m, '').trim();
      return `${SUMMARY_PREFIX}${trimmed}`;
    } catch {
      return this.legacyCompact(messages, options.instructions);
    }
  }

  private async llmHandoff(
    goal: string,
    messages: CompactionMessage[],
    relevantFiles: string[],
    summarizer: CompactionSummarizer,
  ): Promise<HandoffResult> {
    const systemPrompt = [
      'You are creating a HANDOFF SUMMARY for another AI agent.',
      'The goal below is what the user is trying to accomplish.',
      'Preserve all technical details. Be comprehensive but concise.',
    ].join('\n');

    const conversation = this.formatConversation(messages.slice(-20));
    const userMessage = [
      `Goal: ${goal}`,
      '',
      `Known relevant files: ${relevantFiles.length > 0 ? relevantFiles.join(', ') : 'none detected'}`,
      '',
      COMPACTION_TEMPLATE,
      conversation,
    ].join('\n');

    try {
      const summary = await summarizer(systemPrompt, userMessage);
      const trimmed = summary.replace(/^```(?:markdown)?\n?/m, '').replace(/\n?```$/m, '').trim();

      return {
        summary: `${SUMMARY_PREFIX}${trimmed}`,
        relevantFiles,
        draftPrompt: `Continue from this handoff. Goal: ${goal}`,
      };
    } catch {
      return this.legacyHandoff(goal, messages, relevantFiles);
    }
  }

  private pruneForSummarization(
    messages: CompactionMessage[],
    preserveRecentTurns: number = PRUNE_RECENT_TURNS,
  ): CompactionMessage[] {
    let turnsSeen = 0;
    let boundaryIndex = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        turnsSeen++;
      }
      if (turnsSeen > preserveRecentTurns) {
        boundaryIndex = i + 1;
        break;
      }
    }

    return messages.map((msg, i) => {
      if (i >= boundaryIndex) {
        return msg;
      }

      if (msg.role === 'system') {
        return msg;
      }

      const content = msg.content;

      if (TOOL_OUTPUT_PATTERN.test(content)) {
        const lines = content.split('\n');
        const summaryLines = lines
          .filter((l) => /^\[tool:/.test(l.trim()) || l.trim().length < 120)
          .slice(0, 5);
        return {
          ...msg,
          content: summaryLines.length > 0 ? summaryLines.join('\n') : content.slice(0, 200),
        };
      }

      if (content.length > 800) {
        return { ...msg, content: `${content.slice(0, 600)}\n…\n${content.slice(-150)}` };
      }

      return msg;
    });
  }

  private formatConversation(messages: CompactionMessage[]): string {
    return messages
      .map((msg) => {
        const label = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
        return `### ${label}\n${msg.content}`;
      })
      .join('\n\n');
  }

  private legacyCompact(messages: CompactionMessage[], instructions?: string): string {
    const systemMessages = messages.filter(
      (message: CompactionMessage) => message.role === 'system',
    );
    const recentMessages = messages.slice(-3);
    const toolLikeMessages = messages.filter((message: CompactionMessage) =>
      /\btool\b|\bstdout\b|\bstderr\b|```/i.test(message.content),
    );

    const preserved = [...systemMessages, ...toolLikeMessages.slice(-3), ...recentMessages];

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
      instructions
        ? `Instructions: ${instructions}`
        : 'Instructions: Continue from this compacted state.',
      '',
      '## Summary',
      body || '- No conversation history available.',
      '',
      '## Preserved Messages',
      ...deduped.map(
        (message: CompactionMessage) =>
          `- [${message.role}] ${message.content.replace(/\s+/g, ' ').trim()}`,
      ),
    ].join('\n');
  }

  private legacyHandoff(
    goal: string,
    messages: CompactionMessage[],
    relevantFiles: string[],
  ): HandoffResult {
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
      ...messages.map(
        (message: CompactionMessage) => `[${message.role}] ${message.content}`,
      ),
    ].join('\n');

    return {
      summary,
      relevantFiles,
      draftPrompt,
    };
  }
}
