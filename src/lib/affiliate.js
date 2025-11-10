// src/lib/affiliate.js
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';
import { Otp24Order } from '../models/Otp24Order.js';

export const PAID_STATUSES = ['inprogress','partial','completed','success','done','refilled'];
const COUNTABLE = new Set(PAID_STATUSES.map(s => String(s).toLowerCase()));

const OTP24_PAID_STATUSES = ['success','completed','done'];
const OTP24_COUNTABLE = new Set(OTP24_PAID_STATUSES.map(s => String(s).toLowerCase()));

/** ตารางเลื่อนระดับ (ออโต้) — เริ่ม 5%, สูงสุด 40% */
export const AFF_TIERS = Object.freeze([
  { rate: 5,  refs: 0,   earn: 0 },
  { rate: 6,  refs: 10,  earn: 0 },
  { rate: 8,  refs: 20,  earn: 3000 },
  { rate: 13, refs: 30,  earn: 5000 },
  { rate: 23, refs: 50,  earn: 10000 },
  { rate: 34, refs: 70,  earn: 20000 },
  { rate: 40, refs: 100, earn: 50000 }, // ⛳️ สูงสุด 40%
]);

/** หาเรตจากตารางตาม refs & earn (บาท) */
export function tierRateFor(refCount, earnTHB) {
  let best = AFF_TIERS[0].rate;
  for (const t of AFF_TIERS) {
    if (refCount >= t.refs && earnTHB >= t.earn) best = t.rate;
  }
  return Math.min(best, 40); // cap 40%
}

export async function getAffRateForUser(userId, { referredCount, earningsTHB } = {}) {
  const u = await User.findById(userId).select('affiliate').lean();
  const adminRate = Number(u?.affiliate?.ratePct ?? NaN);
  const tierRate = tierRateFor(
    Number(referredCount ?? u?.affiliate?.referredCount ?? 0),
    Number(earningsTHB  ?? u?.affiliate?.earningsTHB   ?? 0)
  );
  const eff = Math.max(Number.isFinite(adminRate) ? adminRate : 0, tierRate, 5);
  return eff / 100; // → 0..0.40
}

/** ---------------- helpers for aggregation (SMM/OTP24) ---------------- */
const REDUCE_PARTIAL_REFUNDS = {
  $reduce: {
    input: { $ifNull: ['$partialRefunds', []] },
    initialValue: 0,
    in: { $add: ['$$value', { $ifNull: ['$$this.amount', 0] }] }
  }
};

// SMM gross: cost → estCost → charged → (rate*quantity/1000)
const SMM_GROSS = {
  $cond: [
    { $gt: ['$cost', 0] }, '$cost',
    {
      $cond: [
        { $gt: ['$estCost', 0] }, '$estCost',
        {
          $cond: [
            { $gt: ['$charged', 0] }, '$charged',
            { $divide: [ { $multiply: ['$rate', '$quantity'] }, 1000 ] }
          ]
        }
      ]
    }
  ]
};
const SMM_REFUNDS = { $add: [ { $ifNull: ['$refundAmount', 0] }, REDUCE_PARTIAL_REFUNDS ] };
const SMM_NET = { $max: [0, { $subtract: [ SMM_GROSS, SMM_REFUNDS ] }] };

// OTP24 gross: cost → priceTHB → price → amountTHB
const OTP_GROSS = {
  $cond: [
    { $gt: ['$cost', 0] }, '$cost',
    {
      $cond: [
        { $gt: ['$priceTHB', 0] }, '$priceTHB',
        { $cond: [ { $gt: ['$price', 0] }, '$price', { $ifNull: ['$amountTHB', 0] } ] }
      ]
    }
  ]
};
const OTP_REFUNDS = { $ifNull: ['$refundAmount', 0] };
const OTP_NET = { $max: [0, { $subtract: [ OTP_GROSS, OTP_REFUNDS ] }] };

