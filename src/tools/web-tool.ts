import type { Tool } from './index.js';

const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 50 * 1024;

const truncateUtf8 = (text: string, maxBytes: number): { text: string; truncated: boolean } => {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }

  const sliced = encoded.subarray(0, maxBytes).toString('utf8');
  return { text: `${sliced}\n[truncated]`, truncated: true };
};

const stripHtml = (input: string): string => {
  return input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
};

export const webFetchTool: Tool = {
  definition: {
    name: 'web_fetch',
    description: 'Fetch a URL with HTTP GET and return text content.',
    parameters: {
      url: { type: 'string', description: 'URL to fetch.', required: true },
    },
  },
  async execute(args) {
    if (typeof args.url !== 'string' || args.url.trim().length === 0) {
      return { output: 'Missing required argument: url', isError: true };
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, TIMEOUT_MS);

    try {
      const response = await fetch(args.url, {
        method: 'GET',
        signal: abortController.signal,
      });

      const raw = await response.text();
      const cleaned = stripHtml(raw);
      const { text, truncated } = truncateUtf8(cleaned, MAX_BODY_BYTES);

      return {
        output: text,
        isError: !response.ok,
        metadata: {
          status: response.status,
          url: response.url,
          truncated,
        },
      };
    } catch (err: unknown) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  },
};
