import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GEMINI_OAUTH_CLIENT_ID = process.env.GEMINI_OAUTH_CLIENT_ID?.trim() ?? '';
const GEMINI_OAUTH_CLIENT_SECRET = process.env.GEMINI_OAUTH_CLIENT_SECRET?.trim() ?? '';

interface GeminiOauthFile {
  access_token?: string;
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
  expiry_date?: string | number;
  expires_at?: string | number;
}

interface GeminiRefreshResponse {
  access_token?: string;
  expires_in?: number;
}

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
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) {
      return parseExpiryMs(numberValue);
    }

    const dateValue = Date.parse(value);
    if (Number.isFinite(dateValue)) {
      return dateValue;
    }
  }

  return null;
};

const tokenExpired = (value: unknown): boolean => {
  const expiryMs = parseExpiryMs(value);
  if (expiryMs === null) {
    return false;
  }

  return expiryMs <= Date.now() + 60_000;
};

const readOauthFile = async (): Promise<GeminiOauthFile | null> => {
  const oauthPath = join(homedir(), '.gemini', 'oauth_creds.json');
  try {
    const raw = await readFile(oauthPath, 'utf8');
    const parsed = JSON.parse(raw) as GeminiOauthFile;
    return parsed;
  } catch (err: unknown) {
    void err;
    return null;
  }
};

const refreshGeminiAccessToken = async (
  refreshToken: string,
  clientId?: string,
  clientSecret?: string,
): Promise<string | null> => {
  const resolvedClientId = clientId?.trim() || GEMINI_OAUTH_CLIENT_ID;
  const resolvedClientSecret = clientSecret?.trim() || GEMINI_OAUTH_CLIENT_SECRET;
  if (!resolvedClientId || !resolvedClientSecret) {
    return null;
  }

  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', refreshToken);
  params.set('client_id', resolvedClientId);
  params.set('client_secret', resolvedClientSecret);

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      return null;
    }

    const parsed = (await response.json()) as GeminiRefreshResponse;
    const accessToken = parsed.access_token?.trim();
    return accessToken && accessToken.length > 0 ? accessToken : null;
  } catch (err: unknown) {
    void err;
    return null;
  }
};

export const discoverGeminiToken = async (): Promise<{
  token: string;
  source: string;
  tokenType: 'apikey' | 'oauth';
} | null> => {
  const googleApiKey = process.env.GOOGLE_API_KEY?.trim();
  if (googleApiKey) {
    return {
      token: googleApiKey,
      source: 'env:GOOGLE_API_KEY',
      tokenType: 'apikey',
    };
  }

  const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiApiKey) {
    return {
      token: geminiApiKey,
      source: 'env:GEMINI_API_KEY',
      tokenType: 'apikey',
    };
  }

  const oauthFile = await readOauthFile();
  if (!oauthFile) {
    return null;
  }

  const accessToken = oauthFile.access_token?.trim() ?? '';
  const refreshToken = oauthFile.refresh_token?.trim() ?? '';
  const expiresAt = oauthFile.expiry_date ?? oauthFile.expires_at;

  if (accessToken && !tokenExpired(expiresAt)) {
    return {
      token: accessToken,
      source: 'gemini-oauth-file',
      tokenType: 'oauth',
    };
  }

  if (refreshToken) {
    const refreshed = await refreshGeminiAccessToken(
      refreshToken,
      oauthFile.client_id,
      oauthFile.client_secret,
    );
    if (refreshed) {
      return {
        token: refreshed,
        source: 'gemini-oauth-file:refresh',
        tokenType: 'oauth',
      };
    }
  }

  if (accessToken) {
    return {
      token: accessToken,
      source: 'gemini-oauth-file:stale',
      tokenType: 'oauth',
    };
  }

  return null;
};
