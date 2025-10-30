// routes/affiliate.js
import { Router } from 'express';

const router = Router();

// รองรับ ?=KEY, ?ref=KEY, ?k=KEY, ?key=KEY
router.get('/aff', async (req, res) => {
  const raw =
    req.query.ref ??
    req.query.key ??
    req.query.k ??
    req.query['='] ??
    req.query[''] ??
    '';

  const key = String(raw || '').trim();
  if (!key) return res.redirect('/register'); // ไม่มีคีย์ก็พาไปสมัครเฉย ๆ

  // เก็บคีย์ไว้ในคุกกี้ 30 วัน
  res.cookie('affiliate_ref', key, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 3600 * 1000
  });

  // ✅ บังคับไปหน้า "สมัครสมาชิก" โดยส่งค่ากำกับไปด้วย
  return res.redirect(302, `/register?ref=${encodeURIComponent(key)}`);
});

export default router;
