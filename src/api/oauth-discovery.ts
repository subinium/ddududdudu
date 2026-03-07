import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL } from './anthropic-base-url.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const KEYCHAIN_TIMEOUT_MS = 3000;

interface ClaudeCredentialsPayload {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: string;
  };
}

export interface ResolvedToken {
  token: string;
  source: 'env-api-key' | 'env-oauth' | 'keychain' | 'credentials-file' | 'openrouter';
  baseUrl: string;
  expiresAt?: string;
}

const parseCredentialPayload = (raw: string): ClaudeCredentialsPayload | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const candidates: string[] = [trimmed];

  try {
    const parsedString = JSON.parse(trimmed);
    if (typeof parsedString === 'string' && parsedString.trim()) {
      candidates.push(parsedString.trim());
    }
  } catch {}

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as ClaudeCredentialsPayload;
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {}
  }

  return null;
};

const resolveFromCredentialPayload = (
  payload: ClaudeCredentialsPayload | null,
): { token: string; expiresAt?: string } | null => {
  const token = payload?.claudeAiOauth?.accessToken?.trim();
  if (!token) {
    return null;
  }

  const expiresAt = payload?.claudeAiOauth?.expiresAt?.trim();
  return expiresAt ? { token, expiresAt } : { token };
};

const resolveFromKeychain = async (): Promise<{ token: string; expiresAt?: string } | null> => {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS },
    );
    const payload = parseCredentialPayload(stdout);
    return resolveFromCredentialPayload(payload);
  } catch {
    return null;
  }
};

const resolveFromCredentialsFile = async (): Promise<{ token: string; expiresAt?: string } | null> => {
  if (process.platform !== 'linux') {
    return null;
  }

  const credentialsPath = join(homedir(), '.claude', '.credentials.json');

  try {
    const raw = await readFile(credentialsPath, 'utf8');
    const payload = parseCredentialPayload(raw);
    return resolveFromCredentialPayload(payload);
  } catch {
    return null;
  }
};

export const discoverToken = async (): Promise<ResolvedToken> => {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicApiKey) {
    return {
      token: anthropicApiKey,
      source: 'env-api-key',
      baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
    };
  }

  const oauthOverride = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (oauthOverride) {
    return {
      token: oauthOverride,
      source: 'env-oauth',
      baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
    };
  }

  const keychainToken = await resolveFromKeychain();
  if (keychainToken) {
    return {
      token: keychainToken.token,
      source: 'keychain',
      baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
      expiresAt: keychainToken.expiresAt,
    };
  }

  const credentialFileToken = await resolveFromCredentialsFile();
  if (credentialFileToken) {
    return {
      token: credentialFileToken.token,
      source: 'credentials-file',
      baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
      expiresAt: credentialFileToken.expiresAt,
    };
  }

  const openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterApiKey) {
    return {
      token: openRouterApiKey,
      source: 'openrouter',
      baseUrl: DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL,
    };
  }

  throw new Error(
    'No Anthropic token found. Set ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, OPENROUTER_API_KEY, or configure Claude Code credentials.',
  );
};