/** ---------------- main ---------------- */
export async function computeAffiliateTotals(uid){
  // 🔎 ใครเราแนะนำมา (ตามที่โปรเจกต์ใช้: User.referredBy)
  const referred = await User.find({ referredBy: uid })
    .select('_id username createdAt')
    .lean();

  let orders = 0, spentTHB = 0;

  if (referred.length) {
    const refIds = referred.map(r => r._id);

    // 1) รวมฝั่ง SMM Orders
    const aggSmm = await Order.aggregate([
      { $match: { userId: { $in: refIds }, status: { $in: PAID_STATUSES } } },
      { $group: {
        _id: '$userId',
        orders: { $sum: 1 },
        spentTHB: { $sum: SMM_NET }
      }}
    ]);

    // 2) รวมฝั่ง OTP24 Orders
    const aggOtp = await Otp24Order.aggregate([
      { $match: { user: { $in: refIds }, status: { $in: OTP24_PAID_STATUSES } } },
      { $group: { _id: '$user', orders: { $sum: 1 },
        spentTHB: { $sum: { $ifNull: ['$salePrice', { $ifNull: ['$priceTHB', { $ifNull: ['$price', 0] }] }] } } } }
    ]);

    // 3) รวมผลตามผู้ใช้
    const byUser = new Map();
    // จาก SMM orders
    for (const a of aggSmm) {
      const k = String(a._id);
      byUser.set(k, {
        orders: num(a.orders),
        spentTHB: num(a.spentTHB),
      });
    }
    // จาก OTP24 orders (บวกทับ)
    for (const b of aggOtp) {
      const k = String(b._id);
      const cur = byUser.get(k) || { orders: 0, spentTHB: 0 };
      cur.orders  = num(cur.orders)  + num(b.orders);
      cur.spentTHB = num(cur.spentTHB) + num(b.spentTHB);
      byUser.set(k, cur);
    }

    for (const r of referred) {
      const a = byUser.get(String(r._id));
      if (a) { orders += (a.orders || 0); spentTHB += (a.spentTHB || 0); }
    }
  }

  // cache ที่เคยจ่าย
  const u = await User.findById(uid).select('affiliate').lean();
  const paidTHB = Number(u?.affiliate?.paidTHB || 0);

  // rate จาก tier + admin override (ขั้นต่ำ 5%)
  const refCount = referred.length;
  const tierRate = tierRateFor(refCount, spentTHB);
  const adminRate = Number(u?.affiliate?.ratePct ?? NaN);
  const ratePct  = Math.max(tierRate, Number.isFinite(adminRate) ? adminRate : 0, 5);

  const earnings = +(spentTHB * (ratePct / 100));
  const withdrawableTHB = Math.max(0, earnings - paidTHB);

  // หา "ระดับถัดไป"
  const idxNow = AFF_TIERS.findIndex(t => t.rate === tierRate);
  const atMax  = (idxNow >= AFF_TIERS.length - 1) || ratePct >= 40;
  let next = null, progressPct = 100;

  if (!atMax) {
    const tNext = AFF_TIERS[idxNow + 1];
    next = { rate: tNext.rate, refs: tNext.refs, earn: tNext.earn };

    const pRefs = Math.min(1, refCount / Math.max(1, tNext.refs));
    const pEarn = Math.min(1, spentTHB / Math.max(1, tNext.earn || 0.00001));
    // ความคืบหน้า = เงื่อนไขที่ต่ำกว่า (ต้องครบทั้งคู่)
    progressPct = Math.round(Math.min(pRefs, pEarn) * 100);
  } else {
    progressPct = 100;
  }

  // อัปเดต cache เบาๆ
  await User.updateOne(
    { _id: uid },
    {
      $set: {
        'affiliate.referredCount': refCount,
        'affiliate.earningsTHB': +earnings.toFixed(2),
        'affiliate.lastCalcAt': new Date()
      }
    }
  );

  return {
    // สำหรับหัวการ์ด + KPI
    ratePct,                         // เรตใช้งานจริง (เปอร์เซ็นต์)
    referredCount: refCount,
    orders,
    spentTHB: +(+spentTHB).toFixed(2),
    earningsTHB: +(+earnings).toFixed(2),
    paidTHB: +(+paidTHB).toFixed(2),
    withdrawableTHB: +(+withdrawableTHB).toFixed(2),

    // สำหรับหลอด + โมดัล
    tier: {
      currentRate: tierRate,
      atMax: ratePct >= 40,
      progressPct,
      next, // {rate, refs, earn} | null
    }
  };
}
