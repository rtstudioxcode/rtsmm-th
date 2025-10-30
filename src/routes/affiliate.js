import { Router } from 'express';
const router = Router();

function pickAffKey(req) {
  // รองรับทั้ง aff, key, ref, r, k และคีย์ว่างจาก ?=xxxx
  let k =
    req.query.aff ??
    req.query.key ??
    req.query.ref ??
    req.query.r ??
    req.query.k ??
    req.query[''];

  // เผื่อบางรีเวิร์สพร็อกซีส่งมาเป็น “?=xxxx” ตรง ๆ
  if (!k && typeof req.url === 'string') {
    const qs = req.url.split('?')[1] || '';
    if (qs.startsWith('=')) k = decodeURIComponent(qs.slice(1));
  }
  return (k ?? '').toString().trim();
}

router.get('/aff', (req, res) => {
  const affKey = pickAffKey(req);
  const isSecure = req.secure || req.get('x-forwarded-proto') === 'https';

  if (affKey) {
    res.cookie('affiliate_ref', affKey, {
      path: '/',
      maxAge: 90 * 24 * 60 * 60 * 1000, // 90 วัน
      sameSite: 'lax',
      secure: isSecure,                 // ✅ เฉพาะ prod/https เท่านั้น
      httpOnly: false,                  // ให้ client-side อ่านได้ถ้าจำเป็น
    });
  }

  // แนบ affKey ไปที่ /register ด้วย
  const q = affKey ? `?aff=${encodeURIComponent(affKey)}` : '';
  return res.redirect(302, `/register${q}`);
});

export default router;
