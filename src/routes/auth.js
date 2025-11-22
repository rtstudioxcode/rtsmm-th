// src/routes/auth.js
import express from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { OtpToken } from '../models/OtpToken.js';
import { sendEmail } from '../lib/mailer.js';
import crypto from 'crypto';
import { config } from '../config.js';

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

async function verifyTurnstile(token, remoteIp) {
  const secret = config.turnstile?.secretKey || '';

  // ถ้าไม่ได้ตั้ง secret ไว้ (เช่น dev) ให้ผ่านไปเลย
  if (!secret) return true;

  if (!token) return false;

  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: remoteIp || '',
      }),
    });

    const data = await resp.json();
    return !!data.success;
  } catch (err) {
    console.error('Turnstile verify error', err);
    // ถ้า error ให้ถือว่าไม่ผ่าน เพื่อกัน bot
    return false;
  }
}

/* =========================
 * LOGIN
 * ========================= */
router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  const next = typeof req.query.next === 'string' ? req.query.next : '/';
  res.render('auth/login', {
    title: 'เข้าสู่ระบบ',
    next,
    turnstileSiteKey: config.turnstile?.siteKey || '',
  });
});

router.post('/login', parseUrlencoded, async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const nextUrl  = safeNext(req.body.next);

    // ✅ ดึง Turnstile token จากฟอร์ม (ชื่อฟิลด์มาตรฐานของ Cloudflare)
    const token =
      req.body['cf-turnstile-response'] ||
      req.body['cf_challenge_response'] ||
      '';

    const human = await verifyTurnstile(token, req.ip);
    if (!human) {
      return res.status(400).json({
        ok: false,
        message: '⚠️ กรุณายืนยันว่าคุณเป็นมนุษย์ก่อนเข้าสู่ระบบ',
      });
    }

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

  // ดึง affKey จาก query (รองรับคีย์ว่าง)
  const aff =
    (req.query.aff ?? req.query.key ?? req.query.ref ?? req.query.r ?? req.query.k ?? req.query[''] ?? '')
      .toString().trim();

  const isSecure = req.secure || req.get('x-forwarded-proto') === 'https';
  if (aff) {
    res.cookie('affiliate_ref', aff, {
      path: '/',
      maxAge: 90 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      secure: isSecure,
      httpOnly: false,
    });
  }

  const next = typeof req.query.next === 'string' ? req.query.next : '/';
  res.render('auth/register', { title: 'สมัครสมาชิก', next, aff }); // ส่ง aff ไปให้ ejs ด้วย
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

    // ---------- ผ่านทุกเงื่อนไข -> เก็บ pending + ส่งอีเมลยืนยัน ----------
    const passwordHash = await bcrypt.hash(password, 10);

    // ✅ รับทั้งจาก body และ cookie (รองรับกรณี /register?aff=xxx ใส่ hidden ลงฟอร์มหรือเซ็ตคุกกี้ไว้แล้ว)
    const affKey = (req.body.aff || req.cookies?.affiliate_ref || '').trim();

    req.session.regPending = {
      username,
      name,
      email,
      passwordHash,
      nextUrl,
      affKey,                 // ✅ เก็บไว้ใช้ตอน verify
      createdAt: Date.now()
    };
    await req.session.save();

    // ออก OTP/ลิงก์ยืนยัน
    const token    = genToken(32);
    const codeHash = await bcrypt.hash(token, 10);
    const ttlSec   = 60 * 30;

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
      subject: 'ยืนยันการสมัครสมาชิก RTSMM-TH',
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
        title:'สมัครสมาชิก', next:'/',
        flash:{ variant:'error', title:'ลิงก์หมดอายุ', text:'⛔️ลิงก์หมดอายุหรือเซสชันหมดอายุ กรุณาสมัครใหม่' }
      });
    }

    const doc = await OtpToken.findOne({ email, purpose:'email-verify-link', usedAt:null }).sort({ createdAt:-1 });
    if (!doc) {
      return res.status(400).render('auth/register', {
        title:'สมัครสมาชิก', next:'/',
        flash:{ variant:'error', title:'ลิงก์ไม่ถูกต้อง', text:'⚠️ลิงก์ไม่ถูกต้องหรือหมดอายุ' }
      });
    }
    if (doc.expiresAt.getTime() < Date.now()) {
      return res.status(400).render('auth/register', {
        title:'สมัครสมาชิก', next:'/',
        flash:{ variant:'error', title:'ลิงก์หมดอายุ', text:'⛔️ลิงก์นี้หมดอายุแล้ว กรุณาสมัครใหม่' }
      });
    }
    const ok = await bcrypt.compare(token, doc.codeHash);
    if (!ok) {
      return res.status(400).render('auth/register', {
        title:'สมัครสมาชิก', next:'/',
        flash:{ variant:'error', title:'ลิงก์ไม่ถูกต้อง', text:'⛔️ไม่สามารถยืนยันอีเมลจากลิงก์นี้' }
      });
    }

    // mark used
    doc.usedAt = new Date();
    await doc.save();

    // กันโดนแย่งชื่อก่อนคลิกลิงก์
    const dupe = await User.findOne({ $or: [{ username: pending.username }, { email: pending.email }] }).lean();
    if (dupe) {
      req.session.regPending = null;
      await req.session.save();
      return res.status(400).render('auth/register', {
        title:'สมัครสมาชิก', next:'/',
        flash:{ variant:'warn', title:'ข้อมูลซ้ำ', text:'⚠️ชื่อผู้ใช้หรืออีเมลถูกใช้งานแล้ว กรุณาสมัครใหม่' }
      });
    }

    // ✅ ให้ session มาก่อน ถ้าไม่มีค่อยคุกกี้
    const refKey =
      (pending.affKey && String(pending.affKey).trim()) ||
      (req.cookies?.affiliate_ref && String(req.cookies.affiliate_ref).trim()) ||
      '';

    let referredById = null;
    if (refKey) {
      const refUser = await User.findOne({ affiliateKey: refKey }).select('_id');
      if (refUser?._id) referredById = refUser._id;
    }

    // สร้าง user (แนบ referredBy ถ้ามี)
    const user = await User.create({
      username: pending.username,
      name: pending.name,
      email: pending.email,
      emailVerified: true,
      passwordHash: pending.passwordHash,
      role: 'user',
      ...(referredById ? { referredBy: referredById } : {})
    });

    // เพิ่มตัวนับให้ผู้แนะนำ + ล้างคุกกี้ (ต้องใช้ออปชันตรงกับตอนเซ็ต)
    if (referredById) {
      User.updateOne(
        { _id: referredById },
        { $inc: { 'affiliate.referredCount': 1 } }
      ).catch(()=>{});
      try {
        const isSecure = req.secure || (req.get('x-forwarded-proto') === 'https');
        res.clearCookie('affiliate_ref', { path:'/', sameSite:'lax', secure:isSecure });
      } catch {}
    }

    // login & redirect
    req.session.user   = { _id:String(user._id), username:user.username, role:user.role || 'user' };
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
