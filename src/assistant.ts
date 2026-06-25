import Anthropic from '@anthropic-ai/sdk';
import { getYnabClient, cachedFetch } from './ynab.js';
import { toUSDDisplay, daysAgoInTz, normalizeCategoryName, findCategoryByName } from './utils.js';
import {
  applyConfigUpdate,
  addThreshold,
  removeThreshold,
  listThresholds,
  type ConfigUpdate,
  type Threshold,
  type UserConfig,
} from './config.js';
import { refreshUserSchedule } from './scheduler.js';

// Module-level client — instantiated once, reused for every inbound Telegram message.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Tool that lets a user edit their own weekly digest settings by chatting with the
// bot. It carries no "user" parameter — the executor binds it to the authenticated
// caller, so a user can only ever change their own config.
const CONFIG_TOOL: Anthropic.Tool = {
  name: 'ynab_update_config',
  description:
    "Update the user's own weekly budget digest settings. Use when they ask to change which " +
    'categories appear in their digest, when it is sent, its timezone, or how amounts are shown. ' +
    'categories is a FULL replacement list — to add or remove one, send the complete new list ' +
    "(the user's current categories are in the system prompt). Only include fields being changed.",
  input_schema: {
    type: 'object',
    properties: {
      categories: {
        type: 'array',
        items: { type: 'string' },
        description: 'Full replacement list of YNAB category names to show in the digest',
      },
      schedule: {
        type: 'string',
        description: 'Cron expression for when the digest sends, e.g. "0 9 * * 5" = Friday 9am',
      },
      timezone: {
        type: 'string',
        description: 'IANA timezone name, e.g. "America/Chicago"',
      },
      format_field: {
        type: 'string',
        enum: ['balance', 'budgeted', 'activity'],
        description: 'Which amount to show per category: balance (remaining), budgeted, or activity (spent)',
      },
      show_goal_progress: {
        type: 'boolean',
        description: 'Whether to append goal funding percentage for categories that have a goal',
      },
      header_note: {
        type: 'string',
        description: 'Custom note prepended to the digest, or empty string to remove it',
      },
    },
  },
};

// Tool that lets a user manage proactive balance alerts by chatting with the bot.
// Like CONFIG_TOOL it carries no "user" parameter — the executor binds it to the
// authenticated caller, so a user can only manage their own alerts.
const ALERTS_TOOL: Anthropic.Tool = {
  name: 'ynab_manage_alerts',
  description:
    "Manage the user's proactive balance alerts. Use 'add' when they want to be notified " +
    'when a category crosses an amount (e.g. "tell me when Coffee Shops gets to $15 or below" → ' +
    "add Coffee Shops at 15 at_or_below). Use 'remove' to stop an alert, and 'list' to show " +
    "current alerts. The user's current alerts are in the system prompt.",
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'remove', 'list'],
        description: 'What to do: add or replace an alert, remove one, or list all alerts',
      },
      category: {
        type: 'string',
        description: 'YNAB category name the alert is for (required for add and remove)',
      },
      amount: {
        type: 'number',
        description: 'Dollar threshold to alert on, e.g. 15 (required for add)',
      },
      direction: {
        type: 'string',
        enum: ['at_or_below', 'at_or_above'],
        description: 'Notify when the remaining balance is at_or_below (default) or at_or_above the amount',
      },
    },
    required: ['action'],
  },
};

interface AlertToolInput {
  action?: 'add' | 'remove' | 'list';
  category?: string;
  amount?: number;
  direction?: Threshold['direction'];
}

function formatThreshold(t: Threshold): string {
  const verb = t.direction === 'at_or_above' ? '≥' : '≤';
  return `${t.category} ${verb} $${t.amount.toFixed(2)}`;
}

