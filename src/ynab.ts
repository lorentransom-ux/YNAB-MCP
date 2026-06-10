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

// Drop expired entries so the cache doesn't accumulate dead keys over long
// uptimes (each distinct since_date mints a new key). Runs on a coarse timer and
// also lazily on read in cachedFetch.
function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of responseCache) {
    if (entry.expiresAt <= now) responseCache.delete(key);
  }
}

const cachePruneTimer = setInterval(pruneCache, 10 * 60 * 1000);
cachePruneTimer.unref?.();

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
  if (existing) responseCache.delete(key); // expired — evict before refetch
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

// Wraps any serializable value as an MCP text-content result.
export function jsonResult(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

// Shared handler shape for read-only YNAB tools: resolves the client and the
// `plan_id` default ("last-used"), runs the caller's logic under YNAB error
// handling, and serializes the returned value as an MCP text result. Collapses
// the boilerplate every tool would otherwise repeat.
export function ynabRead(
  args: { plan_id?: string } | undefined,
  build: (api: ynab.API, planId: string) => Promise<unknown>
): Promise<McpContent> {
  return withYnabErrorHandling(async () =>
    jsonResult(await build(getYnabClient(), args?.plan_id ?? 'last-used'))
  );
}
