// src/services/spend.js
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';
import { Otp24Order } from '../models/Otp24Order.js';
import { LEVELS as LV_LOYALTY, getRateForLevelIndex as _getRate } from './loyalty.js';

// ─────────────────────────────────────────────────────────────
export async function reconcileUserByOrderEvent(orderId, { force = true } = {}) {
  if (!orderId) return { ok:false, error:'orderId is required' };
  const o = await Order.findById(orderId).select('_id user userId').lean();
  if (!o) return { ok:false, error:'order not found' };
  await reconcileOrderSpend(orderId);
  await recalcUserTotals(o.userId || o.user, { force, reason:'order_event' });
  return { ok:true, userId: String(o.userId || o.user) };
}

// ─────────────────────────────────────────────────────────────
// กติกาใหม่:
// - SMM: นับเฉพาะ 'completed' เต็มจำนวน และ 'partial' ตามสัดส่วนสำเร็จ
// - OTP24: นับเฉพาะ 'success' และใช้ salePrice เท่านั้น
// ─────────────────────────────────────────────────────────────
export const PAID_STATUSES = ['completed','partial'];
const COUNTABLE = new Set(PAID_STATUSES.map(s => String(s).toLowerCase()));

export const OTP24_PAID_STATUSES = ['success'];
const OTP24_COUNTABLE = new Set(OTP24_PAID_STATUSES.map(s => String(s).toLowerCase()));

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

const nz = (v) => (Number.isFinite(+v) ? +v : 0);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function calcOtp24NetTHB(doc) {
  if (!doc) return 0;
  const st = String(doc.status || '').toLowerCase();
  if (!OTP24_COUNTABLE.has(st)) return 0;

  const gross  = nz(doc.salePrice);
  const refund = nz(doc.refundAmount);
  return Math.max(0, round2(gross - refund));
}

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
  return { index: idx, name: lv.name, need: lv.need, nextName: next?.name || null, toNext: next ? Math.max(0, next.need - total) : 0 };
}

function buildUserMatch(userId) {
  const idStr = String(userId || '');
  const oid = mongoose.Types.ObjectId.isValid(idStr)
    ? new mongoose.Types.ObjectId(idStr) : null;
  return { $or: [ ...(oid? [{user:oid},{userId:oid}] : []), {user:idStr},{userId:idStr} ] };
}

// ─────────────────────────────────────────────────────────────
// คำนวณสุทธิ SMM
// ─────────────────────────────────────────────────────────────
export function calcOrderNetTHB(order) {
  if (!order) return 0;

  const st = String(order.status || '').toLowerCase();
  if (!COUNTABLE.has(st)) return 0;

  const qty  = nz(order.quantity);
  const rate = nz(order.rateAtOrder) || nz(order.rate);
  const baseCost =
    nz(order.cost) || nz(order.estCost) || nz(order.charged) ||
    (qty ? (rate * qty) / 1000 : 0);

  if (st === 'completed') {
    let refund = nz(order.refundAmount);
    if (!refund && Array.isArray(order.partialRefunds)) {
      refund = order.partialRefunds.reduce((s, r) => s + nz(r.amount), 0);
    }
    return Math.max(0, round2(baseCost - refund));
  }

  // partial → คิดตามสัดส่วนที่สำเร็จ
  let delivered = 0;
  if (qty > 0) {
    const remains = nz(order.remains);
    if (remains > 0) {
      delivered = Math.max(0, Math.min(qty, qty - remains));
    } else {
      const d1 = nz(order.currentCount) - nz(order.startCount);
      if (d1 > 0) delivered = Math.min(qty, d1);
      else {
        const pr = order?.providerResponse?.lastStatus;
        const r2 = nz(pr?.remains);
        if (r2 > 0) delivered = Math.max(0, Math.min(qty, qty - r2));
      }
    }
  }
  const ratio = (qty > 0) ? Math.max(0, Math.min(1, delivered / qty)) : 0;
  return round2(baseCost * ratio); // partial ไม่ต้องหัก refund เพิ่ม
}

// ─────────────────────────────────────────────────────────────
// Reconcile ต่อใบ (delta-based)
// ─────────────────────────────────────────────────────────────
export async function reconcileOtp24OrderSpend(orderId, { session } = {}) {
  const q = Otp24Order.findById(orderId);
  if (session) q.session(session);
  const o = await q;
  if (!o) return { ok:false, reason:'not_found' };

  const currentNet = calcOtp24NetTHB(o);
  const accounted  = nz(o.otpSpentAccounted);
  const delta      = round2(currentNet - accounted);

  if (delta !== 0) {
    await User.updateOne(
      { _id: o.userId || o.user },
      { $inc: { totalSpentRaw: delta } },
      { session }
    );
    o.otpSpentAccounted   = currentNet;
    o.otpSpentAccountedAt = new Date();
    await o.save({ session });
  }
  return { ok:true, changed: delta !== 0, delta, newAccounted: currentNet };
}