// Resolves a user-supplied category name against the live YNAB categories. On a hit
// returns the canonical category (so we store the real name, e.g. "☕️ Coffee Shops",
// which the cron alert engine then matches exactly). On a miss returns a few close
// suggestions so the caller can tell the user instead of saving an alert that would
// never fire because the category name was mistyped.
async function resolveCategory(
  name: string
): Promise<{ category: { name: string } } | { suggestions: string[] }> {
  const api = getYnabClient();
  const budgetId = process.env.YNAB_BUDGET_ID ?? 'last-used';
  const response = await cachedFetch(
    `categories:${budgetId}`,
    () => api.categories.getCategories(budgetId)
  );
  const allCategories = response.data.category_groups.flatMap((g) => g.categories);

  const match = findCategoryByName(allCategories, name);
  if (match) return { category: match };

  // No match — offer up to 5 visible categories that share a word with the query.
  const words = normalizeCategoryName(name).split(' ').filter(Boolean);
  const suggestions = allCategories
    .filter((c) => !c.deleted && !c.hidden)
    .map((c) => ({ name: c.name, overlap: words.filter((w) => normalizeCategoryName(c.name).includes(w)).length }))
    .filter((c) => c.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 5)
    .map((c) => c.name);
  return { suggestions };
}

// Executes the alerts tool for a fixed user. Returns a short result string fed
// back to the model. No cron refresh needed — the alert job reloads config each run.
async function runAlertTool(userName: string, input: unknown): Promise<string> {
  const { action, category, amount, direction } = (input ?? {}) as AlertToolInput;

  if (action === 'list') {
    const alerts = listThresholds(userName);
    if (alerts.length === 0) return 'No alerts are set.';
    return `Current alerts: ${alerts.map(formatThreshold).join('; ')}.`;
  }

  if (action === 'add') {
    if (!category) return 'A category is required to add an alert.';
    if (amount === undefined || !Number.isFinite(amount)) return 'A dollar amount is required to add an alert.';

    // Verify the category exists in YNAB before saving, so a mistyped name surfaces
    // immediately rather than as a silently-missing notification later.
    let resolved: { category: { name: string } } | { suggestions: string[] };
    try {
      resolved = await resolveCategory(category);
    } catch {
      return `I couldn't reach YNAB to verify "${category}" just now, so I did not set the alert. Please try again in a moment.`;
    }
    if ('suggestions' in resolved) {
      const hint = resolved.suggestions.length > 0 ? ` Did you mean: ${resolved.suggestions.join(', ')}?` : '';
      return `I couldn't find a YNAB category named "${category}", so I did NOT set an alert.${hint}`;
    }

    // Store the canonical YNAB name so the cron engine matches it exactly.
    const result = addThreshold(userName, { category: resolved.category.name, amount, direction });
    return 'error' in result ? result.error : `Set alert — ${result.change}.`;
  }

  if (action === 'remove') {
    if (!category) return 'A category is required to remove an alert.';
    const result = removeThreshold(userName, category);
    return 'error' in result ? result.error : `${result.change}.`;
  }

  return 'Unknown alert action. Use add, remove, or list.';
}

// Executes the config tool for a fixed user, then refreshes their cron task if the
// schedule changed. Returns a short result string fed back to the model.
function runConfigTool(userName: string, input: unknown): string {
  const update = (input ?? {}) as ConfigUpdate;
  const result = applyConfigUpdate(userName, update);
  if ('error' in result) return result.error;
  if (result.changes.length === 0) return 'No changes were specified.';
  if (update.schedule !== undefined || update.timezone !== undefined) refreshUserSchedule(userName);
  return `Updated ${userName}'s digest — ${result.changes.join('; ')}.`;
}

