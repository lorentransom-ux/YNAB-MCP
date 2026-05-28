import Telnyx from 'telnyx';

const apiKey = process.env.TELNYX_API_KEY;
const fromPhone = process.env.TELNYX_FROM_PHONE;

// Lazily initialized on first send — avoids crashing at startup with placeholder credentials
let client: Telnyx | null = null;

function getClient(): Telnyx {
  if (!apiKey) throw new Error('Telnyx credentials are not configured.');
  if (!client) client = new Telnyx({ apiKey });
  return client;
}

export function isSmsConfigured(): boolean {
  return Boolean(apiKey && fromPhone);
}

export async function sendSms(to: string, body: string): Promise<void> {
  if (!fromPhone) throw new Error('Telnyx credentials are not configured.');
  const c = getClient();
  try {
    const msg = await c.messages.send({ from: fromPhone, to, text: body });
    console.log(`[SMS] Sent to ${to}: ${msg.data?.id}`);
  } catch (err) {
    console.error(`[SMS] Failed to send to ${to}:`, err instanceof Error ? err.message : err);
    throw err;
  }
}
