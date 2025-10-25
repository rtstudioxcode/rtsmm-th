// routes/dashboard.js
import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';
import { LEVELS as LV } from '../services/loyalty.js';

const router = Router();
router.use(requireAuth);

// รองรับทั้ง ObjectId และ string ในฟิลด์ user / userId
function buildUserMatch(userId) {
  const idStr = String(userId || '');
  const asOid = mongoose.Types.ObjectId.isValid(idStr)
    ? new mongoose.Types.ObjectId(idStr)
    : null;

  const ors = [{ user: idStr }, { userId: idStr }];
  if (asOid) ors.push({ user: asOid }, { userId: asOid });
  return { $or: ors };
}

/** รวมยอดจาก orders (ไม่รวม canceled) และอัปเดตกลับ users */
async function ensureUserTotals(userId, includeCanceled = false) {
  const user = await User.findById(userId).select('totalSpent totalOrders level').lean();
  const hasTotals =
    user && Number.isFinite(Number(user.totalSpent)) && Number.isFinite(Number(user.totalOrders));

  if (hasTotals && !includeCanceled) {
    return {
      totalSpent: Number(user.totalSpent || 0),
      totalOrders: Number(user.totalOrders || 0),
      level: String(user.level || '1'),
    };
  }

  const match = {
    ...buildUserMatch(userId),
    ...(includeCanceled ? {} : { status: { $ne: 'canceled' } }),
  };

  const rows = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalSpent: {
          $sum: {
            $subtract: [
              { $ifNull: ['$cost', { $ifNull: ['$estCost', 0] }] },
              { $ifNull: ['$refundAmount', 0] },
            ],
          },
        },
      },
    },
  ]);

  const agg = rows[0] || { totalOrders: 0, totalSpent: 0 };
  const totalSpent = Math.round((agg.totalSpent || 0) * 100) / 100; // ปัด 2 ตำแหน่ง
  const totalOrders = Number(agg.totalOrders || 0);

  // คิดเลเวลอย่างง่าย (เหมือน services/spend.js)
  const LEVELS = [
    { need: 0 }, { need: 5000 }, { need: 10000 }, { need: 30000 }, { need: 50000 },
    { need: 80000 }, { need: 175000 }, { need: 700000 }, { need: 1000000 }, { need: 5000000 },
  ];
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (totalSpent >= LEVELS[i].need) idx = i; else break;
  }
  const level = String(Math.max(1, idx + 1));

  // อัปเดตกลับ user (เก็บเฉพาะตัวเลขหลัก ๆ)
  await User.updateOne(
    { _id: userId },
    { $set: { totalSpent, totalOrders, level } }
  );

  return { totalSpent, totalOrders, level: String(level) };
}

async function renderDashboard(req, res, next) {
  try {
    const me = res.locals?.me || req.user || req.session?.user;
    if (!me?._id) return res.redirect('/login');

    const includeCanceled = String(req.query.all || '') === '1';
    const totals = await ensureUserTotals(me._id, includeCanceled);
    const levelIndex = Math.max(1, Number(totals.level || 1)) - 1;
    const userLevelName = LV[levelIndex]?.name || `เลเวล ${totals.level}`;

    const fresh = await User.findById(me._id)
      .select('name email avatarUrl avatarVer username')
      .lean();
    const viewMe = { ...(me || {}), ...(fresh || {}) };

    const stats = {
      totalSpent: totals.totalSpent,
      totalOrders: totals.totalOrders,
    };
    const userLevel = totals.level;

    return res.render('dashboard/index', {
      title: 'Dashboard',
      stats,
      userLevel: totals.level,
      userLevelName,
      me: viewMe, 
    });
  } catch (err) {
    next(err);
  }
}

router.get('/', renderDashboard);
router.get('/dashboard', renderDashboard);

// JSON สำหรับโหลดแบบ async
router.get('/api/me/dashboard', async (req, res) => {
  try {
    const me = res.locals?.me || req.user || req.session?.user;
    if (!me?._id) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const includeCanceled = String(req.query.all || '') === '1';
    const totals = await ensureUserTotals(me._id, includeCanceled);

    return res.json({
      ok: true,
      data: {
        totalSpent: totals.totalSpent,
        totalOrders: totals.totalOrders,
        level: totals.level,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
});

export default router;
