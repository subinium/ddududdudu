import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });

  return result.stdout.trim();
};

const hasChangesToCommit = async (cwd: string): Promise<boolean> => {
  const output = await runGit(cwd, ['status', '--porcelain']);
  return output.length > 0;
};

export const isGitRepo = async (cwd: string): Promise<boolean> => {
  try {
    await runGit(cwd, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
};

export const createCheckpoint = async (
  cwd: string,
  message: string
): Promise<string | null> => {
  const available = await isGitRepo(cwd);
  if (!available) {
    return null;
  }

  if (!(await hasChangesToCommit(cwd))) {
    return null;
  }

  const safeMessage = message.trim() || 'checkpoint';

  await runGit(cwd, ['add', '-A']);

  try {
    await runGit(cwd, ['commit', '-m', `ddudu: ${safeMessage}`]);
  } catch (err: unknown) {
    if (err instanceof Error && /nothing to commit/i.test(err.message)) {
      return null;
    }

    throw err;
  }

  return getLastCheckpointHash(cwd);
};

export const undoLastCheckpoint = async (cwd: string): Promise<boolean> => {
  if (!(await isGitRepo(cwd))) {
    return false;
  }

  try {
    await runGit(cwd, ['revert', 'HEAD', '--no-edit']);
    return true;
  } catch {
    return false;
  }
};

export const getLastCheckpointHash = async (cwd: string): Promise<string | null> => {
  if (!(await isGitRepo(cwd))) {
    return null;
  }

  try {
    const hash = await runGit(cwd, ['log', '-1', '--grep', '^ddudu:', '--format=%H']);
    return hash || null;
  } catch {
    return null;
  }
};

export class GitCheckpoint {
  private readonly cwd: string;

  public constructor(cwd: string) {
    this.cwd = cwd;
  }

  public async isAvailable(): Promise<boolean> {
    return isGitRepo(this.cwd);
  }

  public async checkpoint(message: string): Promise<string | null> {
    return createCheckpoint(this.cwd, message);
  }

  public async undo(): Promise<boolean> {
    return undoLastCheckpoint(this.cwd);
  }

  public async getLastHash(): Promise<string | null> {
    return getLastCheckpointHash(this.cwd);
  }

  public async getDiff(fromHash?: string): Promise<string> {
    if (!(await isGitRepo(this.cwd))) {
      return '';
    }

    try {
      if (fromHash) {
        return await runGit(this.cwd, ['diff', '--stat', `${fromHash}..HEAD`]);
      }

      return await runGit(this.cwd, ['diff', '--stat', 'HEAD~1..HEAD']);
    } catch {
      return '';
    }
  }
}
