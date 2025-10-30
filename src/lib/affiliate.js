// src/lib/affiliate.js
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';

export const PAID_STATUSES = ['paid','completed','success','done','processing'];

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

export async function computeAffiliateTotals(uid){
  // ใครเราแนะนำมา
  const referred = await User.find({ referredBy: uid })
    .select('_id username createdAt')
    .lean();

  let orders = 0, spentTHB = 0;
  if (referred.length) {
    const refIds = referred.map(r => r._id);
    const agg = await Order.aggregate([
      { $match: { userId: { $in: refIds }, status: { $in: PAID_STATUSES } } },
      { $group: { _id: '$userId', orders: { $sum: 1 }, spentTHB: { $sum: '$costTHB' } } }
    ]);
    const byUser = new Map(agg.map(a => [String(a._id), a]));
    for (const r of referred) {
      const a = byUser.get(String(r._id));
      if (a) { orders += a.orders; spentTHB += a.spentTHB; }
    }
  }

  // cache ที่เคยจ่าย
  const u = await User.findById(uid).select('affiliate').lean();
  const paidTHB = Number(u?.affiliate?.paidTHB || 0);

  // rate จาก tier + admin override
  const refCount = referred.length;
  const tierRate = tierRateFor(refCount, spentTHB);
  const adminRate = Number(u?.affiliate?.ratePct ?? NaN);
  const ratePct  = Math.max(tierRate, Number.isFinite(adminRate) ? adminRate : 0, 5);
  const earnings = +(spentTHB * (ratePct/100));
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
  await User.updateOne({ _id: uid }, {
    $set: {
      'affiliate.referredCount': refCount,
      'affiliate.earningsTHB': +earnings.toFixed(2),
      'affiliate.lastCalcAt': new Date()
    }
  });

  return {
    // สำหรับหัวการ์ด + KPI
    ratePct,                         // เรตใช้งานจริง (ค่าสูงสุด)
    referredCount: refCount,
    orders,
    spentTHB: +spentTHB,
    earningsTHB: +earnings,
    paidTHB: +paidTHB,
    withdrawableTHB: +withdrawableTHB,

    // สำหรับหลอด + โมดัล
    tier: {
      currentRate: tierRate,
      atMax: ratePct >= 40,
      progressPct,
      next, // {rate, refs, earn} | null
    }
  };
}
