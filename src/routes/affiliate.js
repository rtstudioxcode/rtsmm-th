// routes/affiliate.js
import { Router } from 'express';
import { User } from '../models/User.js';

const router = Router();

// รองรับทั้ง ?=KEY และ ?ref=KEY
router.get('/aff', async (req, res) => {
  const raw = req.query[''] || req.query.ref || req.query['='] || '';
  const key = String(raw || '').trim();
  if (!key) return res.redirect('/register');

  // เก็บ cookie 30 วัน
  res.cookie('affiliate_ref', key, { httpOnly: true, maxAge: 30*24*3600*1000, sameSite:'lax' });
  return res.redirect('/register');
});

export default router;
