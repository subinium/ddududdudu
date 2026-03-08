import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface DduduPaths {
  globalDir: string;
  globalConfig: string;
  globalPrompts: string;
  globalRules: string;
  globalHooks: string;
  globalSkills: string;
  globalSessions: string;
  globalJobs: string;
  globalAuth: string;
  globalInstructions: string;
  projectDir: string;
  projectConfig: string;
  projectPrompts: string;
  projectRules: string;
  projectHooks: string;
  projectInstructions: string;
  projectSessions: string;
  projectJobs: string;
}

export const getDduduPaths = (cwd?: string): DduduPaths => {
  const home = homedir();
  const projectRoot = cwd ?? process.cwd();

  const globalDir = resolve(home, '.ddudu');
  const projectDir = resolve(projectRoot, '.ddudu');

  return {
    globalDir,
    globalConfig: resolve(globalDir, 'config.yaml'),
    globalPrompts: resolve(globalDir, 'prompts'),
    globalRules: resolve(globalDir, 'rules'),
    globalHooks: resolve(globalDir, 'hooks'),
    globalSkills: resolve(globalDir, 'skills'),
    globalSessions: resolve(globalDir, 'sessions'),
    globalJobs: resolve(globalDir, 'jobs'),
    globalAuth: resolve(globalDir, 'auth.json'),
    globalInstructions: resolve(globalDir, 'DDUDU.md'),
    projectDir,
    projectConfig: resolve(projectDir, 'config.yaml'),
    projectPrompts: resolve(projectDir, 'prompts'),
    projectRules: resolve(projectDir, 'rules'),
    projectHooks: resolve(projectDir, 'hooks'),
    projectInstructions: resolve(projectDir, 'DDUDU.md'),
    projectSessions: resolve(projectDir, 'sessions'),
    projectJobs: resolve(projectDir, 'jobs'),
  };
};

export const ensureGlobalDirs = async (): Promise<void> => {
  const paths = getDduduPaths();

  await Promise.all([
    mkdir(paths.globalDir, { recursive: true }),
    mkdir(paths.globalPrompts, { recursive: true }),
    mkdir(paths.globalRules, { recursive: true }),
    mkdir(paths.globalHooks, { recursive: true }),
    mkdir(paths.globalSkills, { recursive: true }),
    mkdir(paths.globalSessions, { recursive: true }),
    mkdir(paths.globalJobs, { recursive: true }),
  ]);
};

export const ensureProjectDirs = async (cwd?: string): Promise<void> => {
  const paths = getDduduPaths(cwd);

  await Promise.all([
    mkdir(paths.projectDir, { recursive: true }),
    mkdir(paths.projectPrompts, { recursive: true }),
    mkdir(paths.projectRules, { recursive: true }),
    mkdir(paths.projectHooks, { recursive: true }),
  ]);
};
