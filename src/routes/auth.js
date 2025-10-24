// src/routes/auth.js
import express from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import axios from 'axios';
import { OtpToken } from '../models/OtpToken.js';
import { sendEmail } from '../lib/mailer.js';
import crypto from 'crypto';

const router = express.Router();
const parseUrlencoded = express.urlencoded({ extended: false });

const BRAND_URL  = 'https://rtsmm-th.com';
const BRAND_LOGO = `${BRAND_URL}/static/assets/logo/logo-rtssm-th.png`;

/** util: ตรวจ path ภายในเว็บเราเท่านั้น */
function safeNext(input) {
  return (input && /^\/(?!\/)/.test(input)) ? input : '/';
}

function emailTemplateVerifyLink(verifyUrl) {
  return `
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 0;font-family:system-ui,-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e6e8eb;">
          <tr>
            <td style="background:#0b0f1a;padding:24px;text-align:center">
              <a href="${BRAND_URL}" target="_blank" style="text-decoration:none">
                <img src="${BRAND_LOGO}" alt="RTSMM-TH" height="42" style="display:inline-block;vertical-align:middle">
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 24px 8px;color:#111827;">
              <h2 style="margin:0 0 6px;font-size:20px">ยืนยันการสมัคร RTSMM-TH</h2>
              <p style="margin:0;color:#6b7280">คลิกปุ่มด้านล่างเพื่อยืนยันอีเมลและเปิดใช้งานบัญชีของคุณ</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px 24px" align="center">
              <a href="${verifyUrl}" target="_blank"
                 style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">
                 ยืนยันอีเมลของฉัน
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 24px;color:#6b7280;font-size:12px;">
              หากปุ่มกดไม่ได้ ให้คัดลอกลิงก์นี้ไปวางในเบราว์เซอร์ของคุณ:<br>
              <a href="${verifyUrl}" style="color:#2563eb">${verifyUrl}</a>
            </td>
          </tr>
          <tr>
            <td style="background:#f9fafb;color:#9ca3af;padding:16px 24px;text-align:center;font-size:12px;">
              © RTSMM-TH
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

// สุ่ม token แบบ base64url
function genToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url'); // Node 20+
}

/* =========================
 * LOGIN
 * ========================= */
router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  const next = typeof req.query.next === 'string' ? req.query.next : '/';
  res.render('auth/login', { title: 'เข้าสู่ระบบ', next });
});

router.post('/login', parseUrlencoded, async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const nextUrl  = safeNext(req.body.next);

    const user = await User.findOne({ username }).lean(false);
    if (!user) return res.status(400).json({ ok:false, message:'ไม่พบบัญชีผู้ใช้' });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ ok:false, message:'รหัสผ่านไม่ถูกต้อง' });

    req.session.user = { _id:String(user._id), username:user.username, role:user.role || 'user' };
    req.session.userId = String(user._id);
    await req.session.save();

    return res.json({ ok:true, redirect: nextUrl });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, message:'เกิดข้อผิดพลาด' });
  }
});

/* =========================
 * REGISTER (2-STEP with OTP)
 * 1) POST /register         -> ตรวจ/เก็บ regPending ใน session + ส่ง OTP อัตโนมัติ
 * 2) POST /register/finalize-> (หลัง verify สำเร็จ) ค่อยสร้าง user + login
 * ========================= */

/** GET /register */
router.get('/register', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  const next = typeof req.query.next === 'string' ? req.query.next : '/';
  res.render('auth/register', { title: 'สมัครสมาชิก', next });
});

/** POST /register  (init สมัคร + ส่งอีเมลปุ่มยืนยัน) */
router.post('/register', parseUrlencoded, async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const name     = (req.body.name || '').trim();        // ชื่อจริง
    const email    = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const nextUrl  = safeNext(req.body.next);

    if (!username || !name || !email || !password) {
      return res.status(400).json({ ok:false, message:'กรุณากรอกข้อมูลให้ครบ' });
    }

    const dup = await User.findOne({ $or: [{ username }, { email }] }).lean();
    if (dup) {
      return res.status(400).json({ ok:false, message: dup.username === username ? 'ชื่อผู้ใช้ถูกใช้งานแล้ว' : 'อีเมลถูกใช้งานแล้ว' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // เก็บ pending ใน session
    req.session.regPending = { username, name, email, passwordHash, nextUrl, createdAt: Date.now() };
    await req.session.save();

    // สร้าง token สำหรับลิงก์ยืนยัน
    const token = genToken(32);
    const codeHash = await bcrypt.hash(token, 10);

    // เก็บใน OtpToken (reuse)
    const ttlSec = 60 * 30; // 30 นาที
    await OtpToken.create({
      email,
      purpose: 'email-verify-link',
      codeHash,
      expiresAt: new Date(Date.now() + ttlSec * 1000),
      attempts: 0,
      maxAttempts: 10
    });

    // สร้างลิงก์
    const base = `${req.protocol}://${req.get('host')}`;
    const verifyUrl = `${base}/register/verify?e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;

    // ส่งอีเมลแบบ "ปุ่ม"
    await sendEmail({
      to: email,
      subject: 'ยืนยันการสมัคร RTSMM-TH',
      html: emailTemplateVerifyLink(verifyUrl)
    });

    return res.json({ ok:true, needOtp:false, message:'ส่งอีเมลยืนยันแล้ว โปรดตรวจสอบกล่องจดหมายของคุณ' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, message:'สมัครไม่สำเร็จ' });
  }
});

/** GET /register/verify  (จากลิงก์ในอีเมล) */
router.get('/register/verify', async (req, res) => {
  try {
    const email = String(req.query.e || '').trim().toLowerCase();
    const token = String(req.query.t || '').trim();

    const pending = req.session?.regPending;
    if (!pending || pending.email !== email) {
      return res.status(400).send('ลิงก์หมดอายุหรือเซสชันหมดอายุ กรุณาสมัครใหม่');
    }

    const doc = await OtpToken.findOne({ email, purpose:'email-verify-link', usedAt:null }).sort({ createdAt: -1 });
    if (!doc) return res.status(400).send('ลิงก์ไม่ถูกต้องหรือหมดอายุ');
    if (doc.expiresAt.getTime() < Date.now()) return res.status(400).send('ลิงก์หมดอายุ');

    const ok = await bcrypt.compare(token, doc.codeHash);
    if (!ok) return res.status(400).send('ลิงก์ไม่ถูกต้อง');

    // mark used
    doc.usedAt = new Date();
    await doc.save();

    // ป้องกันกรณีโดนแย่งชื่อก่อนกดลิงก์
    const dupe = await User.findOne({ $or: [{ username: pending.username }, { email: pending.email }] }).lean();
    if (dupe) {
      req.session.regPending = null;
      await req.session.save();
      return res.status(400).send('ข้อมูลซ้ำ กรุณาสมัครใหม่');
    }

    // สร้าง user + emailVerified:true
    const user = await User.create({
      username: pending.username,
      name: pending.name,
      email: pending.email,
      emailVerified: true,
      passwordHash: pending.passwordHash,
      role: 'user'
    });

    // login & redirect
    req.session.user = { _id:String(user._id), username:user.username, role:user.role || 'user' };
    req.session.userId = String(user._id);
    const redirect = pending.nextUrl || '/';
    req.session.regPending = null;
    await req.session.save();

    return res.redirect(redirect);
  } catch (e) {
    console.error(e);
    return res.status(500).send('ยืนยันไม่สำเร็จ');
  }
});

/* LOGOUT */
router.post('/logout', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      req.session?.destroy(err => (err ? reject(err) : resolve()));
    });
    res.clearCookie(process.env.SESSION_NAME || 'connect.sid', { path: '/' });
    return res.json({ ok:true, redirect:'/login' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, message:'ออกจากระบบไม่สำเร็จ' });
  }
});

router.get('/logout', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      req.session?.destroy(err => (err ? reject(err) : resolve()));
    });
    res.clearCookie(process.env.SESSION_NAME || 'connect.sid', { path: '/' });
  } catch (e) {
    console.error(e);
  }
  return res.redirect('/login');
});

export default router;