function describeDigestSettings(user: UserConfig): string {
  const f = user.format;
  const alerts = user.thresholds && user.thresholds.length > 0
    ? user.thresholds.map(formatThreshold).join(', ')
    : '(none)';
  return [
    'YOUR CURRENT DIGEST SETTINGS:',
    `- Categories shown: ${user.categories.join(', ') || '(none)'}`,
    `- Schedule (cron): ${user.schedule}`,
    `- Timezone: ${user.timezone}`,
    `- Amount shown: ${f.field}`,
    `- Goal progress: ${f.showGoalProgress ? 'on' : 'off'}`,
    `- Header note: ${f.headerNote || '(none)'}`,
    `- Balance alerts: ${alerts}`,
  ].join('\n');
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

export async function fetchYnabContext(timezone: string): Promise<string> {
  const api = getYnabClient();
  const budgetId = process.env.YNAB_BUDGET_ID ?? 'last-used';

  const now = new Date();
  const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: timezone });

  // Anchor the 14-day window to the user's local date so it doesn't drift by a
  // day near midnight (the month label above is already timezone-aware).
  const sinceDateStr = daysAgoInTz(14, timezone);

  const [catResponse, txResponse] = await Promise.all([
    cachedFetch(`categories:${budgetId}`, () => api.categories.getCategories(budgetId)),
    cachedFetch(
      `transactions:${budgetId}:${sinceDateStr}`,
      () => api.transactions.getTransactions(budgetId, sinceDateStr)
    ),
  ]);

  const categoryLines = catResponse.data.category_groups
    .filter((g) => !g.hidden && g.name !== 'Internal Master Category')
    .flatMap((g) =>
      g.categories
        .filter((c) => !c.hidden && !c.deleted)
        .map((c) => `${c.name}: ${toUSDDisplay(c.balance)} left, ${toUSDDisplay(-c.activity)} spent this month`)
    )
    .join('\n');

  const txLines = txResponse.data.transactions
    .filter((t) => !t.deleted)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 40)
    .map((t) => `${t.date} | ${t.payee_name ?? 'Unknown'} | ${t.category_name ?? 'Uncategorized'} | ${toUSDDisplay(t.amount)}`)
    .join('\n');

  return `Month: ${monthLabel}\n\nCATEGORIES (remaining balance and spent so far this calendar month):\n${categoryLines}\n\nRECENT TRANSACTIONS (last 14 days):\n${txLines || 'None'}`;
}

export async function askClaude(
  user: UserConfig,
  ynabContext: string,
  question: string,
  maxLength: number
): Promise<string> {
  const system =
    `You are a personal budget assistant for ${user.name}. ` +
    `Answer questions about their YNAB budget using the data below. ` +
    `Keep every reply under ${maxLength} characters — be direct and specific. ` +
    `Do not mention category IDs or technical terms. ` +
    `For how-much-have-we-spent questions, use each category's "spent this month" total, not the transaction list. ` +
    `Format negative dollar amounts as "🔻 ($15.00)" — a red down-triangle followed by the amount in ` +
    `parentheses; format positive amounts plainly as "$15.00". ` +
    `You can also change ${user.name}'s weekly digest settings with the ynab_update_config tool ` +
    `when they ask (e.g. "add Rent to my summary", "send it Fridays at 8am", "show budgeted instead"). ` +
    `Use the ynab_manage_alerts tool to set, remove, or list proactive balance alerts ` +
    `(e.g. "notify me when Coffee Shops gets to $15 or below"). ` +
    `After using either tool, confirm what changed in plain language. ` +
    `If a tool result says it could not find the category or did not set the alert, ` +
    `relay that to the user verbatim — do NOT claim the alert was set, and pass along any suggested category names. ` +
    `If you cannot answer from the data provided, say so briefly.\n\n` +
    `${describeDigestSettings(user)}\n\n${ynabContext}`;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];

  // Agentic loop: let the model call ynab_update_config (and see the result) before
  // it produces its final text reply. Bounded so a misbehaving model can't spin.
  for (let turn = 0; turn < 4; turn++) {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system,
      tools: [CONFIG_TOOL, ALERTS_TOOL],
      messages,
    });

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use' && block.name === 'ynab_update_config') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: runConfigTool(user.name, block.input),
          });
        } else if (block.type === 'tool_use' && block.name === 'ynab_manage_alerts') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: await runAlertTool(user.name, block.input),
          });
        }
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return text || 'Sorry, I could not generate a response.';
  }

  return "Sorry, that took too many steps — try rephrasing what you'd like to change.";
}
