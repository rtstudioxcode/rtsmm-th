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
};
