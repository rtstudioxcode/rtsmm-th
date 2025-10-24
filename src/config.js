import 'dotenv/config';

export const config = {
  port: process.env.PORT || 5000,
  mongoUri: process.env.MONGO_URI,
  sessionSecret: process.env.SESSION_SECRET || 'rtstudioxcode78rt58y9643y5t8y7u6i5o4p3',
  provider: {
    baseUrl: (process.env.IPV_API_BASE || '').replace(/\/+$/, '') + '/',
    apiKey: process.env.IPV_API_KEY
  },
  currency: 'THB',
  initialBalance: 0,
  signupBonus: 0,
  mail: {
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT || 587),
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
    from: process.env.MAIL_FROM || 'RTSSM-TH <no-reply@rtsmm-th.com>',
  },
  otp: {
    ttlSec: Number(process.env.OTP_CODE_TTL || 600),
    resendCooldownSec: Number(process.env.OTP_RESEND_COOLDOWN || 60),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS || 5),
  }
};
