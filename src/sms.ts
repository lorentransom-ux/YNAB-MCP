import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromPhone = process.env.TWILIO_FROM_PHONE;

export function isSmsConfigured(): boolean {
  return Boolean(accountSid && authToken && fromPhone);
}

export async function sendSms(to: string, body: string): Promise<void> {
  if (!accountSid || !authToken || !fromPhone) {
    throw new Error('Twilio credentials are not configured.');
  }
  const client = twilio(accountSid, authToken);
  try {
    const msg = await client.messages.create({ to, from: fromPhone, body });
    console.log(`[SMS] Sent to ${to}: ${msg.sid}`);
  } catch (err) {
    console.error(`[SMS] Failed to send to ${to}:`, err);
  }
}
