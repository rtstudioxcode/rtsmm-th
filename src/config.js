// src/config.js
import 'dotenv/config';
import mongoose from 'mongoose';
import { decryptAesGcm } from './lib/crypto.js';

/** ---- ENV defaults (bootstrap ขั้นต้น) ----
 *  หมายเหตุ: mongoUri ยังจำเป็นต้องมาจาก .env (อย่างน้อยรอบแรก) เพื่อเปิด DB ได้
 */
const envConfig = {
  port: Number(process.env.PORT || 3000),
  // mongoUri: process.env.MONGO_URI,
  mongoUri: process.env.MONGO_URI || 'mongodb://mongo:UExusYQYbMpqTLSRXPKAMfHyuVaRoVnK@ballast.proxy.rlwy.net:33636/rtsmm-th?replicaSet=rs0&authSource=admin&retryWrites=true&w=majority',
  sessionSecret: process.env.SESSION_SECRET || '',

  // iPlusView (คงเดิม)
  provider: {
    baseUrl: ((process.env.IPV_API_BASE || '').replace(/\/+$/, '')) || '',
    apiKey: process.env.IPV_API_KEY || ''
  },

  // ✅ เพิ่ม: OTP24hr (อ่านจาก ENV เป็นค่าเริ่มต้นได้ด้วย)
  otp24hr: {
    apiBase: ((process.env.OTP24_API_BASE || '').replace(/\/+$/, '')),
    apiKey: process.env.OTP24_API_KEY || '',
  },

  currency: 'THB',
  initialBalance: 0,
  signupBonus: 0,

  mail: {
    host: process.env.MAIL_HOST || '',
    port: Number(process.env.MAIL_PORT || 587),
    user: process.env.MAIL_USER || '',
    pass: process.env.MAIL_PASS || '',
    from: process.env.MAIL_FROM || '',
  },

  otp: {
    ttlSec: Number(process.env.OTP_CODE_TTL || 600),
    resendCooldownSec: Number(process.env.OTP_RESEND_COOLDOWN || 60),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS || 5),
  },

  TW_GEN_LINK_SECRET: process.env.TW_GEN_LINK_SECRET || '',
};

// live object ที่ทุกไฟล์ใช้ร่วมกัน
export const config = structuredClone(envConfig);

/* ================= DB-backed secure config ================ */
const secureConfigSchema = new mongoose.Schema(
  {
    port: Number,
    sessionSecret: String,

    // iPlusView (คงเดิม)
    ipv: {
      apiBase: String,
      apiKey: String,
    },

    // ✅ เพิ่ม: OTP24hr เก็บใน DB
    otp24hr: {
      apiBase: String,
      apiKey: String,
    },

    mail: {
      host: String,
      port: Number,
      user: String,
      pass: String,
      from: String,
    },
    otp: {
      ttlSec: Number,
      resendCooldownSec: Number,
      maxAttempts: Number,
    },
    TW_GEN_LINK_SECRET: String,

    // เก็บ mongoUri แบบเข้ารหัส (คงเดิม)
    mongoUriEnc: String,
  },
  { collection: 'secure_config', minimize: true }
);

const SecureConfig =
  mongoose.models.SecureConfig || mongoose.model('SecureConfig', secureConfigSchema);

const trimBase = (u = '') => String(u).replace(/\/+$/, '');

/** รวมค่าแบบ DB > ENV (ยกเว้น mongoUri ยังต้องจาก ENV เพื่อเปิด DB ได้) */
function applyDBToConfig(doc) {
  if (!doc) return;

  // ถอดรหัส mongoUri ถ้ามี
  if (doc.mongoUriEnc) {
    const key = process.env.CONFIG_KEY || '';
    try {
      const dec = decryptAesGcm(doc.mongoUriEnc, key);
      if (dec) config.mongoUriFromDBDecrypted = dec;
    } catch {}
  }

  if (Number.isFinite(doc.port)) config.port = Number(doc.port);
  if (doc.sessionSecret) config.sessionSecret = String(doc.sessionSecret);

  // iPlusView
  const baseIpv = trimBase(doc?.ipv?.apiBase || '');
  const keyIpv  = (doc?.ipv?.apiKey || '').trim();
  if (baseIpv) config.provider.baseUrl = baseIpv;
  if (keyIpv)  config.provider.apiKey  = keyIpv;

  // ✅ OTP24hr
  const otp24doc  = doc?.otp24hr || doc?.otp24 || null;
  const baseOtp24 = trimBase(otp24doc?.apiBase || '');
  const keyOtp24  = (otp24doc?.apiKey || '').trim();
  if (baseOtp24) config.otp24hr.apiBase = baseOtp24;
  if (keyOtp24)  config.otp24hr.apiKey  = keyOtp24;

  // mail
  if (doc.mail) {
    if (doc.mail.host) config.mail.host = String(doc.mail.host);
    if (Number.isFinite(doc.mail.port)) config.mail.port = Number(doc.mail.port);
    if (doc.mail.user) config.mail.user = String(doc.mail.user);
    if (doc.mail.pass) config.mail.pass = String(doc.mail.pass);
    if (doc.mail.from) config.mail.from = String(doc.mail.from);
  }

  // OTP policy
  if (doc.otp) {
    if (Number.isFinite(doc.otp.ttlSec)) config.otp.ttlSec = Number(doc.otp.ttlSec);
    if (Number.isFinite(doc.otp.resendCooldownSec)) {
      config.otp.resendCooldownSec = Number(doc.otp.resendCooldownSec);
    }
    if (Number.isFinite(doc.otp.maxAttempts)) config.otp.maxAttempts = Number(doc.otp.maxAttempts);
  }
}

/** เรียกหลังจาก connect Mongo เรียบร้อย: ดึงค่าจาก DB และอัปเดต config (live) */
export async function refreshConfigFromDB() {
  try {
    const doc = await SecureConfig.findOne().lean();
    applyDBToConfig(doc || null);
    // tidy base URLs
    config.provider.baseUrl = trimBase(config.provider.baseUrl);
    config.otp24hr.apiBase  = trimBase(config.otp24hr.apiBase);
    return config;
  } catch {
    return config;
  }
}

/** utility: อ่านเอกสารเต็ม (debug/หน้า settings แอดมิน) */
export async function getSecureConfigDoc() {
  try {
    return await SecureConfig.findOne().lean();
  } catch {
    return null;
  }
}

/* ================= Utilities สำหรับเชื่อม Mongo ================= */

/** เลือก URI ที่จะใช้เชื่อม (ลำดับ: ถอดรหัสจาก DB > ENV > ค่าในไฟล์นี้) */
export function resolveMongoUri() {
  return (
    config.mongoUriFromDBDecrypted ||
    process.env.MONGO_URI ||
    config.mongoUri
  );
}

/** ต่อ MongoDB ถ้ายังไม่ต่อ หรือหลุดไปแล้ว */
export async function connectMongoIfNeeded() {
  const st = mongoose.connection.readyState;
  if (st === 1 || st === 2) return mongoose.connection;

  const uri = resolveMongoUri();
  if (!uri) throw new Error('MONGO_URI is missing (env/secure_config)');

  await mongoose.connect(uri);
  return mongoose.connection;
}
