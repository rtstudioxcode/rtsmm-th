// routes/dashboard.js
import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { Order } from '../models/Order.js';

const router = Router();
router.use(requireAuth);

// helper: ทำ match ผู้ใช้ให้ครอบคลุมทั้ง ObjectId และ string
function buildUserMatch(userId) {
  const oid = (mongoose.Types.ObjectId.isValid(String(userId)))
    ? new mongoose.Types.ObjectId(String(userId))
    : null;
  return {
    $or: [
      ...(oid ? [{ user: oid }, { userId: oid }] : []),
      { user: String(userId) },
      { userId: String(userId) },
    ]
  };
}

/**
 * Dashboard (HTML)
 * - totalSpent: ยอดใช้จ่ายรวม (sum of cost || estCost) *ยกเว้น canceled โดยค่าเริ่มต้น*
 * - totalOrders: จำนวนออเดอร์ (ยกเว้น canceled โดยค่าเริ่มต้น)
 * ส่งไปเรนเดอร์ใน EJS
 *
 * query:
 *   ?all=1  -> รวมออเดอร์สถานะ canceled ด้วย
 */
router.get('/dashboard', async (req, res, next) => {
  try {
    const me = req.user || req.session?.user;
    if (!me?._id) return res.redirect('/login');

    const includeCanceled = String(req.query.all || '') === '1';

    const match = {
      ...buildUserMatch(me._id),
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
                { $ifNull: ['$refundAmount', 0] }
                ]
            }
          }
        }
      }
    ]);

    const agg = rows[0] || { totalOrders: 0, totalSpent: 0 };

    // level/เลเวล: ใส่ placeholder ไว้ก่อน
    const userLevel = (me.level ?? '—');

    res.render('dashboard/index', {
      title: 'Dashboard',
      agg,
      userLevel,
      me,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Dashboard (JSON) สำหรับหน้า front ที่อยากโหลดแบบ async ก็ใช้ endpoint นี้ได้
 */
router.get('/api/me/dashboard', async (req, res) => {
  try {
    const me = req.user || req.session?.user;
    if (!me?._id) return res.status(401).json({ error: 'unauthorized' });

    const includeCanceled = String(req.query.all || '') === '1';

    const match = {
      ...buildUserMatch(me._id),
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
                { $ifNull: ['$refundAmount', 0] }
                ]
            }
          }
        }
      }
    ]);

    const agg = rows[0] || { totalOrders: 0, totalSpent: 0 };

    res.json({
      ok: true,
      data: {
        totalOrders: agg.totalOrders,
        totalSpent: Math.round(agg.totalSpent * 100) / 100,
        level: (me.level ?? '—'),
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
});

export default router;
