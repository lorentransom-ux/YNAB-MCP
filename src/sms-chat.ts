import type { Request, Response } from 'express';
import { loadConfig } from './config.js';
import { sendSms } from './sms.js';
import { fetchYnabContext, askClaude, withTimeout } from './assistant.js';

const MAX_SMS_LENGTH = 280;

async function sendReply(res: Response, to: string, message: string): Promise<void> {
  const safe = message.length > MAX_SMS_LENGTH ? message.slice(0, MAX_SMS_LENGTH - 1) + '…' : message;
  await sendSms(to, safe);
  res.sendStatus(200);
}

function sendEmpty(res: Response): void {
  res.sendStatus(200);
}

export async function handleInboundSms(req: Request, res: Response): Promise<void> {
  // Telnyx sends delivery-status events (message.sent, message.finalized) to the same URL —
  // acknowledge them silently and only process message.received events.
  const event = (req.body as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  if (!event || event.event_type !== 'message.received') {
    sendEmpty(res);
    return;
  }

  const payload = event.payload as Record<string, unknown> | undefined;
  const from = (payload?.from as Record<string, string> | undefined)?.phone_number ?? '';
  const body = (typeof payload?.text === 'string' ? payload.text : '').trim();

  if (!body) {
    sendEmpty(res);
    return;
  }

  // Only respond to configured phone numbers
  const config = loadConfig();
  const user = config.users.find((u) => u.phone === from);
  if (!user) {
    console.warn(`[SMS Chat] Ignored message from unrecognized number: ${from}`);
    sendEmpty(res);
    return;
  }
  console.log(`[SMS Chat] Inbound from ${user.name}: "${body}"`);

  let ynabContext: string;
  try {
    ynabContext = await withTimeout(fetchYnabContext(user.timezone), 8000, 'YNAB fetch');
  } catch (err) {
    console.error('[SMS Chat] YNAB error:', err instanceof Error ? err.message : err);
    await sendReply(res, from, "Sorry, couldn't reach YNAB to fetch your budget data. Try again in a moment.");
    return;
  }

  try {
    const answer = await withTimeout(askClaude(user.name, ynabContext, body, MAX_SMS_LENGTH), 8000, 'Claude');
    await sendReply(res, from, answer);
  } catch (err) {
    console.error('[SMS Chat] Claude error:', err instanceof Error ? err.message : err);
    await sendReply(res, from, "Sorry, couldn't get a response from the assistant right now. Try again in a moment.");
  }
}
