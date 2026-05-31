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

export async function sendTelegram(chatId: number | string, text: string): Promise<void> {
  if (!botToken) throw new Error('Telegram bot token is not configured.');
  try {
    const res = await fetch(apiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Telegram API ${res.status}: ${detail}`);
    }
    console.log(`[Telegram] Sent to ${chatId}`);
  } catch (err) {
    console.error(`[Telegram] Failed to send to ${chatId}:`, err instanceof Error ? err.message : err);
    throw err;
  }
}

// Self-configuring webhook registration, called once at startup. Points Telegram
// at <serverUrl>/telegram. Telegram requires an HTTPS serverUrl.
export async function registerTelegramWebhook(serverUrl: string): Promise<void> {
  if (!botToken) return;
  const webhookUrl = `${serverUrl.replace(/\/$/, '')}/telegram`;
  if (!webhookUrl.startsWith('https://')) {
    console.warn(`[Telegram] Skipping webhook registration — SERVER_URL is not HTTPS: ${serverUrl}`);
    return;
  }
  try {
    const body: Record<string, unknown> = { url: webhookUrl };
    if (webhookSecret) body.secret_token = webhookSecret;
    const res = await fetch(apiUrl('setWebhook'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[Telegram] setWebhook failed (${res.status}): ${detail}`);
      return;
    }
    console.log(`[Telegram] Webhook registered at ${webhookUrl}`);
  } catch (err) {
    console.error('[Telegram] Webhook registration error:', err instanceof Error ? err.message : err);
  }
}
