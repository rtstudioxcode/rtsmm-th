import { Router } from "express";
import mongoose from 'mongoose'; 
import { User } from "../models/User.js";
import { requireAuth } from '../middleware/auth.js';
import { getBalance } from "../lib/iplusviewAdapter.js";
import { syncServicesFromProvider } from "../lib/syncServices.js";
import { ProviderSettings } from "../models/ProviderSettings.js";
import { Order } from "../models/Order.js";
import { Transaction } from "../models/Transaction.js";
import { Topup } from "../models/Topup.js";
import { ulid } from "ulid";
import { Service } from '../models/Service.js';

const router = Router();
router.use(requireAuth);

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

const USER_FIELDS = 'username email avatarUrl avatarVer';

// กันซิงก์ซ้อน
let SYNC_LOCK = false;
let SYNC_STARTED_AT = 0;
const MAX_RUN_MS = 15 * 60 * 1000; // 15 นาที

// === helper : normalize + validate ===
function normDigits(s = "") {
  return String(s).replace(/[^\d]/g, "");
}
function normalizeAndValidateAccount(row) {
  const code = String(row.accountCode || row.code || "").trim();
  const numberRaw = String(row.accountNumber || row.number || "").trim();
  const name = String(row.accountName || row.name || "").trim();
  const digits = normDigits(numberRaw);

  if (!code || !digits || !name)
    return { ok: false, error: "ข้อมูลบัญชีไม่ครบ" };
  if (code === "tw") {
    if (!/^0\d{9}$/.test(digits))
      return { ok: false, error: "TrueWallet ต้องเป็นเบอร์ 10 หลักขึ้นต้น 0" };
  } else {
    if (!/^\d{10,15}$/.test(digits))
      return { ok: false, error: "เลขบัญชีธนาคารต้องยาว 10–15 หลัก" };
  }
  return { ok: true, code, number: digits, name };
}

