import type { Category } from 'ynab';

// Inverse of toUSD for write tools: dollars (e.g. -12.34) → milliunits (-12340).
export function toMilliunits(dollars: number): number {
  return Math.round(dollars * 1000);
}

export function toUSD(milliunits: number | null | undefined): string {
  const val = milliunits ?? 0;
  const abs = Math.abs(val / 1000);
  const formatted = abs.toFixed(2);
  return val < 0 ? `-$${formatted}` : `$${formatted}`;
}

// Telegram-facing money formatter. Negatives use accounting parentheses with a
// red down-triangle marker (Telegram cannot render colored text, so the emoji
// stands in for "red"). Positives render plainly, identical to toUSD. Used only
// for digest, alert, and chat-context strings — NOT for MCP tool outputs, which
// are structured data consumed by the desktop client and keep the plain "-$" form.
export function toUSDDisplay(milliunits: number | null | undefined): string {
  const val = milliunits ?? 0;
  const abs = (Math.abs(val) / 1000).toFixed(2);
  return val < 0 ? `🔻 ($${abs})` : `$${abs}`;
}

// Normalizes a YNAB category name for tolerant matching: strips emoji, variation
// selectors, and zero-width joiners, collapses whitespace, and lowercases. So a
// stored alert/digest name like "Coffee Shops" matches the real YNAB category
// "☕️ Coffee Shops". Returns '' for an emoji-only name (no usable text to match).
export function normalizeCategoryName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\p{Extended_Pictographic}\u200D\uFE0F]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Finds a category by name, preferring an exact (case-insensitive) match and
// falling back to the emoji-tolerant normalized form. Exact-first keeps existing
// behavior and limits the chance of two distinct categories colliding. Skips
// deleted categories. Shared by the alert engine and the digest scheduler.
export function findCategoryByName<T extends { name: string; deleted?: boolean }>(
  categories: T[],
  name: string
): T | undefined {
  const live = categories.filter((c) => !c.deleted);
  const target = name.toLowerCase();
  const exact = live.find((c) => c.name.toLowerCase() === target);
  if (exact) return exact;
  const norm = normalizeCategoryName(name);
  if (!norm) return undefined;
  return live.find((c) => normalizeCategoryName(c.name) === norm);
}

// Matches a trailing day-of-month range such as "1st–7th" or "1st - 7th".
const DAY_RANGE_SUFFIX = /^(.*\S)\s+(\d{1,2})(?:st|nd|rd|th)?\s*[–-]\s*(\d{1,2})(?:st|nd|rd|th)?$/;

// Finds the weekly split of a category that covers the given day of month, e.g.
// a stored "Eating Out" resolves to "🍔 Eating Out 1st–7th" on the 3rd. With no
// day given, returns the first split found (used to validate a base name).
export function findWeeklyCategory<T extends { name: string; deleted?: boolean }>(
  categories: T[],
  name: string,
  day?: number
): T | undefined {
  const base = normalizeCategoryName(name);
  if (!base) return undefined;
  for (const c of categories) {
    if (c.deleted) continue;
    const m = DAY_RANGE_SUFFIX.exec(normalizeCategoryName(c.name));
    if (!m || m[1] !== base) continue;
    if (day === undefined || (day >= Number(m[2]) && day <= Number(m[3]))) return c;
  }
  return undefined;
}

// Resolves a stored alert/digest category name for a scheduled run: exact or
// emoji-tolerant match first, then the weekly split covering today in timeZone.
export function resolveScheduledCategory<T extends { name: string; deleted?: boolean }>(
  categories: T[],
  name: string,
  timeZone: string
): T | undefined {
  const day = Number(new Date().toLocaleDateString('en-US', { timeZone, day: 'numeric' }));
  return findCategoryByName(categories, name) ?? findWeeklyCategory(categories, name, day);
}

// Day of month (1-31) for "now" in the given IANA timezone.
export function dayOfMonthInTz(timeZone: string): number {
  return Number(new Date().toLocaleDateString('en-US', { timeZone, day: 'numeric' }));
}

