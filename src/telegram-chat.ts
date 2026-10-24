import { createHash, timingSafeEqual } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { Request, Response } from 'express';
import { loadConfig } from './config.js';
import { sendTelegram, webhookSecret } from './telegram.js';
import { fetchYnabContext, askClaude, withTimeout } from './assistant.js';

// Telegram handles up to 4096 chars; cap replies well under that and let Claude
// use line breaks / light Markdown.
const MAX_TELEGRAM_LENGTH = 1000;

// Short-term conversation memory, per chat. Held in process memory only: it's lost
// on restart/redeploy, which is fine for quick back-and-forth follow-ups.
const HISTORY_TURNS = 6; // question/answer pairs kept per chat
const HISTORY_TTL_MS = 30 * 60 * 1000; // forget a conversation after 30 min idle
const RESET_COMMANDS = new Set(['/reset', '/new', '/start']);

interface ChatHistory {
  messages: Anthropic.MessageParam[];
  lastActive: number;
}
const histories = new Map<number, ChatHistory>();

function getHistory(chatId: number): Anthropic.MessageParam[] {
  const entry = histories.get(chatId);
  if (!entry) return [];
  if (Date.now() - entry.lastActive > HISTORY_TTL_MS) {
    histories.delete(chatId);
    return [];
  }
  return entry.messages;
}

function rememberTurn(chatId: number, question: string, answer: string): void {
  const messages = [
    ...getHistory(chatId),
    { role: 'user', content: question } as const,
    { role: 'assistant', content: answer } as const,
  ].slice(-HISTORY_TURNS * 2);
  histories.set(chatId, { messages, lastActive: Date.now() });
}

async function sendReply(res: Response, chatId: number, message: string): Promise<void> {
  const safe = message.length > MAX_TELEGRAM_LENGTH ? message.slice(0, MAX_TELEGRAM_LENGTH - 1) + '…' : message;
  // Send via the Bot API, then ack the webhook. Failures to send are logged in
  // sendTelegram; we still 200 so Telegram doesn't retry a non-transient error.
  try {
    await sendTelegram(chatId, safe);
  } catch {
    /* already logged in sendTelegram */
  }
  res.sendStatus(200);
}

// Hash both sides so timingSafeEqual gets equal-length inputs and the comparison
// time doesn't reveal how much of a forged token was right.
function secretMatches(input: string, secret: string): boolean {
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

export async function handleInboundTelegram(req: Request, res: Response): Promise<void> {
  // Verify the request genuinely came from Telegram when a secret is configured.
  if (webhookSecret) {
    const provided = req.header('X-Telegram-Bot-Api-Secret-Token');
    if (!secretMatches(provided ?? '', webhookSecret)) {
      console.warn('[Telegram Chat] Rejected webhook with missing/invalid secret token');
      res.sendStatus(401);
      return;
    }
  }

  // Telegram posts many update types (edited_message, channel_post, etc.) — we only
  // handle new text messages; acknowledge everything else with 200.
  const update = req.body as Record<string, unknown> | undefined;
  const message = update?.message as Record<string, unknown> | undefined;
  const chat = message?.chat as Record<string, unknown> | undefined;
  const chatId = typeof chat?.id === 'number' ? chat.id : undefined;
  const body = (typeof message?.text === 'string' ? message.text : '').trim();

  if (chatId === undefined || !body) {
    res.sendStatus(200);
    return;
  }

  // Only respond to configured chat IDs.
  const config = loadConfig();
  const user = config.users.find((u) => u.telegramChatId === chatId);
  if (!user) {
    console.warn(`[Telegram Chat] Ignored message from unrecognized chat: ${chatId}`);
    res.sendStatus(200);
    return;
  }
  console.log(`[Telegram Chat] Inbound from ${user.name}: "${body}"`);

  if (RESET_COMMANDS.has(body.toLowerCase())) {
    histories.delete(chatId);
    await sendReply(res, chatId, 'Started a fresh conversation — ask me anything about your budget.');
    return;
  }

  let ynabContext: string;
  try {
    ynabContext = await withTimeout(fetchYnabContext(user.timezone), 8000, 'YNAB fetch');
  } catch (err) {
    console.error('[Telegram Chat] YNAB error:', err instanceof Error ? err.message : err);
    await sendReply(res, chatId, "Sorry, couldn't reach YNAB to fetch your budget data. Try again in a moment.");
    return;
  }

  try {
    const answer = await withTimeout(
      askClaude(user, ynabContext, body, MAX_TELEGRAM_LENGTH, getHistory(chatId)),
      15000,
      'Claude'
    );
    rememberTurn(chatId, body, answer);
    await sendReply(res, chatId, answer);
  } catch (err) {
    console.error('[Telegram Chat] Claude error:', err instanceof Error ? err.message : err);
    await sendReply(res, chatId, "Sorry, couldn't get a response from the assistant right now. Try again in a moment.");
  }
}
