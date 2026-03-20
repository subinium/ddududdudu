import { createHash } from 'node:crypto';

export interface ToolLoopRecordInput {
  name: string;
  input: unknown;
  output?: unknown;
  error?: string | null;
}

export interface LoopWarning {
  name: string;
  count: number;
  signature: string;
  message: string;
}

interface LoopEntry {
  name: string;
  signature: string;
}

const MAX_WINDOW = 10;
const DEFAULT_THRESHOLD = 3;

const stableSerialize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`;
};

export class LoopDetector {
  private readonly history: LoopEntry[] = [];
  private readonly warned = new Map<string, number>();

  public constructor(
    private readonly threshold: number = DEFAULT_THRESHOLD,
    private readonly windowSize: number = MAX_WINDOW,
  ) {}

  public reset(): void {
    this.history.length = 0;
    this.warned.clear();
  }

  public record(input: ToolLoopRecordInput): LoopWarning | null {
    const signature = this.buildSignature(input.name, {
      input: input.input,
      output: input.output,
      error: input.error ?? null,
    });
    this.history.push({ name: input.name, signature });
    if (this.history.length > this.windowSize) {
      this.history.splice(0, this.history.length - this.windowSize);
    }

    const count = this.history.filter((entry) => entry.signature === signature).length;
    const prior = this.warned.get(signature) ?? 0;
    if (count < this.threshold || count <= prior) {
      return null;
    }

    this.warned.set(signature, count);
    return {
      name: input.name,
      count,
      signature,
      message: `Repeated tool call detected: ${input.name} ran ${count} times with the same effective input/outcome in the recent window. Change approach before retrying.`,
    };
  }

  private buildSignature(name: string, input: unknown): string {
    return createHash('sha256')
      .update(`${name}:${stableSerialize(input)}`)
      .digest('hex');
  }
}
