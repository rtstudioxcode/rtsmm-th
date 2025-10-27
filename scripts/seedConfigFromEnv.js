// scripts/seedConfigFromEnv.js
import mongoose from 'mongoose';
import { set } from '../services/configService.js';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) throw new Error('MONGO_URI env required');

(async () => {
  await mongoose.connect(MONGO_URI);

  const obj = {
    server: { port: Number(process.env.PORT || 3000) },
    session: { secret: process.env.SESSION_SECRET || 'change-me' },
    smtp: {
      host: process.env.MAIL_HOST,
      port: Number(process.env.MAIL_PORT || 587),
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
      from: process.env.MAIL_FROM || 'RTSSM-TH <no-reply@rtsmm-th.com>'
    },
    ipv: { base: process.env.IPV_API_BASE, key: process.env.IPV_API_KEY },
    otp: {
      ttlSec: Number(process.env.OTP_CODE_TTL || 600),
      resendCooldownSec: Number(process.env.OTP_RESEND_COOLDOWN || 60),
      maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS || 5)
    }
  };

  for (const [k, v] of Object.entries(obj)) {
    await set(k, v, { secret: ['session','smtp','ipv'].includes(k), updatedBy: 'seed' });
    console.log('Seeded:', k);
  }
  await mongoose.disconnect();
  console.log('Done.');
  process.exit(0);
})();
