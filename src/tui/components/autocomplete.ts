import { PINK_BG, RESET, WHITE, visibleLength } from '../colors.js';

const MAX_VISIBLE_ITEMS = 8;

export interface AutocompleteItem {
  name: string;
  description: string;
  value: string;
}

interface RankedItem {
  item: AutocompleteItem;
  score: number;
}

const fuzzyScore = (text: string, query: string): number => {
  if (query.length === 0) {
    return 1;
  }

  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  if (hay.startsWith(needle)) {
    return 1000 - (hay.length - needle.length);
  }

  let score = 0;
  let hIdx = 0;
  let consecutive = 0;

  for (let nIdx = 0; nIdx < needle.length; nIdx += 1) {
    const ch = needle[nIdx];
    const found = hay.indexOf(ch, hIdx);
    if (found < 0) {
      return -1;
    }

    if (found === hIdx) {
      consecutive += 1;
      score += 20 + consecutive;
    } else {
      consecutive = 0;
      score += 5;
    }

    hIdx = found + 1;
  }

  return score - (hay.length - needle.length);
};

const clampWidth = (text: string, width: number): string => {
  if (width <= 0) {
    return '';
  }

  let output = '';
  for (const ch of text) {
    if (visibleLength(output + ch) > width) {
      break;
    }
    output += ch;
  }

  return output;
};

const padVisible = (text: string, width: number): string => {
  const truncated = clampWidth(text, width);
  const gap = Math.max(0, width - visibleLength(truncated));
  return truncated + ' '.repeat(gap);
};

export class AutocompletePopup {
  private readonly sourceItems: AutocompleteItem[];
  private filtered: AutocompleteItem[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;

  public isVisible = false;

  public constructor(items: AutocompleteItem[]) {
    this.sourceItems = [...items];
    this.filtered = [...items];
  }

  public update(filter: string): void {
    const normalized = filter.trim();
    const ranked: RankedItem[] = this.sourceItems
      .map((item) => {
        const score = Math.max(
          fuzzyScore(item.name, normalized),
          fuzzyScore(item.value, normalized),
          fuzzyScore(item.description, normalized),
        );

        return { item, score };
      })
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));

    this.filtered = ranked.map((entry) => entry.item);
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.isVisible = this.filtered.length > 0;
  }

  public moveUp(): void {
    if (!this.isVisible || this.filtered.length === 0) {
      return;
    }

    this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
    this.ensureSelectionVisible();
  }

  public moveDown(): void {
    if (!this.isVisible || this.filtered.length === 0) {
      return;
    }

    this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
    this.ensureSelectionVisible();
  }

  public select(): AutocompleteItem | null {
    if (!this.isVisible || this.filtered.length === 0) {
      return null;
    }

    return this.filtered[this.selectedIndex] ?? null;
  }

  public dismiss(): void {
    this.isVisible = false;
  }

  public render(startRow: number, startCol: number, maxWidth: number): string[] {
    if (!this.isVisible || this.filtered.length === 0) {
      return [];
    }

    const safeWidth = Math.max(20, maxWidth);
    const visibleCount = Math.min(MAX_VISIBLE_ITEMS, this.filtered.length);
    const result: string[] = [];

    for (let i = 0; i < visibleCount; i += 1) {
      const sourceIndex = this.scrollOffset + i;
      const item = this.filtered[sourceIndex];
      if (!item) {
        continue;
      }

      const left = `/${item.name}`;
      const plain = `${left}  ${item.description}`;
      const padded = padVisible(plain, safeWidth);
      const plainClamped = clampWidth(plain, safeWidth);
      const isSelected = sourceIndex === this.selectedIndex;
      const rendered = isSelected
        ? `${PINK_BG}${WHITE}${padVisible(plainClamped, safeWidth)}${RESET}`
        : padded;

      const row = startRow + i;
      result.push(`\u001b[${row};${startCol}H${rendered}`);
    }

    return result;
  }

  private ensureSelectionVisible(): void {
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
      return;
    }

    const maxVisibleIndex = this.scrollOffset + MAX_VISIBLE_ITEMS - 1;
    if (this.selectedIndex > maxVisibleIndex) {
      this.scrollOffset = this.selectedIndex - MAX_VISIBLE_ITEMS + 1;
    }
  }
}
