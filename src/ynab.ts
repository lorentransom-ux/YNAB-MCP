import * as ynab from 'ynab';

let client: ynab.API | undefined;

export function getYnabClient(): ynab.API {
  if (!client) {
    const token = process.env.YNAB_TOKEN;
    if (!token) {
      throw new Error('YNAB_TOKEN environment variable is not set.');
    }
    client = new ynab.API(token);
  }
  return client;
}

const DEFAULT_TTL_MS = 45_000;

interface CacheEntry {
  value: Promise<unknown>;
  expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();

// Short-TTL cache for read-only YNAB responses. Returns the in-flight promise
// for an unexpired key (de-duping concurrent identical fetches) and evicts on
// rejection so transient errors aren't cached. All YNAB tools are read-only, so
// there are no writes that would require invalidation.
export function cachedFetch<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS
): Promise<T> {
  const now = Date.now();
  const existing = responseCache.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.value as Promise<T>;
  }
  const value = fn();
  responseCache.set(key, { value, expiresAt: now + ttlMs });
  value.catch(() => {
    const current = responseCache.get(key);
    if (current && current.value === value) responseCache.delete(key);
  });
  return value;
}

interface YnabErrorBody {
  error: { id: string; name?: string; detail?: string };
}

function isYnabError(err: unknown): err is YnabErrorBody {
  return (
    err !== null &&
    typeof err === 'object' &&
    'error' in err &&
    err.error !== null &&
    typeof (err as Record<string, unknown>).error === 'object' &&
    'id' in (err as YnabErrorBody).error
  );
}

export function handleYnabError(err: unknown): string {
  if (isYnabError(err)) {
    const { id, detail, name } = err.error;
    const msg = detail ?? name ?? 'Unknown YNAB error';
    if (id === '401') {
      return (
        'YNAB authentication failed. Your YNAB token may be invalid or expired. ' +
        'Regenerate it at app.ynab.com/settings/developer.'
      );
    }
    if (id === '404') {
      return (
        `YNAB resource not found: ${msg}. ` +
        "Verify that the IDs you're using (plan_id, account_id, category_id, etc.) are correct."
      );
    }
    return `YNAB API error (${id}): ${msg}`;
  }
  if (err instanceof Error) {
    return `Error: ${err.message}`;
  }
  return `Unexpected error: ${String(err)}`;
}

type McpContent = { content: [{ type: 'text'; text: string }]; isError?: true };

export async function withYnabErrorHandling<T extends McpContent>(
  fn: () => Promise<T>
): Promise<T | McpContent> {
  try {
    return await fn();
  } catch (err) {
    return {
      content: [{ type: 'text', text: handleYnabError(err) }],
      isError: true,
    };
  }
}
