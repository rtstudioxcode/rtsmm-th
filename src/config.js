// src/config.js
import 'dotenv/config';
import mongoose from 'mongoose';
import { decryptAesGcm } from './lib/crypto.js';

/** ---- ENV defaults (bootstrap ขั้นต้น) ----
 *  หมายเหตุ: mongoUri ยังจำเป็นต้องมาจาก .env เพื่อบูตเชื่อมต่อ DB ครั้งแรก
 */
const envConfig = {
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGO_URI, // ใช้สำหรับ Production
  mongoUri: process.env.MONGO_URI || 'mongodb://admin:060843Za@147.50.240.76:27017/rtsmm-th?authSource=admin', // ใช้สำหรับทดสอบ
  sessionSecret: process.env.SESSION_SECRET || '',
  provider: {
    baseUrl: ((process.env.IPV_API_BASE || '').replace(/\/+$/, '')) || '',
    apiKey: process.env.IPV_API_KEY || ''
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
    // ตัวอย่างเอกสารใน collection: secure_config
    // {
    //   port: 3000,
    //   sessionSecret: "xxxx",
    //   ipv: { apiBase: "https://api.iplusview.store", apiKey: "...." },
    //   mail: { host, port, user, pass, from },
    //   otp: { ttlSec, resendCooldownSec, maxAttempts }
    // }
    port: Number,
    sessionSecret: String,
    ipv: {
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
  },
  { collection: 'secure_config', minimize: true }
);

const SecureConfig =
  mongoose.models.SecureConfig || mongoose.model('SecureConfig', secureConfigSchema);

const trimBase = (u = '') => String(u).replace(/\/+$/, '');

/** รวมค่าแบบ DB > ENV (ยกเว้น mongoUri ยังต้องจาก ENV เพื่อเปิด DB ได้) */
function applyDBToConfig(doc) {
  if (!doc) return;

  // ถ้ามี mongoUriEnc จะเก็บไว้ “แยก” ไม่ทับ env โดยตรง
  if (doc.mongoUriEnc) {
    // จะถอดเมื่อมี CONFIG_KEY เท่านั้น
    const key = process.env.CONFIG_KEY || '';
    try {
      const dec = decryptAesGcm(doc.mongoUriEnc, key);
      if (dec) config.mongoUriFromDBDecrypted = dec; // เก็บแยก
    } catch {}
  }
  
  // พอร์ตและ session
  if (Number.isFinite(doc.port)) config.port = Number(doc.port);
  if (doc.sessionSecret) config.sessionSecret = String(doc.sessionSecret);

  // ผู้ให้บริการ (IPV)
  const base = trimBase(doc?.ipv?.apiBase || '');
  const key  = (doc?.ipv?.apiKey || '').trim();
  if (base) config.provider.baseUrl = base;
  if (key)  config.provider.apiKey  = key;

  // อีเมล
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

  // currency / balances (ถ้าคุณอยากให้ตั้งจาก DB ก็รองรับเพิ่มฟิลด์ได้)
  // เช่น: if (doc.currency) config.currency = String(doc.currency);
  //       if (Number.isFinite(doc.initialBalance)) config.initialBalance = Number(doc.initialBalance);
}

/** เรียกหลังจาก connect Mongo เรียบร้อย: ดึงค่าจาก DB และอัปเดต config (live) */
export async function refreshConfigFromDB() {
  try {
    const doc = await SecureConfig.findOne().lean();
    applyDBToConfig(doc || null);
    // ปรับ baseUrl ให้ไม่มี slash ท้าย
    config.provider.baseUrl = trimBase(config.provider.baseUrl);
    return config;
  } catch (e) {
    // ถ้าดึงไม่ได้ ปล่อยใช้ค่าจาก ENV ต่อ
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
