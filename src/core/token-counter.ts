export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

export interface BudgetEvent {
  kind: 'warning' | 'exceeded';
  currentCostUsd: number;
  budgetMaxUsd: number;
  percentUsed: number;
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
  'gpt-4.1': { inputPerMillion: 2, outputPerMillion: 8 },
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10 },
  'gemini-2.0-flash': { inputPerMillion: 0.075, outputPerMillion: 0.3 },
};

const DEFAULT_CONTEXT_LIMIT = 128000;
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

const normalizeModelKey = (model: string): string => {
  for (const key of Object.keys(MODEL_PRICING_USD_PER_MILLION)) {
    if (model === key || model.startsWith(key)) {
      return key;
    }
  }
  // Strip date suffix (e.g. claude-opus-4-20250514 → claude-opus-4) and retry
  const stripped = model.replace(/-\d{8}$/, '');
  if (stripped !== model) {
    for (const key of Object.keys(MODEL_PRICING_USD_PER_MILLION)) {
      if (stripped === key || key.startsWith(stripped)) {
        return key;
      }
    }
  }
  return model;
};

export class TokenCounter {
  private model: string;
  private inputTokens: number;
  private outputTokens: number;
  private lastRequestInput = 0;
  private budgetMaxUsd: number | null = null;
  private warningThreshold = 0.8;
  private budgetCallbacks: Array<(event: BudgetEvent) => void> = [];
  private hasWarnedBudget = false;
  private hasExceededBudget = false;

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
    this.emitBudgetEventsIfNeeded();
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
    const key = normalizeModelKey(model);
    const pricing = MODEL_PRICING_USD_PER_MILLION[key];
    if (!pricing) {
      const defaultPricing = { inputPerMillion: 3, outputPerMillion: 15 };
      const inputCost = (this.inputTokens / 1_000_000) * defaultPricing.inputPerMillion;
      const outputCost = (this.outputTokens / 1_000_000) * defaultPricing.outputPerMillion;
      return Number((inputCost + outputCost).toFixed(6));
    }

    const inputCost = (this.inputTokens / 1_000_000) * pricing.inputPerMillion;
    const outputCost = (this.outputTokens / 1_000_000) * pricing.outputPerMillion;

    return Number((inputCost + outputCost).toFixed(6));
  }

  public shouldWarn(): boolean {
    return this.getUsagePercent() > 0.8;
  }

  public setBudget(maxCostUsd: number): void {
    this.budgetMaxUsd = Math.max(0, maxCostUsd);
    this.hasWarnedBudget = false;
    this.hasExceededBudget = false;
    this.emitBudgetEventsIfNeeded();
  }

  public clearBudget(): void {
    this.budgetMaxUsd = null;
    this.hasWarnedBudget = false;
    this.hasExceededBudget = false;
  }

  public isOverBudget(): boolean {
    if (this.budgetMaxUsd === null) {
      return false;
    }

    return this.getEstimatedCostUsd() > this.budgetMaxUsd;
  }

  public shouldWarnBudget(): boolean {
    if (this.budgetMaxUsd === null || this.budgetMaxUsd <= 0) {
      return false;
    }

    return this.getEstimatedCostUsd() / this.budgetMaxUsd >= this.warningThreshold;
  }

  public getRemainingBudgetUsd(): number | null {
    if (this.budgetMaxUsd === null) {
      return null;
    }

    const remaining = this.budgetMaxUsd - this.getEstimatedCostUsd();
    return Number(Math.max(0, remaining).toFixed(6));
  }

  public getEstimatedCostUsd(): number {
    return this.getEstimatedCost(this.model);
  }

  public onBudgetEvent(callback: (event: BudgetEvent) => void): void {
    this.budgetCallbacks.push(callback);
  }

  public reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.hasWarnedBudget = false;
    this.hasExceededBudget = false;
  }

  private emitBudgetEventsIfNeeded(): void {
    if (this.budgetMaxUsd === null || this.budgetMaxUsd <= 0) {
      return;
    }

    const currentCostUsd = this.getEstimatedCostUsd();
    const percentUsed = currentCostUsd / this.budgetMaxUsd;

    if (!this.hasWarnedBudget && percentUsed >= this.warningThreshold) {
      this.hasWarnedBudget = true;
      this.emitBudgetEvent({
        kind: 'warning',
        currentCostUsd,
        budgetMaxUsd: this.budgetMaxUsd,
        percentUsed,
      });
    }

    if (!this.hasExceededBudget && percentUsed > 1) {
      this.hasExceededBudget = true;
      this.emitBudgetEvent({
        kind: 'exceeded',
        currentCostUsd,
        budgetMaxUsd: this.budgetMaxUsd,
        percentUsed,
      });
    }
  }

  private emitBudgetEvent(event: BudgetEvent): void {
    for (const callback of this.budgetCallbacks) {
      callback(event);
    }
  }
}
