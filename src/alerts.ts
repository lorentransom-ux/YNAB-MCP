import cron, { type ScheduledTask } from 'node-cron';
import { getYnabClient, cachedFetch } from './ynab.js';
import { toUSDDisplay, findCategoryByName } from './utils.js';
import { isTelegramConfigured, sendTelegram } from './telegram.js';
import { loadConfig, setThresholdState, type Threshold } from './config.js';

// Tracks active alert cron tasks by user name. One task per user, fired a few
// times a day (in the user's timezone); each run reloads config so thresholds
// added via chat take effect without re-registering the task.
const activeAlertTasks = new Map<string, ScheduledTask>();

// Run alert checks at 8am, 1pm, and 7pm local time — "a few times a day".
const ALERT_SCHEDULE = '0 8,13,19 * * *';

function conditionMet(balanceDollars: number, threshold: Threshold): boolean {
  return threshold.direction === 'at_or_above'
    ? balanceDollars >= threshold.amount
    : balanceDollars <= threshold.amount;
}

function alertMessage(categoryName: string, balanceMilli: number, threshold: Threshold): string {
  const verb = threshold.direction === 'at_or_above' ? 'at or above' : 'at or below';
  return `⚠️ ${categoryName} is at ${toUSDDisplay(balanceMilli)} — ${verb} your $${threshold.amount.toFixed(2)} alert.`;
}

// Checks one user's thresholds against current YNAB balances and sends a Telegram
// alert for each newly-crossed threshold. Uses per-threshold `triggered` dedupe so
// the user gets one message per crossing, re-arming only after the balance recovers.
async function checkUserThresholds(userName: string): Promise<void> {
  const config = loadConfig();
  const user = config.users.find((u) => u.name.toLowerCase() === userName.toLowerCase());
  if (!user) return;
  if (user.telegramChatId === undefined) return;
  if (!user.thresholds || user.thresholds.length === 0) return;

  const api = getYnabClient();
  const budgetId = process.env.YNAB_BUDGET_ID ?? 'last-used';

  const response = await cachedFetch(
    `categories:${budgetId}`,
    () => api.categories.getCategories(budgetId)
  );
  const allCategories = response.data.category_groups.flatMap((g) => g.categories);

  for (const threshold of user.thresholds) {
    // Emoji-tolerant: a stored "Coffee Shops" matches YNAB's "☕️ Coffee Shops".
    const cat = findCategoryByName(allCategories, threshold.category);
    if (!cat) {
      console.warn(`[Alerts] Category not found in YNAB for ${user.name}: "${threshold.category}"`);
      continue;
    }

    const balanceMilli = cat.balance ?? 0;
    const met = conditionMet(balanceMilli / 1000, threshold);
    const wasTriggered = threshold.triggered ?? false;

    if (met && !wasTriggered) {
      try {
        await sendTelegram(user.telegramChatId, alertMessage(cat.name, balanceMilli, threshold));
        await setThresholdState(user.name, threshold.category, true);
      } catch {
        // sendTelegram already logged; leave triggered=false so we retry next run.
      }
    } else if (!met && wasTriggered) {
      // Balance recovered past the threshold — re-arm so the next crossing notifies.
      await setThresholdState(user.name, threshold.category, false);
    }
  }
}

function runCheck(userName: string): void {
  console.log(`[Alerts] Checking thresholds for ${userName}`);
  void checkUserThresholds(userName).catch((err) =>
    console.error(`[Alerts] Error for ${userName}:`, err instanceof Error ? err.message : err)
  );
}

export function initAlerts(): void {
  if (!isTelegramConfigured()) {
    console.log('[Alerts] TELEGRAM_BOT_TOKEN not set — threshold alerts disabled');
    return;
  }

  const config = loadConfig();
  // Register a task for every user with a chat ID, even if they have no thresholds
  // yet — a threshold added later via chat is picked up on the next scheduled run.
  for (const user of config.users) {
    if (user.telegramChatId === undefined) continue;
    const existing = activeAlertTasks.get(user.name);
    if (existing) existing.stop();
    const task = cron.schedule(ALERT_SCHEDULE, () => { runCheck(user.name); }, { timezone: user.timezone });
    activeAlertTasks.set(user.name, task);
    console.log(`[Alerts] Registered: ${user.name} | schedule="${ALERT_SCHEDULE}" | tz=${user.timezone}`);
  }
}
