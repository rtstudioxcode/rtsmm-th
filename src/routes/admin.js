import { Router } from 'express';
import { User } from '../models/User.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getBalance } from '../lib/iplusviewAdapter.js';
import { syncServicesFromProvider } from '../lib/syncServices.js';
import { ProviderSettings } from '../models/ProviderSettings.js';
import { Order } from '../models/Order.js';

const router = Router();
router.use(requireAuth, requireAdmin);

// Dashboard
router.get('/', async (req, res) => {
  let ps = await ProviderSettings.findOne();
  if (!ps) ps = new ProviderSettings();
  res.render('admin/dashboard', {
    balance: ps.lastBalance || 0,
    lastSyncAt: ps.lastSyncAt || null,
    title: 'หลังบ้าน'
  });
});

// Refresh balance
router.post('/refresh-balance', async (req, res) => {
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
router.post('/sync-services', async (_req, res) => {
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

// ป้องกันสิทธิ์: ต้องเป็นแอดมิน
router.use(requireAuth, requireAdmin);

const ALLOWED_ROLES = ['admin', 'user'];
/**
 * GET /users
 * แสดงหน้า EJS การ์ดยูสเซอร์
 */
router.get('/users', async (req, res) => {
  const users = await User.find({}, {
    username: 1,
    name: 1,
    role: 1,
    email: 1,
    emailVerified: 1,
    avatarUrl: 1,
    levelName: 1,
    balance: 1,
    totalSpent: 1,
    points: 1,
    totalOrders: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  .sort({ createdAt: -1 })
  .lean();

  res.render('admin/users', {
    title: 'ข้อมูลยูสเซอร์',
    users,
  });
});

/**
 * GET /users/:id.json
 * ส่งข้อมูลเต็มของผู้ใช้ (ยกเว้นฟิลด์อ่อนไหว)
 */
router.get('/users/:id.json', async (req, res) => {
  const { id } = req.params;
  const u = await User.findById(id).lean();
  if (!u) return res.status(404).json({ ok:false, error: 'ไม่พบผู้ใช้' });

  // ลบฟิลด์อ่อนไหว
  delete u.passwordHash;
  delete u.resetToken;
  delete u.twoFactorSecret;

  return res.json({ ok:true, user: u });
});

router.patch('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { name, role, emailVerified, balance } = req.body || {};
  const update = {};

  if (typeof name === 'string') update.name = name.trim().slice(0, 100);

  if (typeof role === 'string') {
    const r = role.trim().toLowerCase();
    if (!ALLOWED_ROLES.includes(r)) {
      return res.status(400).json({ ok:false, error: 'role ไม่ถูกต้อง' });
    }
    update.role = r;
  }

  if (typeof emailVerified !== 'undefined') update.emailVerified = !!emailVerified;

  if (typeof balance !== 'undefined') {
    const n = Number(balance);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ ok:false, error: 'balance ต้องเป็นตัวเลขที่ถูกต้องและ ≥ 0' });
    }
    update.balance = Math.round(n * 100) / 100; // ปัดทศนิยม 2
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ ok:false, error: 'ไม่มีฟิลด์ที่แก้ไขได้ถูกส่งมา' });
  }

  try {
    const user = await User.findByIdAndUpdate(
      id,
      { $set: update, $currentDate: { updatedAt: true } },
      { new: true, runValidators: true }
    ).lean();

    if (!user) return res.status(404).json({ ok:false, error: 'ไม่พบผู้ใช้' });

    delete user.passwordHash;
    delete user.resetToken;
    delete user.twoFactorSecret;

    return res.json({ ok:true, user });
  } catch (e) {
    console.error('PATCH /users/:id error:', e);
    return res.status(500).json({ ok:false, error: 'บันทึกไม่สำเร็จ' });
  }
});

// ✅ GET /orders — รายการออเดอร์ทั้งหมด
router.get('/orders', async (req, res, next) => {
  try {
    const { from, to, q = '', status = 'all' } = req.query || {};
    const filter = {};

    // วันที่ (inclusive)
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from + 'T00:00:00.000Z');
      if (to)   filter.createdAt.$lte = new Date(to   + 'T23:59:59.999Z');
    }

    // สถานะ
    if (status && status !== 'all') {
      filter.status = String(status).toLowerCase();
    }

    // คำค้น
    if (q && q.trim()) {
      const rx = new RegExp(q.trim(), 'i');
      filter.$or = [
        { providerOrderId: rx },
        { link: rx },
        { serviceName: rx },
        { 'service.name': rx },
        { 'service.providerServiceId': rx },
        { providerServiceId: rx },
        { 'user.username': rx },
        { 'user.email': rx },
        { 'user.name': rx },
      ];
    }

    // ✅ ใช้ Order model โดยตรง
    const listRaw = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(1000)
      .populate([
        { path: 'user', select: 'username email name avatarUrl role' },
        { path: 'service', select: 'name rate currency providerServiceId' },
      ])
      .lean();

    const list = (listRaw || []).map(o => {
      const st = String(o.status || '').toLowerCase();
      const isDone = (st === 'completed') ||
        (typeof o.progress === 'number' && o.progress >= 99.995);
      const canCancel = (st === 'processing');
      return { ...o, uiFlags: { isDone, canCancel } };
    });

    // ✅ ชื่อวิวตรงกับไฟล์: views/orders.ejs
    res.render('admin/orders', {
      title: 'ออเดอร์ทั้งหมด (แอดมิน)',
      list,
      from, to, q, status,
      syncError: null,
      bodyClass: 'orders-wide'
    });
  } catch (err) {
    next(err);
  }
});

export default router;
