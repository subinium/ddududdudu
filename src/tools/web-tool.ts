import type { Tool } from './index.js';

const TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 60 * 1024;
const DEFAULT_MAX_RESULTS = 5;
const USER_AGENT = 'ddudu/0.2 web tools';

const BLOCK_TAGS = /<\/?(?:article|aside|blockquote|br|div|h[1-6]|header|hr|li|main|ol|p|pre|section|table|tbody|td|th|thead|tr|ul)[^>]*>/gi;
const CHROME_TAGS = /<(script|style|svg|noscript|iframe|nav|footer|header|form|button|input|select|textarea)[^>]*>[\s\S]*?<\/\1>/gi;

const decodeHtmlEntities = (input: string): string =>
  input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

const normalizeWhitespace = (input: string): string =>
  input
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

const truncateUtf8 = (text: string, maxBytes: number): { text: string; truncated: boolean } => {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }

  const sliced = encoded.subarray(0, maxBytes).toString('utf8');
  return { text: `${sliced.trimEnd()}\n\n[truncated]`, truncated: true };
};

const stripTags = (input: string): string =>
  decodeHtmlEntities(
    input
      .replace(CHROME_TAGS, ' ')
      .replace(BLOCK_TAGS, '\n')
      .replace(/<[^>]*>/g, ' '),
  );

const extractTagText = (html: string, pattern: RegExp): string | null => {
  const match = pattern.exec(html);
  if (!match?.[1]) {
    return null;
  }

  const value = normalizeWhitespace(stripTags(match[1]));
  return value.length > 0 ? value : null;
};

const extractBodyHtml = (html: string): string => {
  const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (article?.[1]) {
    return article[1];
  }

  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (main?.[1]) {
    return main[1];
  }

  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (body?.[1]) {
    return body[1];
  }

  return html;
};

export const extractReadableContent = (
  raw: string,
  contentType?: string | null,
): {
  kind: 'html' | 'json' | 'text';
  title: string | null;
  description: string | null;
  body: string;
} => {
  const normalizedType = contentType?.toLowerCase() ?? '';
  const looksLikeHtml = normalizedType.includes('text/html') || /<html[\s>]/i.test(raw);
  const looksLikeJson = normalizedType.includes('json') || /^[\s\n]*[{[]/.test(raw);

  if (looksLikeJson) {
    try {
      const parsed = JSON.parse(raw);
      return {
        kind: 'json',
        title: null,
        description: null,
        body: JSON.stringify(parsed, null, 2),
      };
    } catch {
      // fall through to text
    }
  }

  if (!looksLikeHtml) {
    return {
      kind: 'text',
      title: null,
      description: null,
      body: normalizeWhitespace(raw),
    };
  }

  const title = extractTagText(raw, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description =
    extractTagText(raw, /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i)
    ?? extractTagText(raw, /<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i);
  const body = normalizeWhitespace(stripTags(extractBodyHtml(raw)));

  return {
    kind: 'html',
    title,
    description,
    body,
  };
};

const buildFetchOutput = (
  url: string,
  status: number,
  contentType: string | null,
  extracted: ReturnType<typeof extractReadableContent>,
  truncated: boolean,
): string => {
  const lines = [
    `URL: ${url}`,
    `Status: ${status}`,
    `Content-Type: ${contentType ?? extracted.kind}`,
    extracted.title ? `Title: ${extracted.title}` : null,
    extracted.description ? `Summary: ${extracted.description}` : null,
    truncated ? 'Note: body truncated to fit context budget.' : null,
    '',
    extracted.body,
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
};

const unwrapDuckDuckGoUrl = (href: string): string => {
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : parsed.toString();
  } catch {
    return href;
  }
};

export interface ParsedSearchResult {
  title: string;
  url: string;
  snippet: string | null;
}

export const parseDuckDuckGoResults = (html: string, maxResults: number): ParsedSearchResult[] => {
  const results: ParsedSearchResult[] = [];
  const pattern =
    /<div class="result[^"]*"[\s\S]*?<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>(?:[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|[\s\S]*?<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi;

  for (const match of html.matchAll(pattern)) {
    const href = match[1];
    const title = normalizeWhitespace(stripTags(match[2] ?? ''));
    const snippet = normalizeWhitespace(stripTags(match[3] ?? match[4] ?? ''));
    if (!href || !title) {
      continue;
    }

    results.push({
      title,
      url: unwrapDuckDuckGoUrl(href),
      snippet: snippet || null,
    });

    if (results.length >= maxResults) {
      break;
    }
  }

  return results;
};

const createAbortSignal = (): { signal: AbortSignal; cancel: () => void } => {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, TIMEOUT_MS);

  return {
    signal: abortController.signal,
    cancel: () => clearTimeout(timeoutId),
  };
};

const fetchText = async (url: string): Promise<{ response: Response; text: string }> => {
  const { signal, cancel } = createAbortSignal();
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    return {
      response,
      text: await response.text(),
    };
  } finally {
    cancel();
  }
};

