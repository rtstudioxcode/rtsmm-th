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

const BRAND_URL  = 'https://rtsmm-th.com';
const BRAND_LOGO = `${BRAND_URL}/static/assets/logo/logo-rtssm-th.png`;

// สร้างรหัส 6 หลัก
function genCode() {
  return ('' + Math.floor(100000 + Math.random()*900000));
}

// หน้าตาอีเมล
function emailTemplate(code) {
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
              <h2 style="margin:0 0 4px;font-size:20px">รหัสยืนยันอีเมล (OTP)</h2>
              <p style="margin:0;color:#6b7280">ใช้รหัสด้านล่างเพื่อยืนยันอีเมลของคุณ ภายใน ${Math.floor((config.otp.ttlSec||300)/60)} นาที</p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 24px 24px">
              <div style="font-size:28px;font-weight:800;letter-spacing:8px;text-align:center;background:#f3f4f6;border-radius:10px;padding:14px 0;color:#111827;">
                ${code}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 24px 28px;color:#6b7280;font-size:12px;">
              หากคุณไม่ได้ร้องขอรหัสนี้ สามารถละเว้นอีเมลได้อย่างปลอดภัย
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
      html: emailTemplate(code),
      attachments: [{ filename:'logo-smm-th.png', path:'/static/assets/logo/logo-rtsmm-th.png', cid:'brandlogo' }]
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