// Dashboard
router.get("/", async (req, res) => {
  try {
    // 🟣 Get provider settings
    let ps = await ProviderSettings.findOne();
    if (!ps) ps = new ProviderSettings();

    const servicesTotal = await Service.countDocuments({});

    const orderCount = await Order.countDocuments({
      status: { $nin: ['canceled', 'cancelled', 'processing'] }
    });

    const userCount = await User.countDocuments({});

    // 🟢 Fetch all pending top-up transactions
    const pendingTransactions = await Transaction.find({ status: "pending" })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // 🟩 Fetch all available web wallets (for reference / matching)
    const webWallets = await Topup.find({ isActive: true }).lean();

    // ✅ Render admin dashboard
    res.render("admin/dashboard", {
      title: "หลังบ้าน",
      balance: ps.lastBalance || 0,
      servicesTotal,
      lastSyncAt: ps.lastSyncAt || null,
      transactions: pendingTransactions,
      webWallets,
      stats: {
        orderCount,
        userCount,
      },
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).send("เกิดข้อผิดพลาดในระบบ");
  }
});

// Refresh balance
router.post("/refresh-balance", async (req, res) => {
  try {
    const balRaw = await getBalance();
    const candidates = ["balance", "credit", "credits", "amount"];
    const val = Number(
      candidates.map((k) => balRaw?.[k]).find((v) => v !== undefined)
    );
    let ps = await ProviderSettings.findOne();
    if (!ps) ps = new ProviderSettings();
    ps.lastBalance = Number.isFinite(val) ? val : 0;
    if (!ps.lastSyncAt) ps.lastSyncAt = new Date();
    await ps.save();
    res.json({ ok: true, balance: ps.lastBalance, raw: balRaw });
  } catch (e) {
    console.error("refresh-balance error:", e?.response?.data || e);
    res.status(500).json({ ok: false, error: e.message || "refresh failed" });
  }
});

// Sync services
router.post('/sync-services', requireAuth, async (req, res) => {
  // ✅ อนุญาตเฉพาะแอดมิน
  const me = req.user || req.session?.user;
  const isAdmin = !!(me?.role === 'admin' || me?.isAdmin);
  if (!isAdmin) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  // ✅ กันล็อกค้าง (ถ้าล็อกอยู่นานเกิน MAX_RUN_MS ให้ถือว่าหมดอายุ)
  if (SYNC_LOCK && (Date.now() - SYNC_STARTED_AT) > MAX_RUN_MS) {
    SYNC_LOCK = false; // clear stale lock
  }

  // ✅ กันซิงก์ซ้อน
  if (SYNC_LOCK) {
    return res.status(429).json({ ok: false, error: 'sync is already running' });
  }

  const t0 = Date.now();
  SYNC_LOCK = true;
  SYNC_STARTED_AT = t0;

  try {
    // ทำงานจริง
    const result = await syncServicesFromProvider(); // { count, skipped, logs }

    // อัปเดตสถานะการซิงก์ล่าสุด
    let ps = await ProviderSettings.findOne();
    if (!ps) ps = new ProviderSettings();

    ps.lastSyncAt = new Date();
    ps.lastSyncResult = {
      ok: true,
      count: result?.count ?? 0,
      skipped: result?.skipped ?? 0,
      logs: result?.logs ?? 0,
      durationMs: Date.now() - t0,
    };
    await ps.save();

    return res.json({
      ok: true,
      ...result,
      lastSyncAt: ps.lastSyncAt,
      durationMs: ps.lastSyncResult.durationMs,
    });
  } catch (e) {
    console.error('Admin sync failed:', e?.response?.data || e);
    const msg = e?.response?.data?.message || e?.message || 'sync failed';

    // บันทึกผลล้มเหลวไว้ใน settings ด้วย
    try {
      let ps = await ProviderSettings.findOne();
      if (!ps) ps = new ProviderSettings();
      ps.lastSyncAt = new Date();
      ps.lastSyncResult = {
        ok: false,
        error: msg,
        durationMs: Date.now() - t0,
      };
      await ps.save();
    } catch {}

    return res.status(500).json({ ok: false, error: msg });
  } finally {
    SYNC_LOCK = false;
    SYNC_STARTED_AT = 0;
  }
});

const ALLOWED_ROLES = ["admin", "user"];
/**
 * GET /users
 * แสดงหน้า EJS การ์ดยูสเซอร์
 */
router.get("/users", async (req, res) => {
  const users = await User.find(
    {},
    {
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
    }
  )
    .sort({ createdAt: -1 })
    .lean();

  res.render("admin/users", {
    title: "ข้อมูลยูสเซอร์",
    users,
  });
});

/**
 * GET /users/:id.json
 * ส่งข้อมูลเต็มของผู้ใช้ (ยกเว้นฟิลด์อ่อนไหว)
 */
router.get("/users/:id.json", async (req, res) => {
  try {
    const { id } = req.params;
    const u = await User.findById(id).lean();
    if (!u) return res.status(404).json({ ok: false, error: "ไม่พบผู้ใช้" });

    delete u.passwordHash;
    delete u.resetToken;
    delete u.twoFactorSecret;

    return res.json({ ok: true, user: u });
  } catch (e) {
    console.error("GET /admin/users/:id.json error:", e);
    return res.status(500).json({ ok: false, error: "ดึงข้อมูลไม่สำเร็จ" });
  }
});

router.patch("/users/:id", async (req, res) => {
  const { id } = req.params;
  const { name, role, emailVerified, balance, bankAccounts } = req.body || {};
  const update = {};

  // name
  if (typeof name === "string") update.name = name.trim().slice(0, 100);

  // role
  if (typeof role === "string") {
    const r = role.trim().toLowerCase();
    if (!ALLOWED_ROLES.includes(r)) {
      return res.status(400).json({ ok: false, error: "role ไม่ถูกต้อง" });
    }
    update.role = r;
  }

  // emailVerified
  if (typeof emailVerified !== "undefined")
    update.emailVerified = !!emailVerified;

  // balance
  if (typeof balance !== "undefined") {
    const n = Number(balance);
    if (!Number.isFinite(n) || n < 0) {
      return res
        .status(400)
        .json({ ok: false, error: "balance ต้องเป็นตัวเลขที่ถูกต้องและ ≥ 0" });
    }
    update.balance = Math.round(n * 100) / 100; // ทศนิยม 2
  }

  // bankAccounts (0–2 รายการ) + validate + กันซ้ำข้ามผู้ใช้
  if (Array.isArray(bankAccounts)) {
    if (bankAccounts.length > 2) {
      return res.status(400).json({ ok: false, error: "ได้ไม่เกิน 2 บัญชี" });
    }

    // แปลง/ตรวจความถูกต้องทีละแถว
    const rows = [];
    for (const r of bankAccounts) {
      const v = normalizeAndValidateAccount(r);
      if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
      rows.push({
        accountCode: v.code,
        accountNumber: v.number,
        accountName: v.name,
      });
    }

    // กันซ้ำ: (accountCode, accountNumber) ต้องไม่อยู่ในผู้ใช้อื่น
    for (const r of rows) {
      const exists = await User.findOne({
        _id: { $ne: id },
        bankAccounts: {
          $elemMatch: {
            accountCode: r.accountCode,
            accountNumber: r.accountNumber,
          },
        },
      }).lean();
      if (exists) {
        return res.status(409).json({
          ok: false,
          error: `บัญชี ${r.accountCode} ${r.accountNumber} ถูกใช้งานในผู้ใช้อื่นแล้ว (1 บัญชีใช้ได้เพียง 1 ผู้ใช้)`,
        });
      }
    }

    // set ทับทั้งชุด (อนุญาตให้เป็น [] ได้ เพื่อเคลียร์)
    update.bankAccounts = rows;
  }

  if (Object.keys(update).length === 0) {
    return res
      .status(400)
      .json({ ok: false, error: "ไม่มีฟิลด์ที่แก้ไขได้ถูกส่งมา" });
  }

  try {
    const user = await User.findByIdAndUpdate(
      id,
      { $set: update, $currentDate: { updatedAt: true } },
      { new: true, runValidators: true }
    ).lean();

    if (!user) return res.status(404).json({ ok: false, error: "ไม่พบผู้ใช้" });

    delete user.passwordHash;
    delete user.resetToken;
    delete user.twoFactorSecret;

    return res.json({ ok: true, user });
  } catch (e) {
    console.error("PATCH /users/:id error:", e);
    return res.status(500).json({ ok: false, error: "บันทึกไม่สำเร็จ" });
  }
});

router.post("/manual-topup", async (req, res) => {
  try {
    const { username, amount, txId } = req.body;

    if (!username || !amount)
      return res.json({ ok: false, error: "ข้อมูลไม่ครบ" });

    const user = await User.findOne({ username });
    if (!user) return res.json({ ok: false, error: "ไม่พบผู้ใช้" });

    // 🟢 เพิ่มยอดเข้า balance
    user.balance = (user.balance || 0) + Number(amount);
    await user.save();

    // 🟣 ถ้ามี txId ให้ update
    if (txId) {
      await Transaction.findOneAndUpdate(
        { transactionId: txId },
        {
          $set: {
            userId: user._id,
            status: "completed",
            updatedAt: new Date(),
          },
        },
        { new: true }
      );
    } else {
      // 🟠 ถ้าไม่มี txId ให้สร้างใหม่
      await Transaction.create({
        transactionId: ulid(),
        userId: user._id,
        method: "manual",
        amount,
        status: "completed",
        createdAt: new Date(),
      });
    }

    res.json({ ok: true, username, amount });
  } catch (err) {
    console.error("manual-topup error:", err);
    res.json({ ok: false, error: "เกิดข้อผิดพลาดในระบบ" });
  }
});

// ปฏิเสธรายการเติมเงิน
router.post('/topup/:id/reject', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ ok:false, error:'⛔️ ไม่มีสิทธิ์' });
    }

    const { id } = req.params;

    // หาได้ทั้งจาก _id และ transactionId
    const tx = isObjectId(id)
      ? await Transaction.findById(id)
      : await Transaction.findOne({ transactionId: id });

    if (!tx) return res.status(404).json({ ok:false, error:'ไม่พบรายการ' });

    if (tx.status !== 'pending') {
      return res.status(400).json({
        ok:false,
        error:`สถานะปัจจุบันคือ "${tx.status}" ไม่สามารถปฏิเสธได้`
      });
    }

    tx.status = 'reject';          // ✅ ตรงกับ enum ใหม่นายแล้ว
    tx.rejectedAt = new Date();
    tx.rejectedBy = req.user?._id ?? null;

    // ไม่แตะ balance ผู้ใช้ เพราะยังไม่ได้เติม
    await tx.save();
    return res.json({ ok:true });
  } catch (err) {
    console.error('reject tx error:', err);
    return res.status(500).json({ ok:false, error:'เซิร์ฟเวอร์มีปัญหา' });
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

    // ── เพจจิเนชัน ─────────────────────────────────────────────
    const MAX_PER_PAGE = 1000;
    const pageParam    = parseInt(req.query.page, 10);
    const perPageParam = (req.query.perPage ?? '').toString().toLowerCase();

    const total = await Order.countDocuments(filter);

    let perPage;
    if (perPageParam === 'all') {
      perPage = Math.max(1, total);       // แสดงทั้งหมด
    } else {
      const n = Number.isFinite(pageParam) ? (parseInt(req.query.perPage, 10) || 20)
                                           : (parseInt(req.query.perPage, 10) || 20);
      perPage = Math.min(Math.max(1, n), MAX_PER_PAGE);
    }

    const pages    = Math.max(1, Math.ceil(total / Math.max(1, perPage)));
    const page     = Math.min(Math.max(1, Number.isFinite(pageParam) ? pageParam : 1), pages);
    const skip     = Math.max(0, (page - 1) * perPage);
    const limit    = perPage;

    // ── ดึงรายการ ─────────────────────────────────────────────
    const listRaw = await Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate([
        { path: 'user',    select: 'username email name avatarUrl role' },
        { path: 'service', select: 'name rate currency providerServiceId' },
      ])
      .lean();

    const list = (listRaw || []).map(o => {
      const st = String(o.status || '').toLowerCase();
      const isDone =
        st === 'completed' ||
        (typeof o.progress === 'number' && o.progress >= 99.995);
      const canCancel = st === 'processing';
      return { ...o, uiFlags: { isDone, canCancel } };
    });

    // ── ส่งให้วิว (admin/orders.ejs) ──────────────────────────
    res.render('admin/orders', {
      title: 'ออเดอร์ทั้งหมด (แอดมิน)',
      list,
      from,
      to,
      q,
      status,
      page,               // number
      perPage,            // number (ถ้าเลือก all จะเท่ากับ total)
      total,              // number
      syncError: null,
      bodyClass: 'orders-wide',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/api/users/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const limit = Math.min(20, Number(req.query.limit) || 10);

    const cond = q
      ? { username: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
      : {};

    const items = await User.find(cond)
      .select('_id username email role balance points')
      .sort({ username: 1 })
      .limit(limit)
      .lean();

    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// TOPUP REPORT (Admin)
// ─────────────────────────────────────────────────────────────
router.get('/topup-report', async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).send('Forbidden');
    }

    const pageRaw = parseInt(req.query.page, 10);
    const perRaw  = parseInt(req.query.perpage, 10);

    const page    = Math.max(1, Number.isFinite(pageRaw) ? pageRaw : 1);
    let   perpage = Number.isFinite(perRaw) ? perRaw : 100;
    perpage       = Math.max(10, Math.min(100, perpage)); // 10–100

    const q = {}; // โชว์ทุกรายการ

    const [total, items, aggCompleted] = await Promise.all([
      Transaction.countDocuments(q),

      // ✅ populate userId ให้มี avatarUrl/avatarVer ติดมาด้วย
      Transaction.find(q)
        .sort({ createdAt: -1 })
        .skip((page - 1) * perpage)
        .limit(perpage)
        .populate({ path: 'userId', select: 'username email avatarUrl avatarVer' })
        .lean(),

      // ✅ สรุปรายการที่สำเร็จ
      Transaction.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, sum: { $sum: '$amount' }, count: { $sum: 1 } } }
      ])
    ]);

    const totalPages     = Math.max(1, Math.ceil(total / perpage));
    const sumCompleted   = aggCompleted?.[0]?.sum   || 0;
    const countCompleted = aggCompleted?.[0]?.count || 0;

    // กระเป๋ารับเงิน (มีหรือไม่มีได้)
    const webWallets = res.locals.webWallets || [];

    res.render('admin/topup-report', {
      transactions: items,
      page, perpage, total, totalPages,
      sumCompleted, countCompleted,
      webWallets
    });
  } catch (err) {
    console.error('GET /admin/topup-report error:', err);
    res.status(500).send('Server error');
  }
});

export default router;
