import nodemailer from 'nodemailer';

const emailUser = process.env.EMAIL_USER;
const emailAppPassword = process.env.EMAIL_APP_PASSWORD;

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!emailUser || !emailAppPassword) throw new Error('Email credentials not configured.');
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: emailUser, pass: emailAppPassword },
    });
  }
  return transporter;
}

export function isEmailSmsConfigured(): boolean {
  return Boolean(emailUser && emailAppPassword);
}

function phoneToEmail(phone: string, gateway: string): string {
  const digits = phone.replace(/\D/g, '').slice(-10);
  return `${digits}@${gateway}`;
}

export async function sendEmailSms(phone: string, gateway: string, body: string): Promise<void> {
  const to = phoneToEmail(phone, gateway);
  const t = getTransporter();
  await t.sendMail({ from: emailUser, to, subject: '', text: body });
  console.log(`[Email-SMS] Sent to ${to}`);
}
