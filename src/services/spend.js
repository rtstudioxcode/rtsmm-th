// src/services/spend.js
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';
import { LEVELS as LV_LOYALTY, getRateForLevelIndex as _getRate } from './loyalty.js';
import { computeEffectiveRate } from '../lib/pricing.js';


// ─────────────────────────────────────────────────────────────
// helper: reconcile ใบนี้ แล้วสรุปรวมให้ user (ใช้ใน routes ต่าง ๆ )
// ─────────────────────────────────────────────────────────────
export async function reconcileUserByOrderEvent(orderId, { force = true } = {}) {
  if (!orderId) return { ok:false, error:'orderId is required' };

  // อ่าน userId จากออเดอร์ใบนี้
  const o = await Order.findById(orderId).select('_id user userId').lean();
  if (!o) return { ok:false, error:'order not found' };

  // ซ่อมยอดของออเดอร์ใบนี้ด้วย delta
  await reconcileOrderSpend(orderId);

  // สรุปรวมให้ผู้ใช้ (เลเวล/แต้ม/ยอดโชว์)
  await recalcUserTotals(o.userId || o.user, { force, reason:'order_event' });

  return { ok:true, userId: String(o.userId || o.user) };
}

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
export const PAID_STATUSES = [
  'inprogress','partial','completed','success','done','refilled'
];
const COUNTABLE = new Set(PAID_STATUSES.map(s => String(s).toLowerCase()));

export const LEVELS = Object.freeze([
  { name:'เลเวล 1',   need:0 },
  { name:'เลเวล 2',   need:5_000 },
  { name:'เลเวล 3',   need:10_000 },
  { name:'เลเวล 4',   need:30_000 },
  { name:'เลเวล 5',   need:50_000 },
  { name:'Retail',    need:80_000 },
  { name:'Wholesale', need:175_000 },
  { name:'Reseller',  need:700_000 },
  { name:'VIP',       need:1_000_000 },
  { name:'Legendary', need:5_000_000 },
]);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const nz = (v) => (Number.isFinite(+v) ? +v : 0);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function calcPoints(totalSpentEff = 0) {
  const spent = Number(totalSpentEff) || 0;
  const earned = Math.floor(spent / 50) * 0.5;
  return Math.max(0, Math.round(earned * 100) / 100);
}
function getRateForLevelIndex(idx = 0) {
  if (typeof _getRate === 'function') return _getRate(idx);
  const lv = LV_LOYALTY?.[idx];
  if (!lv?.rate) return 0;
  const n = Number(String(lv.rate).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
const lastRunAt = new Map();
const COOLDOWN_MS = 5_000;

export function computeLevel(total = 0) {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (total >= LEVELS[i].need) idx = i; else break;
  }
  return String(Math.max(1, idx + 1));
}
export function decideLevel(total = 0) {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (total >= LEVELS[i].need) idx = i; else break;
  }
  const lv = LEVELS[idx];
  const next = LEVELS[idx + 1] || null;
  return {
    index: idx,
    name: lv.name,
    need: lv.need,
    nextName: next?.name || null,
    toNext: next ? Math.max(0, next.need - total) : 0,
  };
}
function buildUserMatch(userId) {
  const idStr = String(userId || '');
  const oid = mongoose.Types.ObjectId.isValid(idStr)
    ? new mongoose.Types.ObjectId(idStr) : null;
  return { $or: [ ...(oid? [{user:oid},{userId:oid}] : []), {user:idStr},{userId:idStr} ] };
}

/**
 * คำนวณ "ยอดสุทธิที่ควรนับตอนนี้" ของออเดอร์ (THB)
 * - ใช้ cost/estCost/charged ถ้ามี
 * - ถ้าไม่มีให้คำนวณจาก rate × qty / 1000 (พิจารณา rateAtOrder/service)
 * - หัก refundAmount/partialRefunds
 * - ถ้าสถานะไม่อยู่ใน COUNTABLE → คืน 0
 */
export function calcOrderNetTHB(order) {
  if (!order) return 0;

  // สถานะยังไม่นับ → 0
  const st = String(order.status || '').toLowerCase();
  if (!COUNTABLE.has(st)) return 0;

  // ยอดรวมก่อนหักคืน
  let gross = nz(order.cost) || nz(order.estCost) || nz(order.charged);
  if (!gross) {
    const rate =
      nz(order.rate) ||
      nz(order.rateAtOrder) ||
      nz(order?.service?.rateTHB) ||
      nz(order?.service?.baseRateTHB) ||
      nz(order?.service?.rate);
    const qty = nz(order.quantity);
    // สมมติหน่วยเป็น "บาท/1000"
    gross = (rate * qty) / 1000;
  }

  // ยอดคืนรวม
  let refund = nz(order.refundAmount);
  if (!refund && Array.isArray(order.partialRefunds)) {
    refund = order.partialRefunds.reduce((s, r) => s + nz(r.amount), 0);
  }

  return Math.max(0, round2(gross - refund));
}

/**
 * ปรับยอดผู้ใช้ด้วย "ส่วนต่าง (delta)" ของออเดอร์ใบเดียว (idempotent)
 * - delta = currentNet - spentAccounted
 * - อัปเดต User.totalSpentRaw += delta
 * - เซฟ snapshot ลง order.spentAccounted / spentAccountedAt
 */
export async function reconcileOrderSpend(orderId, { session } = {}) {
  const q = Order.findById(orderId).populate('service');
  if (session) q.session(session);
  const o = await q;
  if (!o) return { ok:false, reason:'not_found' };

  const currentNet = calcOrderNetTHB(o);
  const accounted  = nz(o.spentAccounted);
  const delta      = round2(currentNet - accounted);

  if (delta !== 0) {
    await User.updateOne(
      { _id: o.userId },
      { $inc: { totalSpentRaw: delta } },
      { session }
    );

    o.spentAccounted   = currentNet;
    o.spentAccountedAt = new Date();
    await o.save({ session });
  }

  return { ok:true, changed: delta !== 0, delta, newAccounted: currentNet };
}

