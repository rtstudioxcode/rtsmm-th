import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transporter;
export function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.port === 465,
    auth: { user: config.mail.user, pass: config.mail.pass },
  });
  return transporter;
}

export async function sendEmail({ to, subject, html, text }) {
  const tx = getTransporter();
  return tx.sendMail({
    from: config.mail.from,
    to, subject,
    text: text || html?.replace(/<[^>]+>/g, ' '),
    html
  });
}
