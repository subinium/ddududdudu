import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getStoredProviderAuth } from '../store.js';

const execFileAsync = promisify(execFile);
const KEYCHAIN_TIMEOUT_MS = 1500;

interface ClaudeCredentialsPayload {
  claudeAiOauth?: {
    accessToken?: string;
  };
}

interface ClaudeTokenDiscovery {
  token: string;
  source: string;
}

const isClaudeOAuthToken = (value: string): boolean => {
  return value.startsWith('sk-ant-oat01-');
};

const parseCredentialPayload = (raw: string): ClaudeCredentialsPayload | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const candidates: string[] = [trimmed];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string' && parsed.trim()) {
      candidates.push(parsed.trim());
    }
  } catch (err: unknown) {
    void err;
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as ClaudeCredentialsPayload;
      return parsed;
    } catch (err: unknown) {
      void err;
    }
  }

  return null;
};

const discoverFromSubprocess = async (): Promise<ClaudeTokenDiscovery | null> => {
  try {
    const { stdout } = await execFileAsync('claude', ['auth', 'token'], {
      timeout: KEYCHAIN_TIMEOUT_MS,
    });
    const token = stdout.trim();
    if (!token || !isClaudeOAuthToken(token)) {
      return null;
    }

    return { token, source: 'claude-cli' };
  } catch (err: unknown) {
    void err;
    return null;
  }
};

const discoverFromKeychain = async (): Promise<ClaudeTokenDiscovery | null> => {
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
    const token = payload?.claudeAiOauth?.accessToken?.trim() ?? '';
    if (!token || !isClaudeOAuthToken(token)) {
      return null;
    }

    return { token, source: 'macos-keychain' };
  } catch (err: unknown) {
    void err;
    return null;
  }
};

const discoverFromCredentialsFile = async (): Promise<ClaudeTokenDiscovery | null> => {
  const credentialsPath = join(homedir(), '.claude', '.credentials.json');

  try {
    const raw = await readFile(credentialsPath, 'utf8');
    const payload = parseCredentialPayload(raw);
    const token = payload?.claudeAiOauth?.accessToken?.trim() ?? '';
    if (!token || !isClaudeOAuthToken(token)) {
      return null;
    }

    return { token, source: 'credentials-file' };
  } catch (err: unknown) {
    void err;
    return null;
  }
};

export const discoverClaudeToken = async (): Promise<{ token: string; source: string } | null> => {
  const envToken = process.env.ANTHROPIC_API_KEY?.trim();
  if (envToken) {
    return { token: envToken, source: 'env:ANTHROPIC_API_KEY' };
  }

  const stored = await getStoredProviderAuth('claude');
  if (stored?.token) {
    return { token: stored.token, source: stored.source };
  }

  const subprocessToken = await discoverFromSubprocess();
  if (subprocessToken) {
    return subprocessToken;
  }

  const keychainToken = await discoverFromKeychain();
  if (keychainToken) {
    return keychainToken;
  }

  const fileToken = await discoverFromCredentialsFile();
  if (fileToken) {
    return fileToken;
  }

  return null;
};
