import type { Request, Response } from 'express';
import { loadConfig } from './config.js';
import { sendTelegram, webhookSecret } from './telegram.js';
import { fetchYnabContext, askClaude, withTimeout } from './assistant.js';

// Telegram handles up to 4096 chars; cap replies well under that and let Claude
// use line breaks / light Markdown (unlike the 280-char SMS segment limit).
const MAX_TELEGRAM_LENGTH = 1000;

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

export async function handleInboundTelegram(req: Request, res: Response): Promise<void> {
  // Verify the request genuinely came from Telegram when a secret is configured.
  if (webhookSecret) {
    const provided = req.header('X-Telegram-Bot-Api-Secret-Token');
    if (provided !== webhookSecret) {
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
      askClaude(user.name, ynabContext, body, MAX_TELEGRAM_LENGTH),
      8000,
      'Claude'
    );
    await sendReply(res, chatId, answer);
  } catch (err) {
    console.error('[Telegram Chat] Claude error:', err instanceof Error ? err.message : err);
    await sendReply(res, chatId, "Sorry, couldn't get a response from the assistant right now. Try again in a moment.");
  }
}
