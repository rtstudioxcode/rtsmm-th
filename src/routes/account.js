// routes/account.js
import mongoose from 'mongoose';
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';

// OTP ใหม่
import { OtpToken } from '../models/OtpToken.js';
import { sendEmail } from '../lib/mailer.js';
import { config } from '../config.js';

/* ==== NEW: loyalty & spend services (ไม่แตะ Order.js) ==== */
import { LEVELS, computeLevel } from '../services/loyalty.js';
import { recalcUserTotalSpent } from '../services/spend.js';

const BRAND_URL  = 'https://rtsmm-th.com';
const BRAND_LOGO = `${BRAND_URL}/static/assets/logo/logo-rtssm-th.png`;

/* ---------------- helpers ---------------- */
function getAuthUserId(req) {
  return (
    req.user?._id ||
    req.session?.user?._id ||
    req.res?.locals?.me?._id ||
    null
  );
}

function buildUserMatch(userId) {
  const idStr = String(userId || '');
  const asOid = mongoose.Types.ObjectId.isValid(idStr)
    ? new mongoose.Types.ObjectId(idStr)
    : null;

  const ors = [{ user: idStr }, { userId: idStr }];
  if (asOid) ors.push({ user: asOid }, { userId: asOid });
  return { $or: ors };
}

// รหัส 6 หลัก + เทมเพลตอีเมล
const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
export const emailTemplate = (code) => `
<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    html,body{margin:0!important;padding:0!important;background:#f4f6f8!important}
    img{border:0;outline:none;text-decoration:none;display:block;line-height:0}
    table,td{border-collapse:collapse!important}
    .container{width:560px;max-width:100%}

    /* แถบหัวแนวยาว โลโก้ชิดบนล่าง */
    .head{background:#0b0f1a;padding:3px 16px;text-align:center;line-height:0;mso-line-height-rule:exactly}
    .brand-logo{height:128px;width:auto;max-width:100%;margin:0 auto}

    @media(max-width:600px){
      .container{width:100%!important}
      .head{padding:0px 12px!important}
      .brand-logo{height:98px!important}
      .px{padding-left:16px!important;padding-right:16px!important}
    }

    .code{font-size:28px;font-weight:800;letter-spacing:8px;text-align:center;background:#f3f4f6;border-radius:10px;padding:14px 0;color:#111827}
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:16px 0;font-family:system-ui,-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial;">
    <tr>
      <td align="center">
        <table role="presentation" class="container" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e6e8eb;">
          <tr>
            <td class="head">
              <a href="${BRAND_URL}" target="_blank" style="text-decoration:none">
                <img src="${BRAND_LOGO}" alt="RTSMM-TH" class="brand-logo">
              </a>
            </td>
          </tr>

          <tr>
            <td class="px" style="padding:20px 24px 8px;color:#111827;">
              <h2 style="margin:0 0 4px;font-size:20px">ยืนยันอีเมลของคุณ</h2>
              <p style="margin:0;color:#6b7280">นี่คือรหัส OTP ของคุณ (ใช้ได้ภายใน ${Math.floor((config.otp.ttlSec||300)/60)} นาที)</p>
            </td>
          </tr>

          <tr>
            <td style="padding:10px 24px 24px">
              <div class="code">${code}</div>
            </td>
          </tr>

          <tr>
            <td style="padding:0 24px 20px;color:#6b7280;font-size:12px;">
              หากคุณไม่ได้ร้องขอรหัสนี้ สามารถละเว้นอีเมลได้อย่างปลอดภัย
            </td>
          </tr>

          <tr>
            <td style="background:#f9fafb;color:#9ca3af;padding:12px 20px;text-align:center;font-size:12px;">
              © RTSMM-TH
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

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
    if (!uid) return res.status(401).json({ ok:false, error: '⛔️คุณไม่ได้รับอนุญาต' });

    const u = await User.findById(uid);
    if (!u) return res.status(404).json({ ok:false, error: '⛔️ไม่พบข้อมูลผู้ใช้ เครือข่ายมีปัญหาโปรลองอีกครั้งภายหลัง' });

    // --- avatar ---
    if (req.file) {
      u.avatarUrl = `/uploads/avatars/${req.file.filename}`;
    } else if (!u.avatarUrl) {
      // ตั้งค่าเริ่มต้นถ้ายังไม่มี
      u.avatarUrl = '/static/assets/img/user-blue.png';
    }

    // --- ชื่อ/อีเมล (ตั้งครั้งแรกเท่านั้น) ---
    const fullName   = String(req.body.name  || '').trim();
    const emailInput = String(req.body.email || '').trim();
    if (!u.name && fullName)            u.name = fullName;
    if (!u.email && emailInput) { u.email = emailInput.toLowerCase(); u.emailVerified = false; }

    // --- ensure type ---
    if (!u.level) u.level = 1;
    if (u.totalSpent == null) u.totalSpent = 0;

    await u.save();

    // --- อัปเดตเลเวล/รวมออเดอร์ (ตามโค้ดเดิมของคุณ) ---
    const nextLevelNum = Number(computeLevel(Number(u.totalSpent || 0)));
    if (nextLevelNum !== Number(u.level)) { u.level = nextLevelNum; await u.save(); }

    try {
      const match = { ...buildUserMatch(u._id), status: { $ne: 'canceled' } };
      const counted = await Order.countDocuments(match);
      const cur = Number(u.totalOrders);
      if (!Number.isFinite(cur) || cur !== counted) { u.totalOrders = counted; await u.save(); }
    } catch (err) {
      console.warn('recount totalOrders failed:', err?.message || err);
    }

    // --- อัปเดต session/res.locals และคืน URL แบบกันแคชสำหรับแสดงผลทันที ---
    if (req.session?.user) req.session.user.avatarUrl = u.avatarUrl;
    res.locals.me = { ...(res.locals.me || {}), avatarUrl: u.avatarUrl };

    const bustUrl = `${u.avatarUrl}?v=${Date.now()}`; // ใช้โชว์ทันที กันรูปเก่าค้างแคช

    return res.json({
      ok: true,
      user: {
        name: u.name,
        avatarUrl: bustUrl,   // ใช้แสดงผลทันที
        avatarRaw: u.avatarUrl, // path จริงใน DB (ออปชัน)
        email: u.email,
        emailVerified: u.emailVerified,
        level: u.level,
        totalSpent: u.totalSpent,
        totalOrders: u.totalOrders ?? 0,
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
    if (!uid) return res.status(401).json({ ok:false, error:'⛔️คุณไม่ได้รับอนุญาต' });

    const { currentPassword, newPassword} = req.body;

    const u = await User.findById(uid);
    if (!u) return res.status(404).json({ ok:false, error:'⛔️ไม่พบข้อมูลผู้ใช้ เครือข่ายมีปัญหาโปรลองอีกครั้งภายหลัง' });

    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ ok:false, error:'⚠️รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัว a-z 0-9 !@#$' });
    }

    const ok = await bcrypt.compare(String(currentPassword || ''), u.passwordHash);
    if (!ok) return res.status(400).json({ ok:false, error:'⛔️รหัสผ่านเดิมไม่ถูกต้อง' });

    const same = await bcrypt.compare(String(newPassword), u.passwordHash);
    if (same) return res.status(400).json({ ok:false, error:'⚠️รหัสผ่านใหม่ซ้ำกับรหัสเดิม โปรดระบุรหัสผ่านใหม่อีกครั้ง' });

    await u.setPassword(String(newPassword || ''));
    await u.save();
    
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('POST /account/password', e);
    res.status(500).json({ ok:false, error:'⛔️เปลี่ยนรหัสผ่านไม่สำเร็จ เครือข่ายมีปัญหาโปรดลองอีกครั้งภายหลัง!' });
  }
});

/* ---------------- POST /account/email/request-otp ---------------- */
router.post('/account/email/request-otp', async (req, res) => {
  try {
    const uid = getAuthUserId(req);
    if (!uid) return res.status(401).json({ ok:false, error:'⛔️คุณไม่ได้รับอนุญาต' });

    const u = await User.findById(uid);
    if (!u?.email) return res.status(400).json({ ok:false, error:'⛔️ยังไม่มีอีเมลนี้ในบัญชี' });

    const email = String(u.email).toLowerCase();

    // cooldown
    const last = await OtpToken.findOne({ email, purpose: 'email-verify', usedAt: null })
      .sort({ createdAt: -1 });
    const now = Date.now();
    if (last?.lastSentAt && (now - last.lastSentAt.getTime()) < config.otp.resendCooldownSec*1000) {
      const wait = Math.ceil((config.otp.resendCooldownSec*1000 - (now - last.lastSentAt.getTime()))/1000);
      return res.status(429).json({ ok:false, error:`⏳โปรดรอ ${wait}s ก่อนขอรหัสใหม่` });
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
      html: emailTemplate(code),
      // attachments: [{ filename:'logo-smm-th.png', path:'/static/assets/logo/logo-rtsmm-th.png', cid:'brandlogo' }]
    });

    res.json({ ok:true, ttl: config.otp.ttlSec });
  } catch (e) {
    console.error('request-otp', e);
    res.status(500).json({ ok:false, error:'⛔️ส่งรหัสไม่สำเร็จ' });
  }
});

/* ---------------- POST /account/email/verify ---------------- */
router.post('/account/email/verify', async (req, res) => {
  try {
    const uid = getAuthUserId(req);
    if (!uid) return res.status(401).json({ ok:false, error:'⛔️คุณไม่ได้รับอนุญาต' });

    const { code } = req.body;
    const u = await User.findById(uid);
    if (!u?.email) return res.status(400).json({ ok:false, error:'⛔️ยังไม่มีอีเมลในบัญชี' });

    const email = String(u.email).toLowerCase();
    const doc = await OtpToken.findOne({ email, purpose: 'email-verify', usedAt: null })
      .sort({ createdAt: -1 });
    if (!doc) return res.status(400).json({ ok:false, error:'⛔️รหัสหมดอายุหรือไม่ถูกต้อง' });

    if (doc.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ ok:false, error:'⛔️รหัสหมดอายุ' });
    }
    if (doc.attempts >= doc.maxAttempts) {
      return res.status(400).json({ ok:false, error:'⛔️เกินจำนวนครั้งที่กำหนด' });
    }

    const ok = await bcrypt.compare(String(code||'').trim(), doc.codeHash);
    if (!ok) {
      doc.attempts += 1;
      await doc.save();
      return res.status(400).json({ ok:false, error:'⛔️รหัสไม่ถูกต้อง' });
    }

    // สำเร็จ → ปิด token และอัปเดต user
    doc.usedAt = new Date();
    await doc.save();

    u.emailVerified = true;
    await u.save();

    res.json({ ok:true });
  } catch (e) {
    console.error('verify-otp', e);
    res.status(500).json({ ok:false, error:'⛔️ยืนยันไม่สำเร็จ' });
  }
});

export default router;
