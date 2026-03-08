import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SHARED_DIR_CANDIDATES = ['node_modules', '.venv', 'venv'];

export interface IsolatedWorkspace {
  id: string;
  label: string;
  path: string;
  repoRoot: string;
  baseCwd: string;
  kind: 'git-worktree';
}

export interface WorkspaceApplyResult {
  attempted: boolean;
  applied: boolean;
  empty: boolean;
  summary: string;
  error?: string;
}

const slugify = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'agent';
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });

  return stdout.trim();
};

const resolveRepoRoot = async (cwd: string): Promise<string | null> => {
  try {
    return await runGit(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
};

const linkSharedDependencyDirs = async (repoRoot: string, workspacePath: string): Promise<void> => {
  await Promise.all(
    SHARED_DIR_CANDIDATES.map(async (candidate) => {
      const source = resolve(repoRoot, candidate);
      const target = resolve(workspacePath, candidate);

      if (!(await exists(source)) || (await exists(target))) {
        return;
      }

      try {
        const stats = await lstat(source);
        const kind = stats.isDirectory() ? 'dir' : 'file';
        await symlink(source, target, kind === 'dir' ? 'dir' : 'file');
      } catch {
        // Best effort only. Missing shared dependencies should not block isolation.
      }
    }),
  );
};

export class WorktreeManager {
  private readonly rootCwd: string;
  private readonly storageDirName: string;

  public constructor(rootCwd: string = process.cwd(), storageDirName: string = '.ddudu/worktrees') {
    this.rootCwd = rootCwd;
    this.storageDirName = storageDirName;
  }

  public async isAvailable(baseCwd: string = this.rootCwd): Promise<boolean> {
    return (await resolveRepoRoot(baseCwd)) !== null;
  }

  public async create(
    label: string,
    options: { baseCwd?: string; ref?: string } = {},
  ): Promise<IsolatedWorkspace | null> {
    const baseCwd = resolve(options.baseCwd ?? this.rootCwd);
    const repoRoot = await resolveRepoRoot(baseCwd);
    if (!repoRoot) {
      return null;
    }

    const storageDir = resolve(repoRoot, this.storageDirName);
    await mkdir(storageDir, { recursive: true });

    const id = `${slugify(label).slice(0, 36)}-${randomUUID().slice(0, 8)}`;
    const workspacePath = resolve(storageDir, id);

    await runGit(repoRoot, ['worktree', 'add', '--detach', workspacePath, options.ref ?? 'HEAD']);
    await linkSharedDependencyDirs(repoRoot, workspacePath);

    return {
      id,
      label,
      path: workspacePath,
      repoRoot,
      baseCwd,
      kind: 'git-worktree',
    };
  }

  public async remove(workspace: IsolatedWorkspace): Promise<void> {
    try {
      await runGit(workspace.repoRoot, ['worktree', 'remove', '--force', workspace.path]);
    } catch {
      // Fall back to direct deletion if git cleanup fails.
    }

    await rm(workspace.path, { recursive: true, force: true });
  }

  public async applyToBase(workspace: IsolatedWorkspace): Promise<WorkspaceApplyResult> {
    try {
      await runGit(workspace.path, ['add', '--all']);
      const summary = await runGit(workspace.path, ['diff', '--cached', '--shortstat', 'HEAD', '--']);
      const { stdout: patch } = await execFileAsync(
        'git',
        ['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD', '--'],
        {
          cwd: workspace.path,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      if (!patch.trim()) {
        return {
          attempted: true,
          applied: false,
          empty: true,
          summary: summary || 'no workspace changes to apply',
        };
      }

      const patchDir = resolve(workspace.repoRoot, '.ddudu', 'tmp');
      await mkdir(patchDir, { recursive: true });
      const patchPath = resolve(patchDir, `${workspace.id}-apply.patch`);
      await writeFile(patchPath, patch, 'utf8');

      try {
        await runGit(workspace.repoRoot, ['apply', '--whitespace=nowarn', patchPath]);
      } finally {
        await rm(patchPath, { force: true });
      }

      return {
        attempted: true,
        applied: true,
        empty: false,
        summary: summary || 'applied workspace patch',
      };
    } catch (error: unknown) {
      return {
        attempted: true,
        applied: false,
        empty: false,
        summary: 'workspace patch apply failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
