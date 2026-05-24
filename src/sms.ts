import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromPhone = process.env.TWILIO_FROM_PHONE;

// Lazily initialized on first send — avoids crashing at startup with placeholder credentials
let client: ReturnType<typeof twilio> | null = null;

function getClient(): ReturnType<typeof twilio> {
  if (!accountSid || !authToken) throw new Error('Twilio credentials are not configured.');
  if (!client) client = twilio(accountSid, authToken);
  return client;
}

export function isSmsConfigured(): boolean {
  return Boolean(accountSid && authToken && fromPhone);
}

export async function sendSms(to: string, body: string): Promise<void> {
  if (!fromPhone) throw new Error('Twilio credentials are not configured.');
  const c = getClient();
  try {
    const msg = await c.messages.create({ to, from: fromPhone, body });
    console.log(`[SMS] Sent to ${to}: ${msg.sid}`);
  } catch (err) {
    console.error(`[SMS] Failed to send to ${to}:`, err instanceof Error ? err.message : err);
    throw err;
  }
}
