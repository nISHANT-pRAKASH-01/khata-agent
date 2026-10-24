// Order emails through Gmail SMTP. Needs GMAIL_USER and a Gmail App Password
// (Google Account → Security → 2-Step Verification → App passwords).
import nodemailer from 'nodemailer';

export const isConfigured = () => Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

let transport;
export async function sendMail({ to, subject, text }) {
  transport ??= nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transport.sendMail({ from: `Uncle Store <${process.env.GMAIL_USER}>`, to, subject, text });
}
