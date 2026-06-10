import type { Category } from 'ynab';

export function toUSD(milliunits: number | null | undefined): string {
  const val = milliunits ?? 0;
  const abs = Math.abs(val / 1000);
  const formatted = abs.toFixed(2);
  return val < 0 ? `-$${formatted}` : `$${formatted}`;
}

// Returns the date `days` before now as YYYY-MM-DD. Used to bound otherwise
// unfiltered transaction fetches to a recent window by default.
export function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
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
  // Cadences 0, 1, 2, 13: period = cadence-type * frequency
  if (cadence === 0) return freq === 1 ? 'month' : `${freq} months`; // "None" type, treat as monthly
  if (cadence === 1) return freq === 1 ? 'month' : `${freq} months`;
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
