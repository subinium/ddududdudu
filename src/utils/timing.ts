interface TimingCheckpoint {
  label: string;
  deltaMs: number;
  totalMs: number;
}

const TIMING_ENABLED = process.env.DDUDU_TIMING === '1';
const startedAt = TIMING_ENABLED ? Date.now() : 0;
let previousTimestamp = startedAt;
const checkpoints: TimingCheckpoint[] = [];

export const time = (label: string): void => {
  if (!TIMING_ENABLED) {
    return;
  }

  const now = Date.now();
  checkpoints.push({
    label,
    deltaMs: now - previousTimestamp,
    totalMs: now - startedAt,
  });
  previousTimestamp = now;
};

export const printTimings = (): void => {
  if (!TIMING_ENABLED) {
    return;
  }

  for (const checkpoint of checkpoints) {
    process.stderr.write(
      `[DDUDU] [TIMING] ${checkpoint.label}: +${checkpoint.deltaMs}ms (${checkpoint.totalMs}ms)\n`,
    );
  }
};
