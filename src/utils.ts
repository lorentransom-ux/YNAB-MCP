import type { Category } from 'ynab';

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
