// src/routes/auth.js
import express from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { OtpToken } from '../models/OtpToken.js';
import { sendEmail } from '../lib/mailer.js';
import { normalizeAndValidateAccount } from '../lib/banks.js';
import crypto from 'crypto';

const router = express.Router();
const parseUrlencoded = express.urlencoded({ extended: false });

/** util: ตรวจ path ภายในเว็บเราเท่านั้น */
function safeNext(input) {
  return (input && /^\/(?!\/)/.test(input)) ? input : '/';
}

function emailTemplateVerifyLink(verifyUrl) {
  const BRAND_URL  = 'https://rtsmm-th.com';
  const BRAND_LOGO = `${BRAND_URL}/static/assets/logo/logo-rtssm-th.png`;

  // โลโก้สูง (ยึดความสูงแทนความกว้าง เพื่อให้เต็มแถบมากขึ้น)
  const LOGO_H_DESKTOP = 128; // ปรับได้ 88–104
  const LOGO_H_MOBILE  = 98;

  return `
  <!doctype html>
  <html lang="th">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <style>
      html,body{margin:0!important;padding:0!important;background:#f4f6f8!important}
      img{border:0;outline:none;text-decoration:none;display:block;line-height:0}
      table,td{border-collapse:collapse!important}
      a{color:#2563eb}
      .container{width:560px;max-width:100%}
      /* แถบหัวแนวยาว โลโก้ชิดบนล่าง */
      .head{background:#0b0f1a;padding:3px 16px;text-align:center;line-height:0;mso-line-height-rule:exactly}
      .brand-logo{height:${LOGO_H_DESKTOP}px;width:auto;max-width:100%;margin:0 auto}
      @media(max-width:600px){
        .container{width:100%!important}
        .px{padding-left:16px!important;padding-right:16px!important}
        .head{padding:0px 12px!important}
        .brand-logo{height:${LOGO_H_MOBILE}px!important}
      }
      .btn{background:#111827;border-radius:8px;color:#fff!important;display:inline-block;font-weight:700;text-decoration:none;padding:12px 22px}
    </style>
  </head>
  <body style="margin:0;padding:0;background:#f4f6f8;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:16px 0;font-family:system-ui,-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial,sans-serif;">
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
                <h2 style="margin:0 0 6px;font-size:20px">ยืนยันการสมัคร RTSMM-TH</h2>
                <p style="margin:0;color:#6b7280">คลิกปุ่มด้านล่างเพื่อยืนยันอีเมลและเปิดใช้งานบัญชีของคุณ</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px 20px" align="center">
                <a href="${verifyUrl}" target="_blank" class="btn">ยืนยันอีเมลของฉัน</a>
              </td>
            </tr>
            <tr>
              <td class="px" style="padding:0 24px 20px;color:#6b7280;font-size:12px;">
                หากปุ่มกดไม่ได้ ให้คัดลอกลิงก์นี้ไปวางในเบราว์เซอร์ของคุณ:<br>
                <a href="${verifyUrl}" style="color:#2563eb;word-break:break-all">${verifyUrl}</a>
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
    if (!user) return res.status(400).json({ ok:false, message:'⚠️ไม่พบบัญชีผู้ใช้' });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ ok:false, message:'⛔️รหัสผ่านไม่ถูกต้อง' });

    req.session.user = { _id:String(user._id), username:user.username, role:user.role || 'user' };
    req.session.userId = String(user._id);
    await req.session.save();

    return res.json({ ok:true, redirect: nextUrl });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, message:'⚠️เกิดข้อผิดพลาด' });
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
    const name     = (req.body.name || '').trim();
    const emailRaw = (req.body.email || '').trim();
    const email    = emailRaw.toLowerCase();
    const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const password = req.body.password || '';
    const nextUrl  = safeNext(req.body.next);

    // ---------- ดึงบัญชีจากฟอร์ม ----------
    const codes   = Array.isArray(req.body.accountCode)   ? req.body.accountCode   : [req.body.accountCode].filter(Boolean);
    const numbers = Array.isArray(req.body.accountNumber) ? req.body.accountNumber : [req.body.accountNumber].filter(Boolean);
    const names   = Array.isArray(req.body.accountName)   ? req.body.accountName   : [req.body.accountName].filter(Boolean);

    const accs = [];
    const maxLen = Math.max(codes.length, numbers.length, names.length);
    for (let i = 0; i < maxLen; i++) {
      const cc = (codes[i]   || '').trim();
      const nn = (numbers[i] || '').trim();
      const an = (names[i]   || '').trim();
      if (!cc && !nn && !an) continue;           // แถวว่าง ข้าม
      if (!cc || !nn || !an) {
        return res.status(400).json({ ok:false, message:'⚠️ กรุณากรอกข้อมูลบัญชีให้ครบทุกช่อง' });
      }
      const v = normalizeAndValidateAccount({ accountCode: cc, accountNumber: nn });
      if (!v.ok) return res.status(400).json({ ok:false, message: v.error });
      accs.push({ accountCode: v.code, accountNumber: v.number, accountName: an });
    }

    // ต้องมี 1–2 บัญชี
    if (accs.length < 1 || accs.length > 2) {
      return res.status(400).json({ ok:false, message:'⚠️ ต้องมีบัญชีอย่างน้อย 1 และไม่เกิน 2 บัญชี' });
    }

    // กันซ้ำภายในแบบฟอร์มเดียวกัน
    const sig = a => `${a.accountCode}#${a.accountNumber}`;
    const hasDupInForm = new Set(accs.map(sig)).size !== accs.length;
    if (hasDupInForm) {
      return res.status(400).json({ ok:false, message:'⚠️ มีเลขบัญชีซ้ำกันภายในแบบฟอร์ม' });
    }

    // ---------- ตรวจข้อมูลผู้ใช้พื้นฐาน ----------
    if (!username || !name || !email || !password) {
      return res.status(400).json({ ok:false, message:'⚠️กรุณากรอกข้อมูลให้ครบ' });
    }
    if (!isValidEmail) {
      return res.status(400).json({ ok:false, message:'⚠️ อีเมลไม่ถูกต้อง' });
    }

    const dupUser = await User.findOne({ $or: [{ username }, { email }] }).lean();
    if (dupUser) {
      return res.status(400).json({
        ok:false,
        message: dupUser.username === username ? '⚠️ชื่อผู้ใช้ถูกใช้งานแล้ว' : '⚠️อีเมลถูกใช้งานแล้ว'
      });
    }

    // ---------- กันซ้ำข้ามผู้ใช้: 1 บัญชีใช้ได้แค่ 1 ยูส ----------
    const usedByOther = await User.findOne({
      $or: accs.map(a => ({
        bankAccounts: { $elemMatch: { accountCode: a.accountCode, accountNumber: a.accountNumber } }
      }))
    }).lean();

    if (usedByOther) {
      return res.status(409).json({
        ok:false,
        message:'บัญชีนี้ถูกใช้งานอยู่ในผู้ใช้อื่นแล้ว (1 บัญชีใช้ได้เพียง 1 ผู้ใช้)'
      });
    }

    // ---------- ผ่านทุกเงื่อนไข -> เก็บ pending + ส่งอีเมลยืนยัน ----------
    const passwordHash = await bcrypt.hash(password, 10);

    req.session.regPending = {
      username,
      name,
      email,
      passwordHash,
      nextUrl,
      bankAccounts: accs,   // << เก็บลง field ให้ตรง schema
      createdAt: Date.now()
    };
    await req.session.save();

    const token   = genToken(32);
    const codeHash = await bcrypt.hash(token, 10);
    const ttlSec   = 60 * 30; // 30 นาที

    await OtpToken.create({
      email,
      purpose: 'email-verify-link',
      codeHash,
      expiresAt: new Date(Date.now() + ttlSec * 1000),
      attempts: 0,
      maxAttempts: 10
    });

    const base = `${req.protocol}://${req.get('host')}`;
    const verifyUrl = `${base}/register/verify?e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;

    await sendEmail({
      to: email,
      subject: 'ยืนยันการสมัคร RTSMM-TH',
      html: emailTemplateVerifyLink(verifyUrl),
    });

    return res.json({ ok:true, needOtp:false, message:'✅ส่งอีเมลยืนยันแล้ว โปรดตรวจสอบกล่องจดหมายของคุณ' });
  } catch (e) {
    console.error('POST /register', e);
    return res.status(500).json({ ok:false, message:'⛔️สมัครไม่สำเร็จ' });
  }
});

/** GET /register/verify  (จากลิงก์ในอีเมล) */
router.get('/register/verify', async (req, res) => {
  try {
    const email = String(req.query.e || '').trim().toLowerCase();
    const token = String(req.query.t || '').trim();

    const pending = req.session?.regPending;
    if (!pending || pending.email !== email) {
      return res.status(400).render('auth/register', {
        title: 'สมัครสมาชิก',
        next: '/',
        flash: { variant:'error', title:'ลิงก์หมดอายุ', text:'⛔️ลิงก์หมดอายุหรือเซสชันหมดอายุ กรุณาสมัครใหม่' }
      });
    }

    const doc = await OtpToken.findOne({ email, purpose:'email-verify-link', usedAt:null }).sort({ createdAt: -1 });
    if (!doc) return res.status(400).render('auth/register', {
      title:'สมัครสมาชิก', next:'/',
      flash:{ variant:'error', title:'ลิงก์ไม่ถูกต้อง', text:'⚠️ลิงก์ไม่ถูกต้องหรือหมดอายุ' }
    });
    if (doc.expiresAt.getTime() < Date.now()) return res.status(400).render('auth/register', {
      title:'สมัครสมาชิก', next:'/',
      flash:{ variant:'error', title:'ลิงก์หมดอายุ', text:'⛔️ลิงก์นี้หมดอายุแล้ว กรุณาสมัครใหม่' }
    });

    const ok = await bcrypt.compare(token, doc.codeHash);
    if (!ok) return res.status(400).render('auth/register', {
      title:'สมัครสมาชิก', next:'/',
      flash:{ variant:'error', title:'ลิงก์ไม่ถูกต้อง', text:'⛔️ไม่สามารถยืนยันอีเมลจากลิงก์นี้' }
    });

    // mark used
    doc.usedAt = new Date();
    await doc.save();

    // ป้องกันกรณีโดนแย่งชื่อก่อนกดลิงก์
    const dupe = await User.findOne({ $or: [{ username: pending.username }, { email: pending.email }] }).lean();
    if (dupe) {
      req.session.regPending = null;
      await req.session.save();
      return res.status(400).render('auth/register', {
        title:'สมัครสมาชิก', next:'/',
        flash:{ variant:'warn', title:'ข้อมูลซ้ำ', text:'⚠️ชื่อผู้ใช้หรืออีเมลถูกใช้งานแล้ว กรุณาสมัครใหม่' }
      });
    }

    // สร้าง user + emailVerified:true
    const user = await User.create({
      username: pending.username,
      name: pending.name,
      email: pending.email,
      emailVerified: true,
      passwordHash: pending.passwordHash,
      role: 'user',
      bankAccounts: Array.isArray(pending.bankAccounts) ? pending.bankAccounts : []
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
    return res.status(500).render('auth/register', {
      title:'สมัครสมาชิก', next:'/',
      flash:{ variant:'error', title:'ยืนยันไม่สำเร็จ', text:'⛔️เกิดข้อผิดพลาด โปรดลองใหม่อีกครั้ง' }
    });
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
    return res.status(500).json({ ok:false, message:'⛔️ออกจากระบบไม่สำเร็จ' });
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
