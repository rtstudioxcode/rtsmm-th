// src/routes/adminUsers.js
import { Router } from 'express';
import { User } from '../models/User.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js'; // มีอยู่แล้วในโปรเจกต์

const router = Router();

// ป้องกันสิทธิ์: ต้องเป็นแอดมิน
router.use(requireAuth, requireAdmin);

const ALLOWED_ROLES = ['admin', 'user'];
/**
 * GET /admin/users
 * แสดงหน้า EJS การ์ดยูสเซอร์
 */
router.get('/admin/users', async (req, res) => {
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
 * GET /admin/users/:id.json
 * ส่งข้อมูลเต็มของผู้ใช้ (ยกเว้นฟิลด์อ่อนไหว)
 */
router.get('/admin/users/:id.json', async (req, res) => {
  const { id } = req.params;
  const u = await User.findById(id).lean();
  if (!u) return res.status(404).json({ ok:false, error: 'ไม่พบผู้ใช้' });

  // ลบฟิลด์อ่อนไหว
  delete u.passwordHash;
  delete u.resetToken;
  delete u.twoFactorSecret;

  return res.json({ ok:true, user: u });
});

router.patch('/admin/users/:id', async (req, res) => {
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
    console.error('PATCH /admin/users/:id error:', e);
    return res.status(500).json({ ok:false, error: 'บันทึกไม่สำเร็จ' });
  }
});

export default router;
