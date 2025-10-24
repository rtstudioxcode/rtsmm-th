// otp.js
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { OtpToken } from '../models/OtpToken.js';
import { sendEmail } from '../lib/mailer.js';
import { config } from '../config.js';

const router = Router();

// กันถล่ม
const limiter = rateLimit({ windowMs: 60_000, max: 20 });
router.use(limiter);

// สร้างรหัส 6 หลัก
function genCode() {
  return ('' + Math.floor(100000 + Math.random()*900000));
}

// หน้าตาอีเมล
function emailTemplate(code) {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial">
    <h2>รหัสยืนยันอีเมล</h2>
    <p>รหัส OTP ของคุณคือ</p>
    <div style="font-size:28px;font-weight:800;letter-spacing:4px">${code}</div>
    <p style="color:#667085">รหัสหมดอายุใน ${config.otp.ttlSec/60} นาที</p>
  </div>`;
}

// POST /otp/send  { email, channel: 'email' }
router.post('/send', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok:false, error:'email required' });

    // cooldown
    const last = await OtpToken.findOne({ email, purpose: 'email-verify', usedAt: null })
      .sort({ createdAt: -1 });
    const now = Date.now();
    if (last?.lastSentAt && (now - last.lastSentAt.getTime()) < config.otp.resendCooldownSec*1000) {
      const wait = Math.ceil((config.otp.resendCooldownSec*1000 - (now - last.lastSentAt.getTime()))/1000);
      return res.status(429).json({ ok:false, error:`โปรดรอ ${wait}s ก่อนขอรหัสใหม่` });
    }

    const code = genCode();
    const codeHash = await bcrypt.hash(code, 10);
    const doc = new OtpToken({
      email,
      purpose: 'email-verify',
      codeHash,
      expiresAt: new Date(Date.now() + config.otp.ttlSec*1000),
      attempts: 0,
      maxAttempts: config.otp.maxAttempts,
      lastSentAt: new Date()
    });
    await doc.save();

    await sendEmail({
      to: email,
      subject: 'รหัสยืนยันอีเมล (OTP)',
      html: emailTemplate(code)
    });

    return res.json({ ok:true, ttl: config.otp.ttlSec });
  } catch (e) {
    console.error('OTP send error', e);
    return res.status(500).json({ ok:false, error:'send failed' });
  }
});

// POST /otp/verify  { email, code }
router.post('/verify', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code  = String(req.body.code || '').trim();
    if (!email || !code) return res.status(400).json({ ok:false, error:'email/code required' });

    const doc = await OtpToken.findOne({ email, purpose:'email-verify', usedAt:null })
      .sort({ createdAt: -1 });
    if (!doc) return res.status(400).json({ ok:false, error:'รหัสหมดอายุหรือไม่ถูกต้อง' });

    if (doc.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ ok:false, error:'รหัสหมดอายุ' });
    }
    if (doc.attempts >= doc.maxAttempts) {
      return res.status(400).json({ ok:false, error:'เกินจำนวนครั้งที่กำหนด' });
    }

    const ok = await bcrypt.compare(code, doc.codeHash);
    if (!ok) {
      doc.attempts += 1;
      await doc.save();
      return res.status(400).json({ ok:false, error:'รหัสไม่ถูกต้อง' });
    }

    doc.usedAt = new Date();
    await doc.save();

    // ถ้ามี session และอีเมลตรงกับผู้ใช้ ให้ mark verified ทันที
    if (req.user) {
      const { User } = await import('../models/User.js');
      const u = await User.findById(req.user._id);
      if (u && (u.email || '').toLowerCase() === email) {
        u.emailVerified = true;
        await u.save();
      }
    }

    return res.json({ ok:true });
  } catch (e) {
    console.error('OTP verify error', e);
    return res.status(500).json({ ok:false, error:'verify failed' });
  }
});

export default router;
