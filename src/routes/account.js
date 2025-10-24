// routes/account.js
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models/User.js';

// OTP ใหม่
import { OtpToken } from '../models/OtpToken.js';
import { sendEmail } from '../lib/mailer.js';
import { config } from '../config.js';

/* ==== NEW: loyalty & spend services (ไม่แตะ Order.js) ==== */
import { LEVELS, computeLevel } from '../services/loyalty.js';
import { recalcUserTotalSpent } from '../services/spend.js';

/* ---------------- helpers ---------------- */
function getAuthUserId(req) {
  return (
    req.user?._id ||
    req.session?.user?._id ||
    req.res?.locals?.me?._id ||
    null
  );
}

// รหัส 6 หลัก + เทมเพลตอีเมล
const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
const emailTemplate = (code) => `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial">
    <h2>รหัสยืนยันอีเมล</h2>
    <p>รหัส OTP ของคุณคือ</p>
    <div style="font-size:28px;font-weight:800;letter-spacing:4px">${code}</div>
    <p style="color:#667085">รหัสหมดอายุใน ${config.otp.ttlSec/60} นาที</p>
  </div>`;

/* ---------------- router ---------------- */
const router = Router();
router.use(requireAuth);

/* ---------------- upload avatar ---------------- */
const uploadDir = path.join(process.cwd(), 'uploads', 'avatars');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '.png').toLowerCase();
    const uid = getAuthUserId(req) || `anon-${Date.now()}`;
    cb(null, `${uid}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpe?g|webp)/i.test(file.mimetype);
    cb(ok ? null : new Error('Invalid image type'), ok);
  }
});

/* ---------------- GET /account ---------------- */
router.get('/account', async (req, res, next) => {
  try {
    const uid = getAuthUserId(req);
    if (!uid) return res.redirect('/login');
    await recalcUserTotalSpent(uid);

    // (1) โหลด user
    let me = await User.findById(uid).lean();
    if (!me) return res.redirect('/login');

    // (2) ให้ยอด/เลเวล "สดใหม่" ทุกครั้งที่เปิดหน้า (ปลอดภัยและไม่กระทบ Order.js)
    const { totalSpent, level } = await recalcUserTotalSpent(me._id);
    if (typeof totalSpent === 'number') me.totalSpent = totalSpent;
    if (typeof level === 'number')     me.level = level;

    // (3) ป้องกันกรณี user ยังไม่มีค่า -> ใส่ดีฟอลต์เลข (ไม่ใช่สตริง)
    const viewUser = {
      ...me,
      level: Number(me.level || 1),
      totalSpent: Number(me.totalSpent || 0),
      avatarUrl: me.avatarUrl || '/static/assets/img/user-blue.png',
      emailVerified: !!me.emailVerified
    };

    // (4) ส่งค่าให้หน้า view
    res.render('account/index', {
      title: 'ตั้งค่าข้อมูลส่วนตัว',
      userDoc: viewUser,
      agg: { totalSpent: viewUser.totalSpent }, // ใช้ใน tab-points
      levels: LEVELS,                            // ใช้ render ระดับบัญชี
      bodyClass: 'page-account'
    });
  } catch (e) { next(e); }
});

/* ---------------- POST /account/profile ---------------- */
router.post('/account/profile', upload.single('avatar'), async (req, res) => {
  try {
    const uid = getAuthUserId(req);
    if (!uid) return res.status(401).json({ ok:false, error: 'unauthorized' });

    const u = await User.findById(uid);
    if (!u) return res.status(404).json({ ok:false, error: 'not found' });

    // อัปเดตรูป
    if (req.file) {
      u.avatarUrl = `/uploads/avatars/${req.file.filename}`;
    } else if (!u.avatarUrl) {
      u.avatarUrl = '/static/assets/img/user-blue.png';
    }

    // ชื่อ-นามสกุล (อนุญาตเฉพาะตอนยังว่าง)
    const fullName = String(req.body.name || '').trim();
    if (!u.name && fullName) u.name = fullName;

    // อีเมล (ตั้งครั้งแรกเท่านั้น)
    const emailInput = String(req.body.email || '').trim();
    if (!u.email && emailInput) {
      u.email = emailInput.toLowerCase();
      u.emailVerified = false;
    }

    // ensure type
    if (!u.level) u.level = 1;                       // เก็บเป็น Number
    if (u.totalSpent == null) u.totalSpent = 0;      // Number เช่นกัน

    await u.save();

    // เซฟโปรไฟล์เสร็จ ลองคำนวณ level จาก totalSpent อีกครั้งให้ตรงสูตร
    const nextLevel = computeLevel(Number(u.totalSpent || 0));
    if (nextLevel !== u.level) {
      u.level = nextLevel;
      await u.save();
    }

    return res.json({
      ok: true,
      user: {
        name: u.name,
        avatarUrl: u.avatarUrl,
        email: u.email,
        emailVerified: u.emailVerified,
        level: u.level,
        totalSpent: u.totalSpent
      }
    });
  } catch (e) {
    console.error('POST /account/profile', e);
    return res.status(500).json({ ok:false, error:'update failed' });
  }
});

/* ---------------- POST /account/password ---------------- */
router.post('/account/password', async (req, res) => {
  try {
    const uid = getAuthUserId(req);
    if (!uid) return res.status(401).json({ ok:false, error:'unauthorized' });

    const { currentPassword, newPassword } = req.body;
    const u = await User.findById(uid);
    if (!u) return res.status(404).json({ ok:false, error:'not found' });

    const ok = await u.verifyPassword(currentPassword || '');
    if (!ok) return res.status(400).json({ ok:false, error:'รหัสผ่านเดิมไม่ถูกต้อง' });

    await u.setPassword(String(newPassword || ''));
    await u.save();
    res.json({ ok:true });
  } catch (e) {
    console.error('POST /account/password', e);
    res.status(500).json({ ok:false, error:'change password failed' });
  }
});

/* ---------------- POST /account/email/request-otp ---------------- */
router.post('/account/email/request-otp', async (req, res) => {
  try {
    const uid = getAuthUserId(req);
    if (!uid) return res.status(401).json({ ok:false, error:'unauthorized' });

    const u = await User.findById(uid);
    if (!u?.email) return res.status(400).json({ ok:false, error:'ยังไม่มีอีเมลในบัญชี' });

    const email = String(u.email).toLowerCase();

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

    res.json({ ok:true, ttl: config.otp.ttlSec });
  } catch (e) {
    console.error('request-otp', e);
    res.status(500).json({ ok:false, error:'ส่งรหัสไม่สำเร็จ' });
  }
});

/* ---------------- POST /account/email/verify ---------------- */
router.post('/account/email/verify', async (req, res) => {
  try {
    const uid = getAuthUserId(req);
    if (!uid) return res.status(401).json({ ok:false, error:'unauthorized' });

    const { code } = req.body;
    const u = await User.findById(uid);
    if (!u?.email) return res.status(400).json({ ok:false, error:'ยังไม่มีอีเมลในบัญชี' });

    const email = String(u.email).toLowerCase();
    const doc = await OtpToken.findOne({ email, purpose: 'email-verify', usedAt: null })
      .sort({ createdAt: -1 });
    if (!doc) return res.status(400).json({ ok:false, error:'รหัสหมดอายุหรือไม่ถูกต้อง' });

    if (doc.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ ok:false, error:'รหัสหมดอายุ' });
    }
    if (doc.attempts >= doc.maxAttempts) {
      return res.status(400).json({ ok:false, error:'เกินจำนวนครั้งที่กำหนด' });
    }

    const ok = await bcrypt.compare(String(code||'').trim(), doc.codeHash);
    if (!ok) {
      doc.attempts += 1;
      await doc.save();
      return res.status(400).json({ ok:false, error:'รหัสไม่ถูกต้อง' });
    }

    // สำเร็จ → ปิด token และอัปเดต user
    doc.usedAt = new Date();
    await doc.save();

    u.emailVerified = true;
    await u.save();

    res.json({ ok:true });
  } catch (e) {
    console.error('verify-otp', e);
    res.status(500).json({ ok:false, error:'ยืนยันไม่สำเร็จ' });
  }
});

export default router;
