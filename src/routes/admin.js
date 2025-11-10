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
import { getOtp24Balance, getOtp24Products } from '../lib/otp24Adapter.js';
import { Otp24Setting } from '../models/Otp24Setting.js';
import { Otp24Product } from "../models/Otp24Product.js";
import { Otp24Order } from '../models/Otp24Order.js';

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

    // 🟢 ดึงรายการเติมเงินที่รอ
    const pendingTransactions = await Transaction.find({ status: "pending" })
      .sort({ createdAt: -1 })
      .limit(100)
      // populate ไว้ก่อน เผื่อมี userId พร้อม
      .populate({ path: 'userId', select: 'username' })
      .lean();

    // 👉 สร้างแผนที่ userId -> username (กันกรณี populate ไม่ครบ)
    const uidList = [...new Set(
      pendingTransactions
        .map(tx => (tx.userId?._id || tx.userId))  // ทั้งกรณีเป็น obj หรือ id
        .filter(Boolean)
        .map(String)
    )];

    let userMap = {};
    if (uidList.length) {
      const users = await User.find(
        { _id: { $in: uidList } },
        { username: 1 }
      ).lean();
      userMap = Object.fromEntries(users.map(u => [String(u._id), u.username]));
    }

    // 🧩 เย็บ username + จัด method ให้พร้อมใช้
    for (const tx of pendingTransactions) {
      const idStr = String(tx.userId?._id || tx.userId || '');
      const unameFromPopulate = tx.userId && typeof tx.userId === 'object' ? tx.userId.username : null;

      // สร้างฟิลด์ user ให้มี username เสมอ (ฝั่ง EJS ใช้ tx.user.username ได้ตรงๆ)
      tx.user = tx.user || {};
      tx.user.username = unameFromPopulate || userMap[idStr] || tx.user?.username || null;

      // เก็บ method ให้เป็น lower-case ใช้งานง่าย
      tx.method = String(tx.method || '').toLowerCase();
    }

    // 🟩 กระเป๋ารับเงินทั้งหมด (สำหรับแม็ปฝั่ง UI)
    const webWallets = await Topup.find({ isActive: true }).lean();

    const otp24Doc = await Otp24Setting.findOne({ name: 'otp24' }).lean();
    const {
      lastBalance: otp24Bal = 0,
      lastSyncAt:  otp24LastSyncAt = null,
      lastSyncError: otp24LastError = ''
    } = otp24Doc || {};

    // จำนวนสินค้า OTP24 ปัจจุบัน
    const otp24ProductsTotal = await Otp24Product.countDocuments({ provider: 'otp24' });

    // ✅ นับออเดอร์ OTP24 ที่ success เท่านั้น
    const otp24SuccessCount = await Otp24Order.countDocuments({
      status: /^success$/i   // กันเคสตัวพิมพ์เล็ก/ใหญ่
    });

    // ✅ รวมยอดขายทั้งหมด (SMM + OTP24 success)
    const totalSoldCount = (orderCount || 0) + (otp24SuccessCount || 0);

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
        otp24SuccessCount,
        totalSoldCount
      },
      // OTP24
      otp24Bal,
      otp24LastSyncAt,
      otp24LastError,
      
      otp24ProductsTotal,
      otp24ProductsLastSyncAt: otp24Doc?.productsLastSyncAt ?? null,
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
    let { username, amount, txId, method } = req.body;

    // ── ตรวจข้อมูลพื้นฐาน ─────────────────────────────────────────
    if (!username || amount === undefined || amount === null) {
      return res.json({ ok: false, error: "ข้อมูลไม่ครบ" });
    }

    // รองรับ amount เป็น string มีคอมมา
    const amt = Math.round(Number(String(amount).replace(/,/g, "")) * 100) / 100;
    if (!(amt > 0)) {
      return res.json({ ok: false, error: "จำนวนเงินไม่ถูกต้อง" });
    }
    const amtCents = Math.round(amt * 100);

    // ── ปรับ/ตรวจค่า method ───────────────────────────────────────
    const ALLOWED_METHODS = ["admin", "truewallet", "kbank", "scb", "manual"];
    let m = String(method || "admin").toLowerCase();
    if (!ALLOWED_METHODS.includes(m)) m = "admin";

    // ── หา user ───────────────────────────────────────────────────
    const user = await User.findOne({ username });
    if (!user) return res.json({ ok: false, error: "ไม่พบผู้ใช้" });

    // ── เพิ่มยอดเข้า balance (บาท) ────────────────────────────────
    user.balance = Number(user.balance || 0) + amt;
    await user.save();

    const now = new Date();

    // ── อัปเดต/สร้าง Transaction ─────────────────────────────────
    if (txId) {
      // มี txId → upsert ให้ครบฟิลด์
      await Transaction.findOneAndUpdate(
        { transactionId: txId },
        {
          $set: {
            userId: user._id,
            username: user.username,
            method: m,              // ← ใช้ method ที่เลือก
            amount: amt,            // บาท
            amountCents: amtCents,  // สตางค์
            currency: "THB",
            status: "completed",
            updatedAt: now,
            paidAt: now,
          },
          $setOnInsert: {
            transactionId: txId,
            createdAt: now,
          },
        },
        { new: true, upsert: true }
      );
    } else {
      // ไม่มี txId → สร้างใหม่
      await Transaction.create({
        transactionId: ulid(),
        userId: user._id,
        username: user.username,
        method: m,              // ← ใช้ method ที่เลือก
        amount: amt,
        amountCents: amtCents,
        currency: "THB",
        status: "completed",
        createdAt: now,
        updatedAt: now,
        paidAt: now,
      });
    }

    // (ถ้ามีโมเดล topup_logs/WalletTransaction และอยากบันทึกแยก — ค่อยเพิ่มตรงนี้ได้)

    return res.json({
      ok: true,
      username,
      amount: amt,
      method: m,
      balance: user.balance,
    });
  } catch (err) {
    console.error("admin-topup error:", err);
    return res.json({ ok: false, error: "เกิดข้อผิดพลาดในระบบ" });
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
  const raw = (req.query.month || '').slice(0, 7); // 'YYYY-MM'
  const now = new Date();

  // ===== คำนวณช่วงเวลาเดือน (เริ่มต้นเป็นเดือนปัจจุบัน) =====
  const [yy, mm] = raw && /^\d{4}-\d{2}$/.test(raw)
    ? raw.split('-').map(Number)
    : [now.getFullYear(), now.getMonth() + 1];

  // สร้างช่วงเวลาแบบ [start, end)
  const start = new Date(Date.UTC(yy, mm - 1, 1, 0, 0, 0));
  const end   = new Date(Date.UTC(yy, mm, 1, 0, 0, 0));

  const monthStr = `${yy}-${String(mm).padStart(2, '0')}`;

  // เงื่อนไขหลักของเดือนนี้
  const monthMatch = { createdAt: { $gte: start, $lt: end } };

  // ===== รายการธุรกรรมของเดือน =====
  const transactions = await Transaction.find(monthMatch)
    .sort({ createdAt: -1 })
    .populate({ path: 'userId', select: 'username email avatarUrl avatarVer' })
    .lean();

  // ===== รวม “ทั้งหมด” แต่ไม่เอาแอดมิน (completed เท่านั้น) =====
  const aggNoAdmin = await Transaction.aggregate([
    { $match: { ...monthMatch, status: 'completed', method: { $ne: 'admin' } } },
    { $group: { _id: null, sum: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

  const sumNoAdmin   = aggNoAdmin?.[0]?.sum   || 0;
  const countNoAdmin = aggNoAdmin?.[0]?.count || 0;

  // ===== รวมตามเมธอด (completed เท่านั้น) =====
  const aggByMethod = await Transaction.aggregate([
    { $match: { ...monthMatch, status: 'completed' } },
    { $group: { _id: '$method', sum: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

  // map ป้ายชื่อสวย ๆ
  const METHOD_LABELS = {
    admin: 'แอดมิน',
    manual: 'เติมมือ',
    truewallet: 'True Wallet', tw: 'True Wallet',
    kbank: 'KBank',
    scb: 'SCB',
  };

  const methodTotals = aggByMethod
    .map(m => ({
      method: (m._id || '').toLowerCase(),
      label: METHOD_LABELS[(m._id || '').toLowerCase()] || (m._id || 'ไม่ระบุ'),
      sum: m.sum || 0,
      count: m.count || 0,
    }))
    // แสดงเฉพาะเมธอดที่มีรายการจริง
    .filter(m => m.count > 0);

  // (ออปชัน) รวม completed ทั้งหมดของเดือน (ใช้ถ้าต้องโชว์การ์ดรวมเดิม)
  const aggCompleted = await Transaction.aggregate([
    { $match: { ...monthMatch, status: 'completed' } },
    { $group: { _id: null, sum: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const sumCompleted   = aggCompleted?.[0]?.sum   || 0;
  const countCompleted = aggCompleted?.[0]?.count || 0;

  // ส่งให้วิว — ไม่มี perpage/page/total อีกต่อไป
  res.render('admin/topup-report', {
    transactions,
    monthStr,
    sumNoAdmin, countNoAdmin,
    methodTotals,
    sumCompleted, countCompleted,
  });
});

// ─────────────────────────────────────────────────────────────
// OTP24HR
// ─────────────────────────────────────────────────────────────
// Refresh OTP24 balance + save snapshot to DB (otp24setting)
router.post('/otp24hr/refresh-balance', async (req, res) => {
  try {
    const r = await getOtp24Balance();
    const rawTrim = typeof r?.raw === 'string' ? r.raw.slice(0, 2000) : r?.raw;

    if (!r?.ok) {
      await Otp24Setting.findOneAndUpdate(
        { name: 'otp24' },
        { $set: { lastSyncAt: new Date(), lastSyncError: String(r?.error||'fetch failed'), lastSyncResult: rawTrim ?? null },
          $currentDate: { updatedAt: true } },
        { upsert: true, new: true }
      );
      return res.status(500).json({ ok:false, error: r.error, raw: rawTrim, via: r.via });
    }

    await Otp24Setting.findOneAndUpdate(
      { name: 'otp24' },
      { $set: { lastBalance: Number(r.balance)||0, lastSyncAt: new Date(), lastSyncError: '', lastSyncResult: rawTrim ?? null },
        $currentDate: { updatedAt: true } },
      { upsert: true, new: true }
    );

    return res.json({ ok:true, balance: r.balance, currency: r.currency || 'THB', via: r.via });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// OTP24HR: Sync Products (admin)
// ─────────────────────────────────────────────────────────────
router.post('/otp24hr/sync-services', async (req, res) => {
  try {
    // ✅ ตั้งค่าสัดส่วนการบวก
    // - apiPerc: สั่งให้ฝั่ง API บวกเท่าไร (ควร 0)
    // - addPerc: เราจะบวกขายเท่าไร (ดีฟอลต์ 50)
    const apiPerc = Number.isFinite(Number(req.body?.apiPerc))
      ? Math.max(0, Number(req.body.apiPerc))
      : 0;
    const addPerc = Number.isFinite(Number(req.body?.addPerc))
      ? Math.max(0, Number(req.body.addPerc))
      : 50;

    // ✅ ดึงรายการจากผู้ให้บริการ (เรา “ขาย +50%” ที่นี่แล้ว)
    const r = await getOtp24Products({ apiPerc, addPerc });
    if (!r?.ok || !Array.isArray(r.items)) {
      await Otp24Setting.findOneAndUpdate(
        { name: 'otp24' },
        {
          $set: {
            productsLastSyncAt: new Date(),
            lastSyncError: String(r?.error || 'fetch products failed'),
          },
          $currentDate: { updatedAt: true },
        },
        { upsert: true }
      );
      return res.status(500).json({ ok: false, error: r?.error || 'fetch products failed' });
    }

    // ✅ เตรียม upsert แบบ bulk — ใช้ key ตามลำดับ: extId > code > name (ร่วมกับ provider)
    const ops = [];
    const now = new Date();

    for (const it of r.items) {
      // เลือกคีย์ตัวตน (ห้ามเป็น null/undefined)
      const extId = [it.extId, it.itemId, it.id, it.code, it.raw?.service_id, it.raw?.id]
        .find(v => v !== undefined && v !== null && String(v).trim() !== '');
      const code  = [it.code, it.itemId, it.id]
        .find(v => v !== undefined && v !== null && String(v).trim() !== '');
      const name  = String(it.name || it.title || it.raw?.name || 'Unknown').trim();

      const filter = { provider: 'otp24' };
      if (extId)      filter.extId = String(extId);
      else if (code)  filter.code  = String(code);
      else            filter.name  = name || '(unnamed)';

      // ใช้ราคาที่ “คำนวณแล้ว” จาก adapter:
      // - basePrice = ราคา base จากผู้ให้บริการ (ไม่บวก)
      // - price     = basePrice * (1 + addPerc/100)  (เช่น 1.5)
      const $set = {
        name: name || '(unnamed)',
        basePrice: Number(it.basePrice || 0),
        price: Number(it.price || 0),           // <- รวม +50% แล้ว
        currency: it.currency || 'THB',
        country: it.country || it.raw?.country,
        category: (it.category || it.raw?.category || 'otp').toString().toLowerCase(),
        raw: it.raw ?? it,
        syncedAt: now,
      };
      // เก็บคีย์ก็ต่อเมื่อ “มีค่า” เท่านั้น เพื่อไม่ชน unique index ด้วย null
      if (extId) $set.extId = String(extId);
      if (code)  $set.code  = String(code);

      ops.push({
        updateOne: {
          filter,
          update: { $set, $setOnInsert: { provider: 'otp24' } },
          upsert: true,
        }
      });
    }

    const bulkRes = ops.length ? await Otp24Product.bulkWrite(ops, { ordered: false }) : null;
    const touched =
      (bulkRes?.upsertedCount || 0) +
      (bulkRes?.modifiedCount || 0) +
      (bulkRes?.matchedCount || 0);

    const total = await Otp24Product.countDocuments({ provider: 'otp24' });

    await Otp24Setting.findOneAndUpdate(
      { name: 'otp24' },
      {
        $set: {
          productsLastSyncAt: new Date(),
          productsLastCount: total,
          lastSyncError: '',
        },
        $currentDate: { updatedAt: true },
      },
      { upsert: true }
    );

    return res.json({ ok: true, count: touched, total, apiPerc, addPerc });
  } catch (e) {
    await Otp24Setting.findOneAndUpdate(
      { name: 'otp24' },
      {
        $set: {
          productsLastSyncAt: new Date(),
          lastSyncError: String(e?.message || e),
        },
        $currentDate: { updatedAt: true },
      },
      { upsert: true }
    );
    return res.status(500).json({ ok: false, error: e?.message || 'internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// OTP REPORT (Admin) — หน้าเดียวมีสองแท็บ: ประวัติ / สรุปยอดขาย
// GET /admin/otp-report?month=YYYY-MM
// ─────────────────────────────────────────────────────────────
router.get('/otp-report', async (req, res) => {
  try {
    // ----- เดือนที่เลือก (เริ่มที่เดือนปัจจุบัน) -----
    const raw = (req.query.month || '').slice(0, 7); // 'YYYY-MM'
    const now = new Date();

    const [yy, mm] = raw && /^\d{4}-\d{2}$/.test(raw)
      ? raw.split('-').map(Number)
      : [now.getFullYear(), now.getMonth() + 1];

    const start = new Date(Date.UTC(yy, mm - 1, 1, 0, 0, 0));
    const end   = new Date(Date.UTC(yy, mm, 1, 0, 0, 0));
    const monthStr = `${yy}-${String(mm).padStart(2, '0')}`;

    // ---------------------------------------------
    // แท็บ 1: ประวัติสั่งซื้อ OTP (ดึงทั้งเดือน) + เติม username
    // ---------------------------------------------
    const ordersRaw = await Otp24Order.find({ createdAt: { $gte: start, $lt: end } })
      .sort({ createdAt: -1 })
      .populate({ path: 'user', select: 'username' })   // << ใช้ฟิลด์ user ไม่ใช่ userId
      .lean();

    // ถ้าอยากให้เข้าถึงง่าย ๆ เป็น field แบน ๆ ก็เติม .username ให้แต่ละออเดอร์
    const orders = (ordersRaw || []).map(o => ({
      ...o,
      username: o.user?.username || '-',   // ใช้ใน EJS ได้ทั้ง o.user?.username หรือ o.username
    }));

    // (ออปชัน) ชื่อประเทศ — ยังไม่มี source ก็ปล่อยว่างไปก่อนได้
    const countries = {};

    // ---------------------------------------------
    // แท็บ 2: สรุปยอดขาย OTP (เฉพาะ status: success)
    // monthTotals = รวมทั้งเดือน, rows = รายวัน
    // ---------------------------------------------
    const matchMonthSuccess = {
      createdAt: { $gte: start, $lt: end },
      status: 'success',
    };

    // รวมทั้งเดือน
    const totalsAgg = await Otp24Order.aggregate([
      { $match: matchMonthSuccess },
      {
        $group: {
          _id: null,
          sale:   { $sum: { $ifNull: ['$salePrice', 0] } },
          cost:   { $sum: { $ifNull: ['$providerPrice', 0] } },
          count:  { $sum: 1 },
        }
      }
    ]);

    const monthTotals = {
      sale:  totalsAgg?.[0]?.sale  || 0,
      cost:  totalsAgg?.[0]?.cost  || 0,
      count: totalsAgg?.[0]?.count || 0,
    };
    monthTotals.profit = monthTotals.sale - monthTotals.cost;

    // รายวัน (timezone Asia/Bangkok)
    const rows = await Otp24Order.aggregate([
      { $match: matchMonthSuccess },
      {
        $addFields: {
          day: {
            $dateToString: {
              date: '$createdAt',
              format: '%Y-%m-%d',
              timezone: 'Asia/Bangkok'
            }
          }
        }
      },
      {
        $group: {
          _id: '$day',
          sale:  { $sum: { $ifNull: ['$salePrice', 0] } },
          cost:  { $sum: { $ifNull: ['$providerPrice', 0] } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]).then(list => list.map(r => ({
      day: r._id,
      sale: r.sale || 0,
      cost: r.cost || 0,
      count: r.count || 0,
      profit: (r.sale || 0) - (r.cost || 0),
    })));

    // เรนเดอร์หน้าเดียวสองแท็บ (ใช้ไฟล์ EJS เดิม)
    res.render('admin/otp-report', {
      // แท็บประวัติ
      orders,       // ← มีทั้ง o.user?.username และ o.username ให้เลือกใช้
      countries,

      // แท็บสรุป
      monthStr,
      monthTotals,
      rows,
    });
  } catch (e) {
    console.error('GET /admin/otp-report error:', e);
    res.status(500).send('เกิดข้อผิดพลาดในระบบ');
  }
});

export default router;