// Loose form used for partial matching: emoji-tolerant normalization plus
// punctuation flattened to spaces, so "8th-15th" matches "8th–15th".
function looseCategoryName(name: string): string {
  return normalizeCategoryName(name)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Splits a category name into its base and day-of-month range, if it has one.
function dayRangeOf(name: string): { base: string; from: number; to: number } | undefined {
  const m = DAY_RANGE_SUFFIX.exec(normalizeCategoryName(name));
  return m ? { base: looseCategoryName(m[1]), from: Number(m[2]), to: Number(m[3]) } : undefined;
}

// Every category a loosely worded name could mean: the exact (emoji-tolerant)
// match alone if there is one, otherwise every category whose name has a word
// starting with each query word. Matching is by word start, not anywhere in the
// name, so "1st" matches "1st–7th" but not "24th–31st". Unlike
// resolveCategoryQuery this keeps all day-range splits, so "eating out" returns
// all four "Eating Out ..." categories. Hidden categories are only returned
// when no visible category matches.
export function matchCategoriesByWords<
  T extends { name: string; deleted?: boolean; hidden?: boolean },
>(categories: T[], query: string): T[] {
  const live = categories.filter((c) => !c.deleted);
  const exact = findCategoryByName(live, query);
  if (exact) return [exact];
  const words = looseCategoryName(query).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const hits = live.filter((c) => {
    const nameWords = looseCategoryName(c.name).split(' ');
    return words.every((w) => nameWords.some((n) => n.startsWith(w)));
  });
  const visible = hits.filter((c) => !c.hidden);
  return visible.length > 0 ? visible : hits;
}

export type CategoryResolution<T> =
  // One category selected. `via` says how; `siblings` are the other day-range
  // splits of the same base name (empty unless via is 'day_range').
  | { kind: 'one'; category: T; via: 'exact' | 'partial' | 'day_range'; day?: number; siblings: T[] }
  | { kind: 'ambiguous'; candidates: T[] }
  | { kind: 'none'; suggestions: T[] };

// Resolves a loosely worded category name to exactly one category, or reports
// why it could not. Never guesses between unrelated categories:
//   1. exact / emoji-tolerant name match
//   2. unique partial match (every word of the query appears in the name)
//   3. day-range splits ("Eating Out 1st–7th", "Eating Out 8th–15th", ...):
//      picks the split covering `day`; a number in the query ("eating out 10")
//      overrides `day`
// Anything else is 'ambiguous' (several unrelated matches) or 'none'.
// Hidden categories are only considered when no visible category matches.
export function resolveCategoryQuery<
  T extends { name: string; deleted?: boolean; hidden?: boolean },
>(categories: T[], query: string, day: number): CategoryResolution<T> {
  const live = categories.filter((c) => !c.deleted);

  const exact = findCategoryByName(live, query);
  if (exact) return { kind: 'one', category: exact, via: 'exact', siblings: [] };

  const loose = looseCategoryName(query);
  const tokens = loose.split(' ').filter(Boolean);
  if (tokens.length === 0) return { kind: 'none', suggestions: [] };

  const preferVisible = (list: T[]): T[] => {
    const visible = list.filter((c) => !c.hidden);
    return visible.length > 0 ? visible : list;
  };
  const containsAll = (words: string[]) =>
    preferVisible(
      live.filter((c) => {
        const n = looseCategoryName(c.name);
        return words.every((w) => n.includes(w));
      })
    );

  const partial = containsAll(tokens);
  if (partial.length === 1) {
    return { kind: 'one', category: partial[0], via: 'partial', siblings: [] };
  }

  // Several (or zero) matches: see whether they are day-range splits of one base.
  // A bare day number in the query selects the split instead of today's date.
  const dayTokenIndex = tokens.findIndex((t) => /^\d{1,2}(st|nd|rd|th)?$/.test(t));
  const queryDay = dayTokenIndex >= 0 ? parseInt(tokens[dayTokenIndex], 10) : undefined;
  const baseTokens = dayTokenIndex >= 0 ? tokens.filter((_, i) => i !== dayTokenIndex) : tokens;
  // With a day number, look at the whole family (the number itself may only
  // appear in some splits' names, e.g. "3" in "23rd"); otherwise use the matches.
  const pool =
    baseTokens.length > 0 && (dayTokenIndex >= 0 || partial.length === 0)
      ? containsAll(baseTokens)
      : partial;

  const ranges = pool.map((c) => ({ c, r: dayRangeOf(c.name) }));
  const sameFamily =
    pool.length > 1 &&
    ranges.every((x) => x.r !== undefined && x.r.base === ranges[0].r?.base);

  if (sameFamily) {
    const pickDay = queryDay ?? day;
    const hit = ranges.find((x) => x.r && pickDay >= x.r.from && pickDay <= x.r.to);
    if (hit) {
      return {
        kind: 'one',
        category: hit.c,
        via: 'day_range',
        day: pickDay,
        siblings: pool.filter((c) => c !== hit.c),
      };
    }
    return { kind: 'ambiguous', candidates: pool };
  }

  const rest = partial.length > 0 ? partial : pool;
  if (rest.length > 1) return { kind: 'ambiguous', candidates: rest };
  if (rest.length === 1) {
    return { kind: 'one', category: rest[0], via: 'partial', siblings: [] };
  }

  // Nothing matched every word; suggest categories that match any meaningful word.
  const words = baseTokens.filter((t) => t.length >= 3);
  const suggestions = preferVisible(
    live.filter((c) => {
      const n = looseCategoryName(c.name);
      return words.some((w) => n.includes(w));
    })
  );
  return { kind: 'none', suggestions };
}

// When a transaction tool is called without since_date, bound the otherwise
// full-history fetch to this many days back.
export const DEFAULT_SINCE_DAYS = 90;

// Returns the date `days` before now as YYYY-MM-DD (UTC). Used to bound otherwise
// unfiltered transaction fetches to a recent window by default.
export function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// Like daysAgo, but anchored to the current calendar date in the given IANA
// timezone rather than UTC, so a "last N days" window lines up with the user's
// day near midnight instead of being off by one.
export function daysAgoInTz(days: number, timeZone: string): string {
  // en-CA renders as YYYY-MM-DD, which we treat as a UTC midnight to do date math.
  const today = new Date().toLocaleDateString('en-CA', { timeZone });
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function resolveMonth(month: string): string {
  if (month === 'current') {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
  }
  return month;
}

function cadencePeriod(cadence: number | undefined, frequency: number | undefined): string {
  const freq = frequency ?? 1;
  // Cadences 0, 1, 2, 13: period = cadence-type * frequency.
  // Cadence 0 is "None" — treated as monthly, same as cadence 1.
  if (cadence === 0 || cadence === 1) return freq === 1 ? 'month' : `${freq} months`;
  if (cadence === 2) return freq === 1 ? 'week' : `${freq} weeks`;
  if (cadence === 13) return freq === 1 ? 'year' : `${freq} years`;
  // Cadences 3-12: fixed monthly multiples (cadence N = every (N-1) months)
  if (cadence !== undefined && cadence >= 3 && cadence <= 12) {
    const months = cadence - 1;
    return `${months} months`;
  }
  // Cadence 14: every 2 years
  if (cadence === 14) return '2 years';
  return 'month';
}

export interface GoalFields {
  goal_summary: string;
  goal_percentage_complete: number | null;
  goal_under_funded: string | null;
  goal_overall_funded: string | null;
  goal_overall_left: string | null;
  goal_snoozed_at: string | null;
}

// Drops null/undefined values so responses carry only fields that have data.
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
  ) as Partial<T>;
}

