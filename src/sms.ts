import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromPhone = process.env.TWILIO_FROM_PHONE;

// Module-level client — instantiated once when credentials are present
const client = accountSid && authToken ? twilio(accountSid, authToken) : null;

export function isSmsConfigured(): boolean {
  return Boolean(accountSid && authToken && fromPhone);
}

export async function sendSms(to: string, body: string): Promise<void> {
  if (!client || !fromPhone) {
    throw new Error('Twilio credentials are not configured.');
  }
  try {
    const msg = await client.messages.create({ to, from: fromPhone, body });
    console.log(`[SMS] Sent to ${to}: ${msg.sid}`);
  } catch (err) {
    console.error(`[SMS] Failed to send to ${to}:`, err instanceof Error ? err.message : err);
    throw err;
  }
}