const parseMaxBytes = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(4 * 1024, Math.min(256 * 1024, Math.floor(value)));
};

export const webFetchTool: Tool = {
  definition: {
    name: 'web_fetch',
    description: 'Fetch a URL and return readable or raw content with a bounded body budget.',
    parameters: {
      url: { type: 'string', description: 'URL to fetch.', required: true },
      extract: {
        type: 'string',
        description: 'How to shape the fetched page.',
        enum: ['auto', 'readable', 'raw'],
      },
      max_bytes: {
        type: 'number',
        description: 'Maximum UTF-8 bytes to keep from the body.',
      },
    },
  },
  async execute(args) {
    if (typeof args.url !== 'string' || args.url.trim().length === 0) {
      return { output: 'Missing required argument: url', isError: true };
    }

    try {
      const { response, text } = await fetchText(args.url);
      const extractMode =
        typeof args.extract === 'string' && ['auto', 'readable', 'raw'].includes(args.extract)
          ? args.extract
          : 'auto';
      const extracted = extractMode === 'raw'
        ? {
            kind: 'text' as const,
            title: null,
            description: null,
            body: normalizeWhitespace(text),
          }
        : extractReadableContent(text, response.headers.get('content-type'));
      const maxBytes = parseMaxBytes(args.max_bytes, DEFAULT_MAX_BODY_BYTES);
      const effectiveBody = truncateUtf8(extracted.body, maxBytes);

      return {
        output: buildFetchOutput(
          response.url,
          response.status,
          response.headers.get('content-type'),
          { ...extracted, body: effectiveBody.text },
          effectiveBody.truncated,
        ),
        isError: !response.ok,
        metadata: {
          status: response.status,
          url: response.url,
          contentType: response.headers.get('content-type'),
          mode: extractMode,
          kind: extracted.kind,
          title: extracted.title,
          truncated: effectiveBody.truncated,
          maxBytes,
        },
      };
    } catch (err: unknown) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};

export const webSearchTool: Tool = {
  definition: {
    name: 'web_search',
    description: 'Search the web and return concise ranked results with titles, URLs, and snippets.',
    parameters: {
      query: { type: 'string', description: 'Search query.', required: true },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return.',
      },
      site: {
        type: 'string',
        description: 'Optional domain filter such as example.com.',
      },
    },
  },
  async execute(args) {
    if (typeof args.query !== 'string' || args.query.trim().length === 0) {
      return { output: 'Missing required argument: query', isError: true };
    }

    const maxResults =
      typeof args.max_results === 'number' && Number.isFinite(args.max_results)
        ? Math.max(1, Math.min(8, Math.floor(args.max_results)))
        : DEFAULT_MAX_RESULTS;

    try {
      const query = args.query.trim();
      const site = typeof args.site === 'string' && args.site.trim().length > 0 ? args.site.trim() : null;
      const effectiveQuery = site ? `${query} site:${site}` : query;
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(effectiveQuery)}`;
      const { response, text } = await fetchText(url);
      const results = parseDuckDuckGoResults(text, maxResults);

      if (results.length === 0) {
        return {
          output: `Search query: ${effectiveQuery}\nNo results parsed.`,
          isError: !response.ok,
          metadata: {
            status: response.status,
            query,
            effectiveQuery,
            site,
            count: 0,
          },
        };
      }

      const lines = [
        `Search query: ${effectiveQuery}`,
        `Results: ${results.length}`,
        '',
        ...results.flatMap((result, index) => [
          `${index + 1}. ${result.title}`,
          `   URL: ${result.url}`,
          result.snippet ? `   ${result.snippet}` : null,
          '',
        ].filter((line): line is string => Boolean(line))),
      ];

      return {
        output: lines.join('\n').trim(),
        isError: !response.ok,
        metadata: {
          status: response.status,
          query,
          effectiveQuery,
          site,
          count: results.length,
          results,
        },
      };
    } catch (err: unknown) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
