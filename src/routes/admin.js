import { Router } from 'express';
import { User } from '../models/User.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getBalance } from '../lib/iplusviewAdapter.js';
import { syncServicesFromProvider } from '../lib/syncServices.js';
import { ProviderSettings } from '../models/ProviderSettings.js';
import { Order } from '../models/Order.js';

const router = Router();
router.use(requireAuth, requireAdmin);

// === helper : normalize + validate ===
function normDigits(s=''){ return String(s).replace(/[^\d]/g,''); }
function normalizeAndValidateAccount(row){
  const code = String(row.accountCode||row.code||'').trim().toUpperCase();
  const numberRaw = String(row.accountNumber||row.number||'').trim();
  const name = String(row.accountName||row.name||'').trim();
  const digits = normDigits(numberRaw);

  if (!code || !digits || !name) return { ok:false, error:'ข้อมูลบัญชีไม่ครบ' };
  if (code === 'TRUEWALLET') {
    if (!/^0\d{9}$/.test(digits)) return { ok:false, error:'TrueWallet ต้องเป็นเบอร์ 10 หลักขึ้นต้น 0' };
  } else {
    if (!/^\d{9,12}$/.test(digits)) return { ok:false, error:'เลขบัญชีธนาคารต้องยาว 9–12 หลัก' };
  }
  return { ok:true, code, number:digits, name };
}

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
 * GET /admin/users
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
  try {
    const { id } = req.params;
    const u = await User.findById(id).lean();
    if (!u) return res.status(404).json({ ok:false, error:'ไม่พบผู้ใช้' });

    delete u.passwordHash;
    delete u.resetToken;
    delete u.twoFactorSecret;

    return res.json({ ok:true, user: u });
  } catch (e) {
    console.error('GET /admin/users/:id.json error:', e);
    return res.status(500).json({ ok:false, error:'ดึงข้อมูลไม่สำเร็จ' });
  }
});

router.patch('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { name, role, emailVerified, balance, bankAccounts } = req.body || {};
  const update = {};

  // name
  if (typeof name === 'string') update.name = name.trim().slice(0, 100);

  // role
  if (typeof role === 'string') {
    const r = role.trim().toLowerCase();
    if (!ALLOWED_ROLES.includes(r)) {
      return res.status(400).json({ ok:false, error: 'role ไม่ถูกต้อง' });
    }
    update.role = r;
  }

  // emailVerified
  if (typeof emailVerified !== 'undefined') update.emailVerified = !!emailVerified;

  // balance
  if (typeof balance !== 'undefined') {
    const n = Number(balance);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ ok:false, error: 'balance ต้องเป็นตัวเลขที่ถูกต้องและ ≥ 0' });
    }
    update.balance = Math.round(n * 100) / 100; // ทศนิยม 2
  }

  // bankAccounts (0–2 รายการ) + validate + กันซ้ำข้ามผู้ใช้
  if (Array.isArray(bankAccounts)) {
    if (bankAccounts.length > 2) {
      return res.status(400).json({ ok:false, error:'ได้ไม่เกิน 2 บัญชี' });
    }

    // แปลง/ตรวจความถูกต้องทีละแถว
    const rows = [];
    for (const r of bankAccounts) {
      const v = normalizeAndValidateAccount(r);
      if (!v.ok) return res.status(400).json({ ok:false, error: v.error });
      rows.push({ accountCode: v.code, accountNumber: v.number, accountName: v.name });
    }

    // กันซ้ำ: (accountCode, accountNumber) ต้องไม่อยู่ในผู้ใช้อื่น
    for (const r of rows) {
      const exists = await User.findOne({
        _id: { $ne: id },
        bankAccounts: { $elemMatch: { accountCode: r.accountCode, accountNumber: r.accountNumber } }
      }).lean();
      if (exists) {
        return res.status(409).json({
          ok:false,
          error:`บัญชี ${r.accountCode} ${r.accountNumber} ถูกใช้งานในผู้ใช้อื่นแล้ว (1 บัญชีใช้ได้เพียง 1 ผู้ใช้)`
        });
      }
    }

    // set ทับทั้งชุด (อนุญาตให้เป็น [] ได้ เพื่อเคลียร์)
    update.bankAccounts = rows;
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
