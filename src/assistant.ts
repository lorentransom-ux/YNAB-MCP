import Anthropic from '@anthropic-ai/sdk';
import { getYnabClient, cachedFetch } from './ynab.js';
import { toUSD } from './utils.js';

// Module-level client — instantiated once, reused for every inbound Telegram message.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

  const sinceDate = new Date(now);
  sinceDate.setDate(sinceDate.getDate() - 14);
  const sinceDateStr = sinceDate.toISOString().slice(0, 10);

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
        .map((c) => `${c.name}: ${toUSD(c.balance)} left`)
    )
    .join('\n');

  const txLines = txResponse.data.transactions
    .filter((t) => !t.deleted)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 40)
    .map((t) => `${t.date} | ${t.payee_name ?? 'Unknown'} | ${t.category_name ?? 'Uncategorized'} | ${toUSD(t.amount)}`)
    .join('\n');

  return `Month: ${monthLabel}\n\nCATEGORY BALANCES:\n${categoryLines}\n\nRECENT TRANSACTIONS (last 14 days):\n${txLines || 'None'}`;
}

export async function askClaude(
  userName: string,
  ynabContext: string,
  question: string,
  maxLength: number
): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system:
      `You are a personal budget assistant for ${userName}. ` +
      `Answer questions about their YNAB budget using the data below. ` +
      `Keep every reply under ${maxLength} characters — be direct and specific. ` +
      `Do not mention category IDs or technical terms. ` +
      `If you cannot answer from the data provided, say so briefly.\n\n` +
      ynabContext,
    messages: [{ role: 'user', content: question }],
  });

  const block = response.content[0];
  if (!block) return 'Sorry, I could not generate a response.';
  return block.type === 'text' ? block.text : 'Sorry, I could not generate a response.';
}
