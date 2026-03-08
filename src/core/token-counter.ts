export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

const MODEL_CONTEXT_LIMITS: { [model: string]: number } = {
  'claude-sonnet-4-6': 1000000,
  'claude-opus-4-6': 200000,
  'claude-haiku-4-5': 200000,
  'claude-opus-4-5': 200000,
  'gpt-5.4': 1050000,
  'gpt-5.3-codex': 400000,
  'gpt-5.2-codex': 400000,
  'gpt-5.1-codex': 400000,
  'gpt-5.2': 400000,
  'gpt-5.1': 400000,
  'gpt-5': 400000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gemini-2.5-pro': 1048576,
  'gemini-2.0-flash': 1000000,
};

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const MODEL_PRICING_USD_PER_MILLION: { [model: string]: ModelPricing } = {
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-opus-4-6': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-haiku-4-5': { inputPerMillion: 0.8, outputPerMillion: 4 },
  'claude-opus-4-5': { inputPerMillion: 15, outputPerMillion: 75 },
  'gpt-5.4': { inputPerMillion: 2.5, outputPerMillion: 15 },
  'gpt-5.3-codex': { inputPerMillion: 1.75, outputPerMillion: 14 },
  'gpt-5.2-codex': { inputPerMillion: 1.5, outputPerMillion: 12 },
  'gpt-5.1-codex': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5.2': { inputPerMillion: 1.75, outputPerMillion: 14 },
  'gpt-5.1': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gemini-2.0-flash': { inputPerMillion: 0.075, outputPerMillion: 0.3 },
};

const DEFAULT_CONTEXT_LIMIT = 128000;
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

export class TokenCounter {
  private model: string;
  private inputTokens: number;
  private outputTokens: number;
  private lastRequestInput = 0;

  public constructor(model: string) {
    this.model = model;
    this.inputTokens = 0;
    this.outputTokens = 0;
  }

  public setModel(model: string): void {
    this.model = model;
  }

  public getTotalInputTokens(): number {
    return this.inputTokens;
  }

  public getTotalOutputTokens(): number {
    return this.outputTokens;
  }

  public countTokens(text: string): number {
    if (!text) {
      return 0;
    }

    const cjkChars = text.match(CJK_PATTERN)?.length ?? 0;
    const nonCjkChars = Math.max(text.length - cjkChars, 0);

    const estimated = Math.ceil(nonCjkChars / 4 + cjkChars / 2);
    return Math.max(estimated, 0);
  }

  public addUsage(input: number, output: number): void {
    const inp = Math.max(0, Math.floor(input));
    const out = Math.max(0, Math.floor(output));
    this.inputTokens += inp;
    this.outputTokens += out;
    this.lastRequestInput = inp;
  }

  public getUsage(): TokenUsage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      estimatedCost: this.getEstimatedCost(),
    };
  }

  public getContextLimit(): number {
    return MODEL_CONTEXT_LIMITS[this.model] ?? DEFAULT_CONTEXT_LIMIT;
  }

  public getContextLimitFor(model: string): number {
    return MODEL_CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT;
  }

  public getUsagePercent(): number {
    const limit = this.getContextLimit();
    if (limit <= 0) return 0;
    if (this.lastRequestInput <= 0) return 0;
    return Math.min(this.lastRequestInput / limit, 1);
  }

  public getLastRequestInput(): number {
    return this.lastRequestInput;
  }

  public getEstimatedCost(model: string = this.model): number {
    const pricing = MODEL_PRICING_USD_PER_MILLION[model];
    if (!pricing) {
      return 0;
    }

    const inputCost = (this.inputTokens / 1_000_000) * pricing.inputPerMillion;
    const outputCost = (this.outputTokens / 1_000_000) * pricing.outputPerMillion;

    return Number((inputCost + outputCost).toFixed(6));
  }

  public shouldWarn(): boolean {
    return this.getUsagePercent() > 0.8;
  }

  public reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
  }
}
