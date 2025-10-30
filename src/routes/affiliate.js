// routes/affiliate.js
import { Router } from 'express';

const router = Router();

// รองรับ ?=KEY, ?ref=KEY, ?k=KEY, ?key=KEY
router.get('/aff', async (req, res) => {
  const raw = req.query[''] || req.query.ref || req.query['='] || '';
  const key = String(raw || '').trim();
  if (!key) return res.redirect('/register');

  // เก็บ cookie 30 วัน
  res.cookie('affiliate_ref', key, { httpOnly: true, maxAge: 30*24*3600*1000, sameSite:'lax' });
  // ส่งต่อไป /register พร้อม aff ใน query
  return res.redirect(`/register?aff=${encodeURIComponent(key)}`);
});

export default router;
