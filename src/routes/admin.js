import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { getBalance } from '../lib/iplusviewAdapter.js';
import { syncServicesFromProvider } from '../lib/syncServices.js';
import { ProviderSettings } from '../models/ProviderSettings.js';

const router = Router();
router.use(requireAdmin);

// Dashboard
router.get('/admin', async (req, res) => {
  let ps = await ProviderSettings.findOne();
  if (!ps) ps = new ProviderSettings();
  res.render('admin/dashboard', {
    balance: ps.lastBalance || 0,
    lastSyncAt: ps.lastSyncAt || null,
    title: 'หลังบ้าน'
  });
});

// Refresh balance
router.post('/admin/refresh-balance', async (req, res) => {
  try {
    const balRaw = await getBalance();
    const candidates = ['balance', 'credit', 'credits', 'amount'];
    const val = Number(candidates.map(k => balRaw?.[k]).find(v => v !== undefined));
    let ps = await ProviderSettings.findOne();
    if (!ps) ps = new ProviderSettings();
    ps.lastBalance = Number.isFinite(val) ? val : 0;
    if (!ps.lastSyncAt) ps.lastSyncAt = new Date();
    await ps.save();
    res.json({ ok: true, balance: ps.lastBalance, raw: balRaw });
  } catch (e) {
    console.error('refresh-balance error:', e?.response?.data || e);
    res.status(500).json({ ok: false, error: e.message || 'refresh failed' });
  }
});

// Sync services
router.post('/admin/sync-services', async (_req, res) => {
  try {
    const r = await syncServicesFromProvider();
    // อัปเดต lastSyncAt ให้ชัวร์ (แม้ syncServices จะทำให้แล้ว)
    let ps = await ProviderSettings.findOne();
    if (!ps) ps = new ProviderSettings();
    ps.lastSyncAt = new Date();
    await ps.save();
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('Admin sync failed:', e?.response?.data || e);
    res.status(500).json({ ok: false, error: e.message || 'sync failed' });
  }
});

export default router;
