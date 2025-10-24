// src/routes/reset-password.js
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { User } from '../models/User.js';
import { OtpToken } from '../models/OtpToken.js';
import { sendEmail } from '../lib/mailer.js';

const router = Router();

const BRAND_URL  = 'https://rtsmm-th.com';
const BRAND_LOGO = `${BRAND_URL}/static/assets/logo/logo-rtssm-th.png`;

function emailTemplateResetLink(resetUrl) {
  const LOGO_H_DESKTOP = 128;  // สูงโลโก้เดสก์ท็อป (ปรับได้ 64–84)
  const LOGO_H_MOBILE  = 98;  // มือถือ
  return `
  <!doctype html><html lang="th"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      html,body{margin:0!important;padding:0!important;background:#f4f6f8!important}
      img{border:0;line-height:0;outline:none;text-decoration:none;display:block}
      table,td{border-collapse:collapse!important}
      .container{width:560px;max-width:100%}
      /* แบนเนอร์หัว: เตี้ยและยาว */
      .head{background:#0b0f1a;padding:0px 16px;text-align:center}
      .logo{height:${LOGO_H_DESKTOP}px;width:auto;max-width:100%;margin:0 auto}
      @media(max-width:600px){
        .container{width:100%!important}
        .logo{height:${LOGO_H_MOBILE}px!important}
      }
      .px{padding:16px 20px 6px}
      .cta{padding:12px 20px 16px}
      .btn{background:#111827;border-radius:8px;color:#fff!important;display:inline-block;font-weight:700;text-decoration:none;padding:12px 22px}
    </style></head>
  <body>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:16px 0;font-family:system-ui,-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial">
      <tr><td align="center">
        <table role="presentation" class="container" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e6e8eb">
          <tr>
            <td class="head">
              <a href="${BRAND_URL}" target="_blank" style="text-decoration:none">
                <img src="${BRAND_LOGO}" alt="RTSMM-TH" class="logo">
              </a>
            </td>
          </tr>
          <tr><td class="px">
            <h2 style="margin:0 0 6px">รีเซ็ตรหัสผ่าน RTSMM-TH</h2>
            <p style="margin:0;color:#6b7280">กดปุ่มด้านล่างเพื่อตั้งรหัสผ่านใหม่</p>
          </td></tr>
          <tr><td class="cta" align="center">
            <a href="${resetUrl}" class="btn" target="_blank">รีเซ็ตรหัสผ่าน</a>
          </td></tr>
          <tr><td style="padding:0 20px 16px;color:#6b7280;font-size:12px">
            หากปุ่มกดไม่ได้ คัดลอกลิงก์นี้: <a href="${resetUrl}" style="color:#2563eb;word-break:break-all">${resetUrl}</a>
          </td></tr>
          <tr><td style="background:#f9fafb;color:#9ca3af;padding:12px 20px;text-align:center;font-size:12px">
            © RTSMM-TH
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

function emailTemplateVerifyLink(verifyUrl) {
  const LOGO_H_DESKTOP = 128;  // สูงโลโก้เดสก์ท็อป (ปรับได้ 64–84)
  const LOGO_H_MOBILE  = 98;  // มือถือ
  return `
  <!doctype html><html lang="th"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      html,body{margin:0!important;padding:0!important;background:#f4f6f8!important}
      img{border:0;line-height:0;outline:none;text-decoration:none;display:block}
      table,td{border-collapse:collapse!important}
      .container{width:560px;max-width:100%}
      .head{background:#0b0f1a;padding:0px 16px;text-align:center}
      .logo{height:${LOGO_H_DESKTOP}px;width:auto;max-width:100%;margin:0 auto}
      @media(max-width:600px){
        .container{width:100%!important}
        .logo{height:${LOGO_H_MOBILE}px!important}
      }
      .px{padding:16px 20px 6px}
      .cta{padding:12px 20px 16px}
      .btn{background:#111827;border-radius:8px;color:#fff!important;display:inline-block;font-weight:700;text-decoration:none;padding:12px 22px}
    </style></head>
  <body>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:16px 0;font-family:system-ui,-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial">
      <tr><td align="center">
        <table role="presentation" class="container" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e6e8eb">
          <tr>
            <td class="head">
              <a href="${BRAND_URL}" target="_blank" style="text-decoration:none">
                <img src="${BRAND_LOGO}" alt="RTSMM-TH" class="logo">
              </a>
            </td>
          </tr>
          <tr><td class="px">
            <h2 style="margin:0 0 6px">ยืนยันอีเมลของคุณ</h2>
            <p style="margin:0;color:#6b7280">โปรดกดปุ่มด้านล่างเพื่อยืนยัน</p>
          </td></tr>
          <tr><td class="cta" align="center">
            <a href="${verifyUrl}" class="btn" target="_blank">ยืนยันอีเมล</a>
          </td></tr>
          <tr><td style="padding:0 20px 16px;color:#6b7280;font-size:12px">
            หากปุ่มกดไม่ได้ คัดลอกลิงก์นี้: <a href="${verifyUrl}" style="color:#2563eb;word-break:break-all">${verifyUrl}</a>
          </td></tr>
          <tr><td style="background:#f9fafb;color:#9ca3af;padding:12px 20px;text-align:center;font-size:12px">
            © RTSMM-TH
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

/* ========== 1) ขอรีเซ็ต: ส่งอีเมลลิงก์ ========== */
// POST /password/forgot  { email }
router.post('/password/forgot', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok:false, code:'bad_request', error:'กรอกอีเมล' });

    const user = await User.findOne({ email }).select('_id email username emailVerified').lean();
    if (!user) {
      // แจ้งชัดเจนตามที่ต้องการ
      return res.status(404).json({ ok:false, code:'not_found', error:'ยังไม่มีอีเมลนี้ในระบบ โปรดลองสมัครใหม่ดูก่อน' });
    }

    // ถ้ายังไม่ยืนยันอีเมล -> ส่งลิงก์ยืนยันก่อน
    if (!user.emailVerified) {
      const token = crypto.randomBytes(32).toString('base64url');
      const hash  = await bcrypt.hash(token, 10);

      await OtpToken.create({
        email,
        purpose: 'email-verify-link',
        codeHash: hash,
        expiresAt: new Date(Date.now() + 1000 * 60 * 30),
        attempts: 0,
        maxAttempts: 10
      });

      const base = `${req.protocol}://${req.get('host')}`;
      const verifyUrl = `${base}/register/verify?e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;

      // fire-and-forget เพื่อความไว
      Promise.resolve(
        sendEmail({ to: email, subject: 'ยืนยันอีเมล RTSMM-TH', html: emailTemplateVerifyLink(verifyUrl) })
      ).catch(err => console.error('send verify email failed:', err?.message || err));

      return res.status(409).json({
        ok:false,
        code:'need_verify',
        error:'บัญชีนี้ยังไม่ได้ยืนยันอีเมล — ได้ส่งลิงก์ยืนยันให้แล้ว โปรดยืนยันก่อน'
      });
    }

    // verified แล้ว -> สร้างลิงก์ reset
    const token = crypto.randomBytes(32).toString('base64url');
    const hash  = await bcrypt.hash(token, 10);

    const doc = await OtpToken.create({
      email,
      purpose: 'password-reset-link',
      codeHash: hash,
      expiresAt: new Date(Date.now() + 1000 * 60 * 30),
      attempts: 0,
      maxAttempts: 10
    });

    const base = `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${base}/password/reset/${encodeURIComponent(token)}?e=${encodeURIComponent(email)}`;

    // fire-and-forget ส่งให้ไว
    Promise.resolve(
      sendEmail({ to: email, subject: 'รีเซ็ตรหัสผ่าน RTSMM-TH', html: emailTemplateResetLink(resetUrl) })
    ).catch(err => console.error('send reset email failed:', err?.message || err));

    // ตอบไว ไม่รอ SMTP
    return res.json({ ok:true, message:'ส่งลิงก์รีเซ็ตไปยังกล่องข้อความในอีเมลของคุณแล้ว' });
  } catch (e) {
    console.error('forgot password error:', e);
    return res.status(500).json({ ok:false, code:'server_error', error:'ส่งอีเมลไม่สำเร็จ' });
  }
});

/* ========== 2) ผู้ใช้กดลิงก์: ตรวจ token แล้ว “ออกบัตรผ่าน” ใน session ========== */
// GET /password/reset/:token?e=...
router.get('/password/reset/:token', async (req, res) => {
  // helper: ตั้ง flash แล้ว redirect ไปหน้า login
  const goLogin = async (title, text = '', variant = 'error') => {
    req.session.flash = { variant, icon: (variant === 'success' ? '✅' : '✖'), title, text };
    await req.session.save();               // ✅ สำคัญ ต้อง save ก่อน redirect
    return res.redirect('/login');
  };

  try {
    const token = String(req.params.token || '').trim();
    const email = String(req.query.e || '').trim().toLowerCase();
    if (!token || !email) {
      return goLogin('ลิงก์ไม่ถูกต้อง', 'โปรดลองกดลืมรหัสผ่านใหม่อีกครั้ง');
    }

    const doc = await OtpToken
      .findOne({ email, purpose: 'password-reset-link', usedAt: null })
      .sort({ createdAt: -1 });

    if (!doc) {
      return goLogin('ลิงก์หมดอายุหรือถูกใช้งานไปแล้ว!', 'หากต้องการรีเซ็ตรหัสผ่านใหม่ให้กดลืมรหัสผ่านใหม่อีกครั้ง');
    }
    if (doc.expiresAt.getTime() < Date.now()) {
      return goLogin('ลิงก์หมดอายุแล้ว', 'โปรดลองกดลืมรหัสผ่านใหม่อีกครั้ง');
    }

    const ok = await bcrypt.compare(token, doc.codeHash);
    if (!ok) {
      return goLogin('ลิงก์ไม่ถูกต้อง', 'โปรดลองกดลืมรหัสผ่านใหม่อีกครั้ง');
    }

    // ผ่าน → ออก grant ใน session แล้วพาไป /login ให้ modal ตั้งรหัสผ่านแสดง
    req.session.resetGrant = { email, tokenId: String(doc._id) };
    await req.session.save();
    return res.redirect('/login');          // layout จะเปิด modal จาก window.__rp.allowed
  } catch (e) {
    console.error('reset link error:', e);
    return goLogin('เกิดข้อผิดพลาด', 'โปรดลองใหม่อีกครั้งภายหลัง');
  }
});

/* ========== 3) ยกเลิก (ปิด modal) ========== */
// POST /password/reset/cancel
router.post('/password/reset/cancel', async (req, res) => {
  try {
    if (req.session.resetGrant) {
      req.session.resetGrant = null;
      await req.session.save();
    }
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false });
  }
});

/* ========== 4) บันทึกรหัสใหม่ (ใช้ grant ใน session เท่านั้น) ========== */
// POST /password/reset  { newPassword }
router.post('/password/reset', async (req, res) => {
  try {
    const grant = req.session.resetGrant;
    const newPassword = String(req.body.newPassword || '');

    if (!grant?.email || !grant?.tokenId) {
      return res.status(400).json({ ok:false, error:'ไม่มีสิทธิรีเซ็ตหรือ Token หมดอายุแล้ว โปรดกดลืมรหัสผ่านใหม่อีกครั้ง' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ ok:false, error:'รหัสสั้นเกินไป โปรดใส่มากกว่า 6 ตัว' });
    }

    const doc = await OtpToken.findOne({ _id: grant.tokenId, email: grant.email, purpose:'password-reset-link', usedAt:null });
    if (!doc) return res.status(400).json({ ok:false, error:'ลิงก์หมดอายุหรือถูกใช้ไปแล้ว' });
    if (doc.expiresAt.getTime() < Date.now()) return res.status(400).json({ ok:false, error:'ลิงก์หมดอายุแล้ว' });

    // ตั้งรหัสใหม่
    const u = await User.findOne({ email: grant.email });
    if (!u) return res.status(404).json({ ok:false, error:'ไม่พบบัญชี' });
    await u.setPassword(newPassword);
    await u.save();

    // ปิด token + ล้าง grant
    doc.usedAt = new Date();
    await doc.save();
    req.session.resetGrant = null;
    await req.session.save();

    // login อัตโนมัติ
    req.session.user = { _id: String(u._id), username: u.username, role: u.role || 'user' };
    await req.session.save();

    return res.json({ ok:true });
  } catch (e) {
    console.error('reset password error:', e);
    res.status(500).json({ ok:false, error:'รีเซ็ตรหัสผ่านไม่สำเร็จ' });
  }
});

export default router;
