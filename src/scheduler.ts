import cron from 'node-cron';
import { getYnabClient } from './ynab.js';
import { toUSD } from './utils.js';
import { isSmsConfigured, sendSms } from './sms.js';
import { loadConfig, type UserConfig } from './config.js';

async function buildMessage(user: UserConfig): Promise<string> {
  const api = getYnabClient();
  const budgetId = process.env.YNAB_BUDGET_ID ?? 'last-used';

  const now = new Date();
  const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: user.timezone });

  const response = await api.categories.getCategories(budgetId);
  const allCategories = response.data.category_groups.flatMap((g) => g.categories);

  const wanted = new Set(user.categories.map((c) => c.toLowerCase()));
  const matched = allCategories.filter((cat) => !cat.deleted && wanted.has(cat.name.toLowerCase()));

  const foundNames = new Set(matched.map((c) => c.name.toLowerCase()));
  for (const name of user.categories) {
    if (!foundNames.has(name.toLowerCase())) {
      console.warn(`[Scheduler] Category not found in YNAB for ${user.name}: "${name}"`);
    }
  }

  const ordered = user.categories
    .map((name) => matched.find((c) => c.name.toLowerCase() === name.toLowerCase()))
    .filter((c): c is NonNullable<typeof c> => c !== undefined);

  const { field, showGoalProgress, headerNote } = user.format;

  const lines = ordered.map((cat) => {
    const amount = field === 'budgeted' ? cat.budgeted : field === 'activity' ? cat.activity : cat.balance;
    const label = field === 'budgeted' ? 'budgeted' : field === 'activity' ? 'spent' : 'left';
    let line = `${cat.name}: ${toUSD(amount)} ${label}`;
    if (showGoalProgress && cat.goal_percentage_complete != null) {
      line += ` (${cat.goal_percentage_complete}% funded)`;
    }
    return line;
  });

  const header = headerNote ? `${headerNote}\n` : '';
  return `${header}YNAB – ${monthLabel} (${user.name})\n${lines.join('\n')}`;
}

async function runForUser(name: string, phone: string): Promise<void> {
  console.log(`[Scheduler] Firing for ${name}`);
  try {
    // Re-read config on each trigger so category/format changes take effect immediately
    const config = loadConfig();
    const user = config.users.find((u) => u.name === name);
    if (!user) {
      console.warn(`[Scheduler] User "${name}" not found in config — skipping`);
      return;
    }
    const message = await buildMessage(user);
    await sendSms(phone, message);
  } catch (err) {
    console.error(`[Scheduler] Error for ${name}:`, err);
  }
}

export function initScheduler(): void {
  if (!isSmsConfigured()) {
    console.log('[Scheduler] Twilio credentials not set — SMS notifications disabled');
    return;
  }

  const config = loadConfig();

  if (config.users.length === 0) {
    console.log('[Scheduler] No users configured — SMS notifications disabled');
    return;
  }

  for (const user of config.users) {
    if (!cron.validate(user.schedule)) {
      console.warn(`[Scheduler] Invalid schedule for ${user.name}: "${user.schedule}" — skipping`);
      continue;
    }
    // Capture name and phone at registration time; other fields are re-read on each trigger
    const { name, phone, schedule, timezone } = user;
    cron.schedule(schedule, () => { void runForUser(name, phone); }, { timezone });
    console.log(`[Scheduler] Registered: ${name} | schedule="${schedule}" | tz=${timezone} | categories=[${user.categories.join(', ')}]`);
  }
}
