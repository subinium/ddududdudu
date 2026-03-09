export function load(input: string): unknown;

export function dump(
  input: unknown,
  options?: {
    noRefs?: boolean;
    lineWidth?: number;
    quotingType?: '"' | "'";
  },
): string;
