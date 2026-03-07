import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';

import { getDduduPaths } from './dirs.js';

export interface SkillMetadata {
  name: string;
  description: string;
  globs?: string[];
  path: string;
}

export interface LoadedSkill extends SkillMetadata {
  content: string;
  mcpConfig?: Record<string, unknown>;
}

interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const toStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const output = value.filter((entry: unknown): entry is string => {
    return typeof entry === 'string' && entry.trim().length > 0;
  });

  return output.length > 0 ? output : undefined;
};

const parseMarkdownFrontmatter = (content: string): ParsedMarkdown => {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) {
    return {
      frontmatter: {},
      body: content,
    };
  }

  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(match[1] ?? '') as unknown;
    if (isObject(parsed)) {
      frontmatter = parsed;
    }
  } catch (err: unknown) {
    frontmatter = {};
  }

  return {
    frontmatter,
    body: content.slice(match[0].length),
  };
};

const pathToPosix = (input: string): string => {
  return input.replace(/\\/g, '/');
};

const globToRegExp = (glob: string): RegExp => {
  const normalized = pathToPosix(glob).replace(/^\.\//, '');
  if (normalized.length === 0) {
    return /^.*$/;
  }

  let pattern = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? '';
    const next = normalized[index + 1] ?? '';
    const afterNext = normalized[index + 2] ?? '';

    if (char === '*' && next === '*') {
      if (afterNext === '/') {
        pattern += '(?:.*/)?';
        index += 2;
        continue;
      }

      pattern += '.*';
      index += 1;
      continue;
    }

    if (char === '*') {
      pattern += '[^/]*';
      continue;
    }

    if (char === '?') {
      pattern += '[^/]';
      continue;
    }

    pattern += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }

  return new RegExp(`^${pattern}$`);
};

const normalizeCandidatePath = (cwd: string, filePath: string): string => {
  const normalized = pathToPosix(filePath);
  const normalizedCwd = pathToPosix(cwd);

  if (normalized.startsWith('/')) {
    if (normalized === normalizedCwd) {
      return '';
    }

    if (normalized.startsWith(`${normalizedCwd}/`)) {
      return normalized.slice(normalizedCwd.length + 1);
    }
  }

  return normalized.replace(/^\.\//, '');
};

export class SkillLoader {
  private readonly cwd: string;
  private readonly skills = new Map<string, SkillMetadata>();
  private readonly loadedSkills = new Map<string, LoadedSkill>();
  private readonly globCache = new Map<string, RegExp>();

  public constructor(cwd: string) {
    this.cwd = cwd;
  }

  public async scan(): Promise<void> {
    this.skills.clear();
    this.loadedSkills.clear();

    const dduduPaths = getDduduPaths(this.cwd);
    const scanDirs = [
      dduduPaths.globalSkills,
      resolve(this.cwd, '.ddudu/skills'),
      resolve(this.cwd, '.agents/skills'),
      resolve(this.cwd, '.claude/skills'),
      resolve(homedir(), '.claude/skills'),
    ];

    for (const skillsDir of scanDirs) {
      const entries = await this.readSkillDirs(skillsDir);
      for (const entry of entries) {
        const skillFile = resolve(skillsDir, entry, 'SKILL.md');
        const metadata = await this.readMetadata(skillFile, entry);
        if (!metadata) {
          continue;
        }

        if (!this.skills.has(metadata.name)) {
          this.skills.set(metadata.name, metadata);
        }
      }
    }
  }

  public list(): SkillMetadata[] {
    return Array.from(this.skills.values());
  }

  public get(name: string): SkillMetadata | undefined {
    return this.skills.get(name);
  }

  public async load(name: string): Promise<LoadedSkill | null> {
    const existing = this.loadedSkills.get(name);
    if (existing) {
      return existing;
    }

    const metadata = this.skills.get(name);
    if (!metadata) {
      return null;
    }

    let fileContent = '';
    try {
      fileContent = await readFile(metadata.path, 'utf8');
    } catch {
      return null;
    }

    const parsed = parseMarkdownFrontmatter(fileContent);
    const loadedSkill: LoadedSkill = {
      ...metadata,
      content: parsed.body,
    };

    const mcpConfig = await this.loadMcpConfig(metadata.path);
    if (mcpConfig) {
      loadedSkill.mcpConfig = mcpConfig;
    }

    this.loadedSkills.set(name, loadedSkill);
    return loadedSkill;
  }

  public getMatchingSkills(filePaths: string[]): SkillMetadata[] {
    const normalizedPaths = filePaths
      .map((filePath: string) => normalizeCandidatePath(this.cwd, filePath))
      .filter((filePath: string) => filePath.length > 0);

    return this.list().filter((skill: SkillMetadata) => {
      if (!skill.globs || skill.globs.length === 0) {
        return true;
      }

      return skill.globs.some((glob: string) => {
        const matcher = this.getGlobMatcher(glob);
        return normalizedPaths.some((filePath: string) => matcher.test(filePath));
      });
    });
  }

  public toToolDefinitions(): Array<{ name: string; description: string }> {
    return this.list().map((skill: SkillMetadata) => ({
      name: skill.name,
      description: skill.description,
    }));
  }

  private async readSkillDirs(skillsDir: string): Promise<string[]> {
    try {
      const entries = await readdir(skillsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private async readMetadata(skillFilePath: string, fallbackName: string): Promise<SkillMetadata | null> {
    let content = '';
    try {
      content = await readFile(skillFilePath, 'utf8');
    } catch {
      return null;
    }

    const parsed = parseMarkdownFrontmatter(content);
    const nameValue = parsed.frontmatter.name;
    const descriptionValue = parsed.frontmatter.description;
    const globsValue = parsed.frontmatter.globs;

    const name = typeof nameValue === 'string' && nameValue.trim().length > 0
      ? nameValue.trim()
      : fallbackName;

    const description = typeof descriptionValue === 'string' ? descriptionValue.trim() : '';

    return {
      name,
      description,
      globs: toStringArray(globsValue),
      path: skillFilePath,
    };
  }

  private async loadMcpConfig(skillFilePath: string): Promise<Record<string, unknown> | undefined> {
    const configPath = resolve(dirname(skillFilePath), 'mcp.json');

    let raw = '';
    try {
      raw = await readFile(configPath, 'utf8');
    } catch {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return isObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private getGlobMatcher(glob: string): RegExp {
    const cached = this.globCache.get(glob);
    if (cached) {
      return cached;
    }

    const matcher = globToRegExp(glob);
    this.globCache.set(glob, matcher);
    return matcher;
  }
}
