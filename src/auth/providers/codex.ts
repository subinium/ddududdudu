import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const KEYCHAIN_TIMEOUT_MS = 3000;

interface OAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface CodexTokens {
  access_token?: string;
  refresh_token?: string;
  expires_at?: string | number;
  expiresAt?: string | number;
}

interface CodexAuthFile {
  auth_mode?: string;
  api_key?: string;
  refresh_token?: string;
  tokens?: CodexTokens;
  client_id?: string;
  client_secret?: string;
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const parseExpiryMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return value;
    }

    if (value > 1_000_000_000) {
      return value * 1000;
    }
  }

  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return parseExpiryMs(asNumber);
    }

    const parsedDate = Date.parse(value);
    if (Number.isFinite(parsedDate)) {
      return parsedDate;
    }
  }

  return null;
};

const shouldRefreshToken = (expiresAt: unknown): boolean => {
  const expiryMs = parseExpiryMs(expiresAt);
  if (expiryMs === null) {
    return false;
  }

  return expiryMs <= Date.now() + 60_000;
};

const refreshOpenAiAccessToken = async (
  refreshToken: string,
  clientId?: string,
  clientSecret?: string,
): Promise<string | null> => {
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', refreshToken);
  if (clientId && clientId.trim()) {
    params.set('client_id', clientId.trim());
  }
  if (clientSecret && clientSecret.trim()) {
    params.set('client_secret', clientSecret.trim());
  }

  try {
    const response = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      return null;
    }

    const parsed = (await response.json()) as OAuthTokenResponse;
    const token = parsed.access_token?.trim();
    return token && token.length > 0 ? token : null;
  } catch (err: unknown) {
    void err;
    return null;
  }
};

const readAuthFile = async (): Promise<CodexAuthFile | null> => {
  const codexHome = process.env.CODEX_HOME?.trim();
  const authPath = codexHome ? join(codexHome, 'auth.json') : join(homedir(), '.codex', 'auth.json');

  try {
    const raw = await readFile(authPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    return parsed as CodexAuthFile;
  } catch (err: unknown) {
    void err;
    return null;
  }
};

const extractHashedKeyToken = (payload: unknown): string | null => {
  if (!isRecord(payload)) {
    return null;
  }

  for (const [key, value] of Object.entries(payload)) {
    if (!/^[a-f0-9]{64}$/i.test(key)) {
      continue;
    }

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (isRecord(value)) {
      for (const nestedValue of Object.values(value)) {
        if (typeof nestedValue === 'string' && nestedValue.trim()) {
          return nestedValue.trim();
        }
      }
    }
  }

  return null;
};

const discoverFromKeychain = async (): Promise<{
  token: string;
  source: string;
  tokenType: 'apikey' | 'bearer';
} | null> => {
  if (process.platform !== 'darwin') {
    return null;
  }

  const accountCandidates = ['default', 'auth', 'chatgpt', 'codex'];
  const codexHome = process.env.CODEX_HOME?.trim() ?? join(homedir(), '.codex');
  const hashed = createHash('sha256').update(codexHome).digest('hex');
  accountCandidates.push(hashed);

  for (const account of accountCandidates) {
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', 'Codex Auth', '-a', account, '-w'],
        { timeout: KEYCHAIN_TIMEOUT_MS },
      );

      const trimmed = stdout.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isRecord(parsed)) {
          const apiKey = typeof parsed.api_key === 'string' ? parsed.api_key.trim() : '';
          if (apiKey) {
            return { token: apiKey, source: `keychain:${account}`, tokenType: 'apikey' };
          }

          const accessToken =
            isRecord(parsed.tokens) && typeof parsed.tokens.access_token === 'string'
              ? parsed.tokens.access_token.trim()
              : typeof parsed.access_token === 'string'
                ? parsed.access_token.trim()
                : '';

          if (accessToken) {
            return { token: accessToken, source: `keychain:${account}`, tokenType: 'bearer' };
          }

          const hashedToken = extractHashedKeyToken(parsed);
          if (hashedToken) {
            return { token: hashedToken, source: `keychain:${account}`, tokenType: 'bearer' };
          }
        }
      } catch (err: unknown) {
        void err;
      }

      return {
        token: trimmed,
        source: `keychain:${account}`,
        tokenType: trimmed.startsWith('sk-') ? 'apikey' : 'bearer',
      };
    } catch (err: unknown) {
      void err;
    }
  }

  return null;
};

export const discoverCodexToken = async (): Promise<{
  token: string;
  source: string;
  tokenType: 'apikey' | 'bearer';
} | null> => {
  const envToken = process.env.OPENAI_API_KEY?.trim();
  if (envToken) {
    return {
      token: envToken,
      source: 'env:OPENAI_API_KEY',
      tokenType: 'apikey',
    };
  }

  const authFile = await readAuthFile();
  if (authFile) {
    const mode = authFile.auth_mode?.trim().toLowerCase();
    if (mode === 'apikey') {
      const apiKey = authFile.api_key?.trim() ?? '';
      if (apiKey) {
        return {
          token: apiKey,
          source: 'codex-auth-file:apikey',
          tokenType: 'apikey',
        };
      }
    }

    if (mode === 'chatgpt') {
      const accessToken = authFile.tokens?.access_token?.trim() ?? '';
      const refreshToken = authFile.tokens?.refresh_token?.trim() ?? authFile.refresh_token?.trim() ?? '';
      const expiresAt = authFile.tokens?.expires_at ?? authFile.tokens?.expiresAt;

      if (accessToken && !shouldRefreshToken(expiresAt)) {
        return {
          token: accessToken,
          source: 'codex-auth-file:chatgpt',
          tokenType: 'bearer',
        };
      }

      if (refreshToken) {
        const refreshed = await refreshOpenAiAccessToken(
          refreshToken,
          authFile.client_id,
          authFile.client_secret,
        );
        if (refreshed) {
          return {
            token: refreshed,
            source: 'codex-auth-file:chatgpt-refresh',
            tokenType: 'bearer',
          };
        }
      }

      if (accessToken) {
        return {
          token: accessToken,
          source: 'codex-auth-file:chatgpt-stale',
          tokenType: 'bearer',
        };
      }
    }
  }

  const keychainToken = await discoverFromKeychain();
  if (keychainToken) {
    return keychainToken;
  }

  return null;
};