/**
 * batch ทั้ง user: เดินทุกออเดอร์ของผู้ใช้ แล้วปรับส่วนต่างให้ครบ
 * ใช้กรณี CRON ซ่อมยอด หรือเวลาต้องการรีคอนซายล์ทั้ง user
 */
export async function reconcileAllOrdersForUser(userId) {
  const match = buildUserMatch(userId);
  const list = await Order.find(match, {
    status:1, quantity:1, rate:1, rateAtOrder:1, cost:1, estCost:1, charged:1,
    refundAmount:1, partialRefunds:1, service:1, spentAccounted:1
  }).populate('service').lean();

  let sumDelta = 0;
  const bulk = [];

  for (const o of list) {
    const currentNet = calcOrderNetTHB(o);
    const accounted  = nz(o.spentAccounted);
    const delta      = round2(currentNet - accounted);
    if (delta === 0) continue;

    sumDelta += delta;
    bulk.push({
      updateOne: {
        filter: { _id: o._id },
        update: { $set: { spentAccounted: currentNet, spentAccountedAt: new Date() } }
      }
    });
  }

  if (sumDelta !== 0) {
    await User.updateOne({ _id: userId }, { $inc: { totalSpentRaw: sumDelta } });
  }
  if (bulk.length) await Order.bulkWrite(bulk, { ordered: false });

  return { ok:true, sumDelta, changed: bulk.length };
}

// ─────────────────────────────────────────────────────────────
// main recalculation (รวมเลเวล/แต้ม + ซ่อมยอดแบบ delta)
// ─────────────────────────────────────────────────────────────
export async function recalcUserTotals(userId, opts = {}) {
  const { force = false } = opts;
  if (!userId) return { ok:false, error:'userId is required' };

  const now = Date.now();
  const last = lastRunAt.get(String(userId)) || 0;
  if (!force && now - last < COOLDOWN_MS) {
    return { ok:true, skipped:true, reason:'cooldown' };
  }
  lastRunAt.set(String(userId), now);

  const userMatch = buildUserMatch(userId);

  // 1) นับจำนวนออเดอร์ (ทั้งหมด/ที่นับได้ตามสถานะ)
  const [ totalOrders, totalOrdersPaid ] = await Promise.all([
    Order.countDocuments({ ...userMatch }), // รวมทุกสถานะ (รวม canceled)
    Order.countDocuments({ ...userMatch, status: { $in: PAID_STATUSES } })
  ]);

  // 2) ซ่อมยอดรวมด้วย delta ของทุกออเดอร์
  const { sumDelta } = await reconcileAllOrdersForUser(userId);

  // 3) อ่าน user ปัจจุบัน (หลัง inc แล้วเพื่อความถูกต้อง)
  const u = await User.findById(userId).select('totalSpentRaw redeemedSpent pointsRedeemed').lean();

  const totalSpentRaw = round2(nz(u?.totalSpentRaw));  // ดึงจาก user (ถูกซ่อมด้วย delta แล้ว)
  const redeemedSpent = round2(nz(u?.redeemedSpent));  // ยอดที่เคยแลกแต้มไปแล้ว (ไม่แก้ที่นี่)
  const effectiveSpent = round2(Math.max(0, totalSpentRaw - redeemedSpent));

  // 4) คำนวณเลเวล/แต้ม
  const level = computeLevel(effectiveSpent);
  const lvMeta = decideLevel(effectiveSpent);

  const pointsAccrued = calcPoints(effectiveSpent);
  const pointsRedeemed = nz(u?.pointsRedeemed);
  const points = Math.max(0, round2(pointsAccrued - pointsRedeemed));

  const pointRateTHB = getRateForLevelIndex(lvMeta.index);
  const pointValueTHB = round2(points * pointRateTHB);

  // 5) lastSpentAt: อ้างอิงออเดอร์ที่นับได้ล่าสุด
  const lastPaidDoc = await Order.findOne(
    { ...userMatch, status: { $in: PAID_STATUSES } },
    { updatedAt:1, createdAt:1 }
  ).sort({ updatedAt:-1, createdAt:-1 }).lean();
  const lastPaidAt = lastPaidDoc?.updatedAt || lastPaidDoc?.createdAt || new Date();

  // 6) update user fields ที่แสดงผล
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        totalOrders,
        totalOrdersPaid,

        // เก็บค่า “จากออเดอร์จริง” (ถูก reconcile แล้ว)
        totalSpentRaw,

        // สำหรับแสดงผล (หลังหักที่เคยแลกไปแล้ว)
        totalSpent: effectiveSpent,

        level,
        levelIndex: lvMeta.index,
        levelName: lvMeta.name,
        levelNeed: lvMeta.need,
        nextLevelName: lvMeta.nextName,
        toNextLevel: lvMeta.toNext,
        lastSpentAt: lastPaidAt,

        points,
        pointsAccrued,
        pointRateTHB,
        pointValueTHB,
      },
    }
  );

  return {
    ok: true,
    deltaApplied: sumDelta,
    totalOrders,
    totalOrdersPaid,
    totalSpentRaw,
    totalSpent: effectiveSpent,
    redeemedSpent,
    level,
    levelInfo: lvMeta,
    points,
    pointsAccrued,
    pointsRedeemed,
    pointRateTHB,
    pointValueTHB,
  };
}

export async function recalcUserTotalSpent(userId, opts = {}) {
  return recalcUserTotals(userId, opts);
}
