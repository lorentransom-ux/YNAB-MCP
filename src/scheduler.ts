import cron, { type ScheduledTask } from 'node-cron';
import { getYnabClient, cachedFetch } from './ynab.js';
import { toUSDDisplay } from './utils.js';
import { isTelegramConfigured, sendTelegram } from './telegram.js';
import { loadConfig, type UserConfig } from './config.js';

// Tracks active cron tasks by user name so they can be stopped and replaced
const activeTasks = new Map<string, ScheduledTask>();

async function buildMessage(user: UserConfig): Promise<string> {
  const api = getYnabClient();
  const budgetId = process.env.YNAB_BUDGET_ID ?? 'last-used';

  const now = new Date();
  const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: user.timezone });

  const response = await cachedFetch(
    `categories:${budgetId}`,
    () => api.categories.getCategories(budgetId)
  );
  const allCategories = response.data.category_groups.flatMap((g) => g.categories);

  const byName = new Map<string, (typeof allCategories)[number]>();
  for (const cat of allCategories) {
    if (!cat.deleted) byName.set(cat.name.toLowerCase(), cat);
  }

  const ordered: typeof allCategories = [];
  for (const name of user.categories) {
    const cat = byName.get(name.toLowerCase());
    if (cat) ordered.push(cat);
    else console.warn(`[Scheduler] Category not found in YNAB for ${user.name}: "${name}"`);
  }

  const { field, showGoalProgress, headerNote } = user.format;

  const lines = ordered.map((cat) => {
    const amount = field === 'budgeted' ? cat.budgeted : field === 'activity' ? cat.activity : cat.balance;
    const label = field === 'budgeted' ? 'budgeted' : field === 'activity' ? 'spent' : 'left';
    let line = `${cat.name}: ${toUSDDisplay(amount)} ${label}`;
    if (showGoalProgress && cat.goal_percentage_complete != null) {
      line += ` (${cat.goal_percentage_complete}% funded)`;
    }
    return line;
  });

  const header = headerNote ? `${headerNote}\n` : '';
  return `${header}YNAB – ${monthLabel} (${user.name})\n${lines.join('\n')}`;
}

async function runForUser(name: string, chatId: number): Promise<void> {
  console.log(`[Scheduler] Firing for ${name}`);
  try {
    const config = loadConfig();
    const user = config.users.find((u) => u.name === name);
    if (!user) {
      console.warn(`[Scheduler] User "${name}" not found in config — skipping`);
      return;
    }
    const message = await buildMessage(user);
    await sendTelegram(chatId, message);
  } catch (err) {
    console.error(`[Scheduler] Error for ${name}:`, err);
  }
}

function registerTask(user: UserConfig): void {
  const { name, telegramChatId, schedule, timezone } = user;
  if (telegramChatId === undefined) {
    console.warn(`[Scheduler] No telegramChatId for ${name} — skipping (can't deliver digest)`);
    return;
  }
  const task = cron.schedule(schedule, () => { void runForUser(name, telegramChatId); }, { timezone });
  activeTasks.set(name, task);
  console.log(`[Scheduler] Registered: ${name} | schedule="${schedule}" | tz=${timezone} | categories=[${user.categories.join(', ')}]`);
}

// Re-register a single user's cron task after their config changes (e.g. via the
// ynab_update_config chat tool), so schedule/timezone edits take effect immediately.
export function refreshUserSchedule(userName: string): void {
  const existing = activeTasks.get(userName);
  if (existing) {
    existing.stop();
    activeTasks.delete(userName);
  }

  if (!isTelegramConfigured()) return;

  const config = loadConfig();
  const user = config.users.find((u) => u.name === userName);
  if (!user) return;

  if (!cron.validate(user.schedule)) {
    console.warn(`[Scheduler] Invalid schedule for ${user.name}: "${user.schedule}" — not registering`);
    return;
  }

  registerTask(user);
}

export function initScheduler(): void {
  if (!isTelegramConfigured()) {
    console.log('[Scheduler] TELEGRAM_BOT_TOKEN not set — scheduled digests disabled');
    return;
  }

  const config = loadConfig();

  if (config.users.length === 0) {
    console.log('[Scheduler] No users configured — scheduled digests disabled');
    return;
  }

  for (const user of config.users) {
    if (!cron.validate(user.schedule)) {
      console.warn(`[Scheduler] Invalid schedule for ${user.name}: "${user.schedule}" — skipping`);
      continue;
    }
    registerTask(user);
  }
}
