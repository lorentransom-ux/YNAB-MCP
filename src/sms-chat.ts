import type { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import twilio from 'twilio';
import { loadConfig } from './config.js';
import { getYnabClient } from './ynab.js';
import { toUSD } from './utils.js';

const MAX_SMS_LENGTH = 280;

function twimlReply(res: Response, message: string): void {
  const safe = message.length > MAX_SMS_LENGTH ? message.slice(0, MAX_SMS_LENGTH - 1) + '…' : message;
  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Message>${safe}</Message></Response>`);
}

function twimlEmpty(res: Response): void {
  res.set('Content-Type', 'text/xml');
  res.send('<Response/>');
}

function validateTwilioSignature(req: Request): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;
  const signature = req.headers['x-twilio-signature'] as string | undefined;
  if (!signature) return false;
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  return twilio.validateRequest(authToken, signature, url, req.body as Record<string, string>);
}

async function fetchYnabContext(timezone: string): Promise<string> {
  const api = getYnabClient();
  const budgetId = process.env.YNAB_BUDGET_ID ?? 'last-used';

  const now = new Date();
  const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: timezone });

  const sinceDate = new Date(now);
  sinceDate.setDate(sinceDate.getDate() - 14);
  const sinceDateStr = sinceDate.toISOString().slice(0, 10);

  const [catResponse, txResponse] = await Promise.all([
    api.categories.getCategories(budgetId),
    api.transactions.getTransactions(budgetId, sinceDateStr),
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

async function askClaude(userName: string, ynabContext: string, question: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system:
      `You are a personal budget assistant for ${userName}. ` +
      `Answer questions about their YNAB budget using the data below. ` +
      `Keep every reply under ${MAX_SMS_LENGTH} characters — be direct and specific. ` +
      `Do not mention category IDs or technical terms. ` +
      `If you cannot answer from the data provided, say so briefly.\n\n` +
      ynabContext,
    messages: [{ role: 'user', content: question }],
  });

  const block = response.content[0];
  return block.type === 'text' ? block.text : 'Sorry, I could not generate a response.';
}

export async function handleInboundSms(req: Request, res: Response): Promise<void> {
  // Validate Twilio signature — reject spoofed requests
  if (!validateTwilioSignature(req)) {
    res.status(403).send('Forbidden');
    return;
  }

  const from = (req.body as Record<string, string>).From ?? '';
  const body = ((req.body as Record<string, string>).Body ?? '').trim();

  if (!body) {
    twimlEmpty(res);
    return;
  }

  // Only respond to configured phone numbers
  const config = loadConfig();
  const user = config.users.find((u) => u.phone === from);
  if (!user) {
    twimlEmpty(res);
    return;
  }

  try {
    const ynabContext = await fetchYnabContext(user.timezone);
    const answer = await askClaude(user.name, ynabContext, body);
    twimlReply(res, answer);
  } catch (err) {
    console.error('[SMS Chat] Error:', err);
    twimlReply(res, 'Sorry, something went wrong fetching your budget data. Try again in a moment.');
  }
}