export async function reconcileAllOtp24ForUser(userId) {
  const match = buildUserMatch(userId);
  const list = await Otp24Order.find(
    { ...match },
    { status:1, salePrice:1, otpSpentAccounted:1, updatedAt:1 }
  ).lean();

  let sumDelta = 0;
  const bulk = [];

  for (const o of list) {
    const currentNet = calcOtp24NetTHB(o);
    const accounted  = nz(o.otpSpentAccounted);
    const delta      = round2(currentNet - accounted);
    if (delta === 0) continue;

    sumDelta += delta;
    bulk.push({
      updateOne: {
        filter: { _id: o._id },
        update: { $set: { otpSpentAccounted: currentNet, otpSpentAccountedAt: new Date() } }
      }
    });
  }

  if (sumDelta !== 0) {
    await User.updateOne({ _id: userId }, { $inc: { totalSpentRaw: sumDelta } });
  }
  if (bulk.length) await Otp24Order.bulkWrite(bulk, { ordered:false });

  return { ok:true, sumDelta, changed: bulk.length };
}

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
      { _id: o.userId || o.user },
      { $inc: { totalSpentRaw: delta } },
      { session }
    );
    o.spentAccounted   = currentNet;
    o.spentAccountedAt = new Date();
    await o.save({ session });
  }
  return { ok:true, changed: delta !== 0, delta, newAccounted: currentNet };
}

export async function reconcileAllOrdersForUser(userId) {
  const match = buildUserMatch(userId);
  const list = await Order.find(match, {
    status:1, quantity:1, rate:1, rateAtOrder:1, cost:1, estCost:1, charged:1,
    refundAmount:1, partialRefunds:1, service:1, spentAccounted:1,
    remains:1, startCount:1, currentCount:1,
    'providerResponse.lastStatus.remains':1
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
// Recalc รวม (เลเวล/แต้ม/ยอด)
// ─────────────────────────────────────────────────────────────
export async function recalcUserTotals(userId, opts = {}) {
  const { force = false, fullRescan = false } = opts;
  if (!userId) return { ok:false, error:'userId is required' };

  const now = Date.now();
  const last = lastRunAt.get(String(userId)) || 0;
  if (!force && now - last < COOLDOWN_MS) {
    return { ok:true, skipped:true, reason:'cooldown' };
  }
  lastRunAt.set(String(userId), now);

  const userMatch = buildUserMatch(userId);

  const [ordAll, ordPaid, otpAll, otpPaid] = await Promise.all([
    Order.countDocuments({ ...userMatch }),
    Order.countDocuments({ ...userMatch, status: { $in: PAID_STATUSES } }),
    Otp24Order.countDocuments({ ...userMatch }),
    Otp24Order.countDocuments({ ...userMatch, status: { $in: OTP24_PAID_STATUSES } }),
  ]);

  const totalOrders = ordAll + otpAll;
  const totalOrdersPaid = ordPaid + otpPaid;

  let smmDelta = 0, otpDelta = 0;
  if (fullRescan) {
    const r = await Promise.allSettled([
      reconcileAllOrdersForUser(userId),
      reconcileAllOtp24ForUser(userId),
    ]);
    smmDelta = (r[0].status === 'fulfilled' ? (r[0].value?.sumDelta || 0) : 0);
    otpDelta = (r[1].status === 'fulfilled' ? (r[1].value?.sumDelta || 0) : 0);
  }
  const sumDelta = round2(nz(smmDelta) + nz(otpDelta));

  const u = await User.findById(userId).select('totalSpentRaw redeemedSpent pointsRedeemed').lean();

  const totalSpentRaw = round2(nz(u?.totalSpentRaw));
  const redeemedSpent = round2(nz(u?.redeemedSpent));
  const effectiveSpent = round2(Math.max(0, totalSpentRaw - redeemedSpent));

  const level = computeLevel(effectiveSpent);
  const lvMeta = decideLevel(effectiveSpent);
  const pointsAccrued = calcPoints(effectiveSpent);
  const pointsRedeemed = nz(u?.pointsRedeemed);
  const points = Math.max(0, round2(pointsAccrued - pointsRedeemed));
  const pointRateTHB = getRateForLevelIndex(lvMeta.index);
  const pointValueTHB = round2(points * pointRateTHB);

  const [ lastPaidOrd, lastPaidOtp ] = await Promise.all([
    Order.findOne(
      { ...userMatch, status: { $in: PAID_STATUSES } },
      { updatedAt:1, createdAt:1 }
    ).sort({ updatedAt:-1, createdAt:-1 }).lean(),
    Otp24Order.findOne(
      { ...userMatch, status: { $in: OTP24_PAID_STATUSES } },
      { updatedAt:1, createdAt:1 }
    ).sort({ updatedAt:-1, createdAt:-1 }).lean(),
  ]);
  const lastPaidAtOrd = lastPaidOrd?.updatedAt || lastPaidOrd?.createdAt || null;
  const lastPaidAtOtp = lastPaidOtp?.updatedAt || lastPaidOtp?.createdAt || null;
  const lastPaidAt = new Date(Math.max(
    lastPaidAtOrd ? +new Date(lastPaidAtOrd) : 0,
    lastPaidAtOtp ? +new Date(lastPaidAtOtp) : 0,
    Date.now()
  ));

  await User.updateOne(
    { _id: userId },
    {
      $set: {
        totalOrders,
        totalOrdersPaid,
        totalSpentRaw,
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
    smmDelta,
    otpDelta,
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
