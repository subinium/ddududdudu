import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type EpistemicSource = 'user' | 'agent' | 'tool' | 'inferred';

export interface EpistemicItem {
  id: string;
  content: string;
  confidence: number;
  timestamp: string;
  source: EpistemicSource;
  tags?: string[];
}

export interface EpistemicState {
  knownFacts: EpistemicItem[];
  reasonedConclusions: EpistemicItem[];
  activeUncertainties: EpistemicItem[];
  designDecisions: EpistemicItem[];
  invalidatedBeliefs: EpistemicItem[];
}

const EPISTEMIC_FILE_NAME = 'epistemic.json';

const createDefaultState = (): EpistemicState => ({
  knownFacts: [],
  reasonedConclusions: [],
  activeUncertainties: [],
  designDecisions: [],
  invalidatedBeliefs: [],
});

const clampConfidence = (confidence: number): number => {
  if (Number.isNaN(confidence)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, confidence));
};

const formatItems = (title: string, items: EpistemicItem[]): string[] => {
  if (items.length === 0) {
    return [`${title}: none`];
  }

  return [
    `${title}:`,
    ...items.map(
      (item: EpistemicItem) =>
        `- ${item.content} (confidence=${item.confidence.toFixed(2)}, source=${item.source})`
    ),
  ];
};

export class EpistemicStateManager {
  private state: EpistemicState;

  public constructor(initialState?: EpistemicState) {
    this.state = initialState ?? createDefaultState();
  }

  public addFact(content: string, source: EpistemicSource, confidence: number = 0.9): void {
    this.state.knownFacts.push(this.createItem(content, source, confidence));
  }

  public addConclusion(
    content: string,
    source: EpistemicSource,
    confidence: number = 0.7
  ): void {
    this.state.reasonedConclusions.push(this.createItem(content, source, confidence));
  }

  public addUncertainty(content: string, source: EpistemicSource): void {
    this.state.activeUncertainties.push(this.createItem(content, source, 0.4));
  }

  public addDecision(
    content: string,
    source: EpistemicSource,
    rationale?: string
  ): void {
    const decisionText = rationale ? `${content} | rationale: ${rationale}` : content;
    this.state.designDecisions.push(this.createItem(decisionText, source, 0.85));
  }

  public invalidate(id: string, reason: string): void {
    const categories: Array<keyof EpistemicState> = [
      'knownFacts',
      'reasonedConclusions',
      'activeUncertainties',
      'designDecisions',
    ];

    for (const category of categories) {
      const index = this.state[category].findIndex((item: EpistemicItem) => item.id === id);
      if (index < 0) {
        continue;
      }

      const [item] = this.state[category].splice(index, 1);
      this.state.invalidatedBeliefs.push({
        ...item,
        content: `${item.content} | invalidated: ${reason}`,
        timestamp: new Date().toISOString(),
        confidence: 1,
      });
      return;
    }
  }

  public toContext(): string {
    return [
      '# Epistemic State',
      ...formatItems('Known Facts', this.state.knownFacts),
      ...formatItems('Reasoned Conclusions', this.state.reasonedConclusions),
      ...formatItems('Design Decisions', this.state.designDecisions),
      ...formatItems('Invalidated Beliefs', this.state.invalidatedBeliefs),
      ...formatItems('Active Uncertainties (attention-critical, keep at end)', this.state.activeUncertainties),
    ].join('\n');
  }

  public async save(sessionDir: string): Promise<void> {
    await mkdir(sessionDir, { recursive: true });
    const filePath = resolve(sessionDir, EPISTEMIC_FILE_NAME);
    await writeFile(filePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  public async load(sessionDir: string): Promise<void> {
    const filePath = resolve(sessionDir, EPISTEMIC_FILE_NAME);

    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as EpistemicState;
      this.state = {
        knownFacts: parsed.knownFacts ?? [],
        reasonedConclusions: parsed.reasonedConclusions ?? [],
        activeUncertainties: parsed.activeUncertainties ?? [],
        designDecisions: parsed.designDecisions ?? [],
        invalidatedBeliefs: parsed.invalidatedBeliefs ?? [],
      };
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        this.state = createDefaultState();
        return;
      }

      throw err;
    }
  }

  public getStats(): {
    facts: number;
    conclusions: number;
    uncertainties: number;
    decisions: number;
    invalidated: number;
  } {
    return {
      facts: this.state.knownFacts.length,
      conclusions: this.state.reasonedConclusions.length,
      uncertainties: this.state.activeUncertainties.length,
      decisions: this.state.designDecisions.length,
      invalidated: this.state.invalidatedBeliefs.length,
    };
  }

  public getState(): EpistemicState {
    return this.state;
  }

  private createItem(
    content: string,
    source: EpistemicSource,
    confidence: number,
    tags?: string[]
  ): EpistemicItem {
    return {
      id: randomUUID(),
      content: content.trim(),
      confidence: clampConfidence(confidence),
      timestamp: new Date().toISOString(),
      source,
      tags,
    };
  }
}
