// routes/wallet.js
import { Router } from 'express';
import { User } from '../models/User.js';

const router = Router();

// แสดงยอดเงินตัวเอง
router.get('/wallet', async (req, res) => {
  if (!req.session?.user) return res.redirect('/login');
  const u = await User.findById(req.session.user._id).select('balance currency');
  res.render('wallet/me', { title: 'กระเป๋าเงิน', balance: u?.balance || 0, currency: u?.currency || 'THB' });
});

// เติมเงินแบบ manual (เฉพาะ admin)
router.post('/wallet/add', async (req, res) => {
  if (req.session?.user?.role !== 'admin') return res.status(403).send('forbidden');
  const { userId, amount } = req.body;
  const u = await User.findById(userId);
  if (!u) return res.status(404).send('not found');
  await u.addBalance(Number(amount||0));
  res.json({ ok: true, balance: u.balance, currency: u.currency });
});

export default router;