export function buildGoalFields(cat: Category): GoalFields {
  const gt = cat.goal_type;
  const target = toUSD(cat.goal_target);
  let goal_summary: string;

  if (gt == null) {
    goal_summary = 'No goal';
  } else if (gt === 'TB') {
    goal_summary = `Target balance of ${target}`;
  } else if (gt === 'TBD') {
    goal_summary = `Target balance of ${target} by ${cat.goal_target_date ?? 'unknown date'}`;
  } else if (gt === 'MF') {
    const period = cadencePeriod(cat.goal_cadence, cat.goal_cadence_frequency);
    goal_summary = `Fund ${target} every ${period}`;
  } else if (gt === 'NEED') {
    const style = cat.goal_needs_whole_amount ? 'Set Aside' : 'Refill';
    goal_summary = `Spend ${target} per period (${style})`;
  } else if (gt === 'DEBT') {
    // Loan-paired categories (mortgage, auto loan). The target is the payment.
    if (cat.goal_target != null && cat.goal_target > 0) {
      const period = cadencePeriod(cat.goal_cadence, cat.goal_cadence_frequency);
      goal_summary = `Debt payment of ${target} every ${period}`;
    } else {
      goal_summary = 'Debt payment goal (YNAB returned no target amount)';
    }
  } else {
    goal_summary = `Unknown goal type: ${gt}`;
  }

  return {
    goal_summary,
    goal_percentage_complete: cat.goal_percentage_complete ?? null,
    goal_under_funded: cat.goal_under_funded != null ? toUSD(cat.goal_under_funded) : null,
    goal_overall_funded: cat.goal_overall_funded != null ? toUSD(cat.goal_overall_funded) : null,
    goal_overall_left: cat.goal_overall_left != null ? toUSD(cat.goal_overall_left) : null,
    goal_snoozed_at: cat.goal_snoozed_at ?? null,
  };
}
