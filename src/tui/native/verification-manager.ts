import {
  type VerificationMode,
  type VerificationProgress,
  VerificationRunner,
  type VerificationSummary,
} from '../../core/verifier.js';

export const runVerificationWithProgress = async (
  cwd: string,
  mode: Exclude<VerificationMode, 'none'>,
  onProgress?: (progress: VerificationProgress) => void,
): Promise<VerificationSummary> => {
  return new VerificationRunner(cwd).run(mode, onProgress);
};
