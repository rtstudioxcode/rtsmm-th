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
export async function computeAffiliateTotals(uid) {
  const num = v => Number.isFinite(+v) ? +v : 0;

  // 🔎 ดึงผู้ใช้ที่ถูกแนะนำ
  const referred = await User.find({ referredBy: uid })
    .select('_id username createdAt')
    .lean();

  let orders = 0, spentTHB = 0;

  if (referred.length) {
    const refIds = referred.map(r => r._id);

    // 1) รวมฝั่ง SMM Orders
    const aggSmm = await Order.aggregate([
      {
        $match: {
          userId: { $in: refIds },
          status: { $in: PAID_STATUSES },
          charged: { $gt: 0 }
        }
      },
      {
        $group: {
          _id: '$userId',
          orders: { $sum: 1 },
          spentTHB: { $sum: SMM_NET }
        }
      }
    ]);

    // 2) รวมฝั่ง OTP24 Orders
    const aggOtp = await Otp24Order.aggregate([
      {
        $match: {
          user: { $in: refIds },
          status: { $in: OTP24_PAID_STATUSES },
          $or: [
            { salePrice: { $gt: 0 } },
            { priceTHB: { $gt: 0 } },
            { price: { $gt: 0 } },
            { amountTHB: { $gt: 0 } }
          ]
        }
      },
      {
        $group: {
          _id: '$user',
          orders: { $sum: 1 },
          spentTHB: {
            $sum: {
              $ifNull: [
                '$salePrice',
                { $ifNull: ['$priceTHB', { $ifNull: ['$price', 0] }] }
              ]
            }
          }
        }
      }
    ]);

    // 3) รวมผลทั้งสองแหล่ง
    const byUser = new Map();
    for (const a of aggSmm) {
      const k = String(a._id);
      byUser.set(k, { orders: num(a.orders), spentTHB: num(a.spentTHB) });
    }
    for (const b of aggOtp) {
      const k = String(b._id);
      const cur = byUser.get(k) || { orders: 0, spentTHB: 0 };
      cur.orders += num(b.orders);
      cur.spentTHB += num(b.spentTHB);
      byUser.set(k, cur);
    }

    // 4) รวมยอดรวมทั้งหมด
    for (const r of referred) {
      const a = byUser.get(String(r._id));
      if (a) {
        orders += a.orders;
        spentTHB += a.spentTHB;
      }
    }
  }

  // 5) ดึงค่า affiliate เดิม
  const u = await User.findById(uid).select('affiliate').lean();
  const paidTHB = Number(u?.affiliate?.paidTHB || 0);

  // 6) คำนวณเรต & ยอดใหม่
  const refCount = referred.length;
  const tierRate = tierRateFor(refCount, spentTHB);
  const adminRate = Number(u?.affiliate?.ratePct ?? NaN);
  const ratePct = Math.max(tierRate, Number.isFinite(adminRate) ? adminRate : 0, 5);

  const earnings = +(spentTHB * (ratePct / 100));
  const withdrawableTHB = Math.max(0, earnings - paidTHB);

  // 7) อัปเดต cache
  await User.updateOne(
    { _id: uid },
    {
      $set: {
        'affiliate.referredCount': refCount,
        'affiliate.earningsTHB': +earnings.toFixed(2),
        'affiliate.lastCalcAt': new Date(),
      },
    }
  );

  return {
    ratePct,
    referredCount: refCount,
    orders,
    spentTHB: +(+spentTHB).toFixed(2),
    earningsTHB: +(+earnings).toFixed(2),
    paidTHB: +(+paidTHB).toFixed(2),
    withdrawableTHB: +(+withdrawableTHB).toFixed(2),
  };
}