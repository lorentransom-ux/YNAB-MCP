import cron from 'node-cron';
import { getYnabClient } from './ynab.js';
import { toUSD } from './utils.js';
import { isSmsConfigured, sendSms } from './sms.js';

interface UserConfig {
  name: string;
  phone: string;
  schedule: string;
  categories: string[];
  timezone: string;
}

function loadUserConfig(prefix: string): UserConfig | null {
  const name = process.env[`${prefix}_NAME`];
  const phone = process.env[`${prefix}_PHONE`];
  const schedule = process.env[`${prefix}_SCHEDULE`];
  const categoriesRaw = process.env[`${prefix}_CATEGORIES`];
  const timezone = process.env[`${prefix}_TIMEZONE`] ?? 'America/Chicago';

  if (!name || !phone || !schedule || !categoriesRaw) return null;

  const categories = categoriesRaw.split(',').map((c) => c.trim()).filter(Boolean);
  if (categories.length === 0) return null;

  if (!cron.validate(schedule)) {
    console.warn(`[Scheduler] Invalid cron expression for ${prefix}: "${schedule}" — skipping`);
    return null;
  }

  return { name, phone, schedule, categories, timezone };
}

async function buildMessage(user: UserConfig): Promise<string> {
  const api = getYnabClient();
  const budgetId = process.env.YNAB_BUDGET_ID ?? 'last-used';

  const now = new Date();
  const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: user.timezone });

  const response = await api.categories.getCategories(budgetId);
  const allCategories = response.data.category_groups.flatMap((g) => g.categories);

  const wanted = new Set(user.categories.map((c) => c.toLowerCase()));
  const matched = allCategories.filter(
    (cat) => !cat.deleted && wanted.has(cat.name.toLowerCase())
  );

  // Warn about any configured categories that weren't found
  const foundNames = new Set(matched.map((c) => c.name.toLowerCase()));
  for (const name of user.categories) {
    if (!foundNames.has(name.toLowerCase())) {
      console.warn(`[Scheduler] Category not found in YNAB for ${user.name}: "${name}"`);
    }
  }

  // Order lines to match the user's configured order
  const ordered = user.categories
    .map((name) => matched.find((c) => c.name.toLowerCase() === name.toLowerCase()))
    .filter((c): c is NonNullable<typeof c> => c !== undefined);

  const lines = ordered.map((cat) => `${cat.name}: ${toUSD(cat.balance)} left`);

  return `YNAB – ${monthLabel} (${user.name})\n${lines.join('\n')}`;
}

async function runForUser(user: UserConfig): Promise<void> {
  console.log(`[Scheduler] Firing for ${user.name}`);
  try {
    const message = await buildMessage(user);
    await sendSms(user.phone, message);
  } catch (err) {
    console.error(`[Scheduler] Error for ${user.name}:`, err);
  }
}

export function initScheduler(): void {
  if (!isSmsConfigured()) {
    console.log('[Scheduler] Twilio credentials not set — SMS notifications disabled');
    return;
  }

  const users = ['USER1', 'USER2']
    .map(loadUserConfig)
    .filter((u): u is UserConfig => u !== null);

  if (users.length === 0) {
    console.log('[Scheduler] No users configured — SMS notifications disabled');
    return;
  }

  for (const user of users) {
    cron.schedule(
      user.schedule,
      () => { void runForUser(user); },
      { timezone: user.timezone }
    );
    console.log(`[Scheduler] Registered: ${user.name} | schedule="${user.schedule}" | tz=${user.timezone} | categories=[${user.categories.join(', ')}]`);
  }
}
