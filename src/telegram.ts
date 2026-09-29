const botToken = process.env.TELEGRAM_BOT_TOKEN;

// Optional shared secret. When set, it is registered with Telegram via setWebhook
// and echoed back in the X-Telegram-Bot-Api-Secret-Token header on every delivery,
// letting the /telegram endpoint verify a webhook genuinely came from Telegram.
export const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

export function isTelegramConfigured(): boolean {
  return Boolean(botToken);
}

// NOTE: botToken lives in the request URL path. Never log the full URL — only
// log chat_id and HTTP status so the token never lands in logs.
function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

async function postMessage(chatId: number | string, text: string, markdown: boolean): Promise<Response> {
  return fetch(apiUrl('sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(markdown ? { chat_id: chatId, text, parse_mode: 'Markdown' } : { chat_id: chatId, text }),
  });
}

export async function sendTelegram(chatId: number | string, text: string): Promise<void> {
  if (!botToken) throw new Error('Telegram bot token is not configured.');
  try {
    let res = await postMessage(chatId, text, true);
    let detail = res.ok ? '' : await res.text().catch(() => '');
    // Telegram rejects the whole message when the text has unbalanced Markdown
    // (a stray _ or * in a category name or Claude reply). Resend as plain text
    // rather than dropping it.
    if (res.status === 400 && detail.includes("can't parse entities")) {
      console.warn(`[Telegram] Markdown rejected for ${chatId}; resending as plain text`);
      res = await postMessage(chatId, text, false);
      detail = res.ok ? '' : await res.text().catch(() => '');
    }
    if (!res.ok) {
      throw new Error(`Telegram API ${res.status}: ${detail}`);
    }
    console.log(`[Telegram] Sent to ${chatId}`);
  } catch (err) {
    console.error(`[Telegram] Failed to send to ${chatId}:`, err instanceof Error ? err.message : err);
    throw err;
  }
}

// Best-effort message to the server owner (USER1). Read from env rather than the
// config store so it works during startup, before config is hydrated.
async function notifyOwner(text: string): Promise<void> {
  const ownerChatId = process.env.USER1_TELEGRAM_ID;
  if (!ownerChatId) {
    console.error('[Telegram] Could not notify owner: USER1_TELEGRAM_ID is not set');
    return;
  }
  try {
    await sendTelegram(ownerChatId, text);
  } catch {
    // sendTelegram already logged the failure
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Self-configuring webhook registration, called once at startup. Points Telegram
// at <serverUrl>/telegram. Telegram requires an HTTPS serverUrl.
//
// Telegram rate-limits setWebhook, and a redeploy restarts the container fast
// enough that back-to-back registrations can hit a 429. That's routine, not a
// real failure, so honor Telegram's retry_after and try again — an error is
// only logged once registration has genuinely failed.
// Sending still works when webhook registration fails, so the bot can say it has
// gone deaf to chat instead of silently ignoring messages.
const WEBHOOK_FAILED_NOTICE =
  '⚠️ YNAB bot: Telegram webhook registration failed at startup, so I can send alerts and ' +
  "digests but won't see your chat messages. Redeploy the service to retry; see server logs for details.";

export async function registerTelegramWebhook(serverUrl: string): Promise<void> {
  if (!botToken) return;
  const webhookUrl = `${serverUrl.replace(/\/$/, '')}/telegram`;
  if (!webhookUrl.startsWith('https://')) {
    console.warn(`[Telegram] Skipping webhook registration — SERVER_URL is not HTTPS: ${serverUrl}`);
    return;
  }
  const body: Record<string, unknown> = { url: webhookUrl };
  if (webhookSecret) {
    body.secret_token = webhookSecret;
  } else {
    console.warn(
      '[Telegram] TELEGRAM_WEBHOOK_SECRET is not set — /telegram will accept unauthenticated ' +
      'posts, guarded only by the chat-ID allowlist. Set it in production.'
    );
  }

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(apiUrl('setWebhook'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        console.log(`[Telegram] Webhook registered at ${webhookUrl}`);
        return;
      }
      const detail = await res.text().catch(() => '');
      if (res.status === 429 && attempt < maxAttempts) {
        let retryAfter = 5;
        try {
          const parsed = JSON.parse(detail) as { parameters?: { retry_after?: number } };
          retryAfter = Math.min(parsed.parameters?.retry_after ?? 5, 60);
        } catch {
          // unparseable body — fall back to the 5s default
        }
        console.log(
          `[Telegram] setWebhook rate-limited; retrying in ${retryAfter}s (attempt ${attempt}/${maxAttempts})`
        );
        await sleep(retryAfter * 1000);
        continue;
      }
      console.error(`[Telegram] setWebhook failed (${res.status}): ${detail}`);
      await notifyOwner(WEBHOOK_FAILED_NOTICE);
      return;
    } catch (err) {
      if (attempt < maxAttempts) {
        await sleep(2000 * attempt);
        continue;
      }
      console.error('[Telegram] Webhook registration error:', err instanceof Error ? err.message : err);
      await notifyOwner(WEBHOOK_FAILED_NOTICE);
    }
  }
}
