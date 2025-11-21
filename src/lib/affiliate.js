// src/lib/affiliate.js
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';
import { Otp24Order } from '../models/Otp24Order.js';
import { BonustimeOrder } from '../models/BonustimeOrder.js';

/* ───────────────────────── Config / Tiers ───────────────────────── */

export const AFF_TIERS = Object.freeze([
  { rate: 5,  refs: 0,   earn: 0 },
  { rate: 6,  refs: 10,  earn: 0 },
  { rate: 8,  refs: 20,  earn: 3000 },
  { rate: 13, refs: 30,  earn: 5000 },
  { rate: 23, refs: 50,  earn: 10000 },
  { rate: 34, refs: 70,  earn: 20000 },
  { rate: 40, refs: 100, earn: 50000 }, // cap 40%
]);

export function tierRateFor(refCount, earnTHB) {
  let best = AFF_TIERS[0].rate;
  for (const t of AFF_TIERS) {
    if (refCount >= t.refs && earnTHB >= t.earn) best = t.rate;
  }
  return Math.min(best, 40);
}

export async function getAffRateForUser(userId, { referredCount, earningsTHB } = {}) {
  const u = await User.findById(userId).select('affiliate').lean();
  const adminRate = Number(u?.affiliate?.ratePct ?? NaN);
  const tier = tierRateFor(
    Number(referredCount ?? u?.affiliate?.referredCount ?? 0),
    Number(earningsTHB  ?? u?.affiliate?.earningsTHB   ?? 0),
  );
  const eff = Math.max(Number.isFinite(adminRate) ? adminRate : 0, tier, 5);
  return eff / 100;
}

/* ───────────────────────── Match helpers ───────────────────────── */

const toOid = (v) => mongoose.Types.ObjectId.isValid(String(v))
  ? new mongoose.Types.ObjectId(String(v))
  : null;

function matchUserAny(userId) {
  const idStr = String(userId || '');
  const oid = toOid(idStr);
  return { $or: [ ...(oid ? [{ user: oid }, { userId: oid }] : []), { user: idStr }, { userId: idStr } ] };
}

/* ───────────────────── Logic identical to spend.js ───────────────────── */

// กติกาตาม spend.js
const SMM_OK  = new Set(['completed','partial']);
const OTP_OK  = new Set(['success']);

const nz     = (v) => (Number.isFinite(+v) ? +v : 0);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// คิดสุทธิของ SMM (completed/partial)
export function calcOrderNetTHB(order) {
  if (!order) return 0;
  const st = String(order.status || '').toLowerCase();
  if (!SMM_OK.has(st)) return 0;

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

  // partial → สัดส่วนสำเร็จ
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
  return round2(baseCost * ratio);
}

// คิดสุทธิของ OTP24 (success เท่านั้น, ใช้ salePrice - refund)
export function calcOtp24NetTHB(doc) {
  if (!doc) return 0;
  const st = String(doc.status || '').toLowerCase();
  if (!OTP_OK.has(st)) return 0;

  const gross  = nz(doc.salePrice);
  const refund = nz(doc.refundAmount);
  return Math.max(0, round2(gross - refund));
}

/* ───────────────────── Main: computeAffiliateTotals ───────────────────── */

export async function computeAffiliateTotals(uid) {
  const me = await User.findById(uid).select('affiliate').lean();
  if (!me) return {
    ratePct: 5, referredCount: 0, orders: 0, spentTHB: 0,
    earningsTHB: 0, paidTHB: 0, withdrawableTHB: 0,
  };

  // ดึงรายชื่อ “เพื่อนที่ถูกคุณแนะนำ”
  const referred = await User.find({ referredBy: uid })
    .select('_id username createdAt')
    .lean();

  const refIds = referred.map(r => r._id);
  let orders = 0;
  let spentTHB = 0;

  if (refIds.length) {
    // โหลดออเดอร์ของเพื่อนทั้งหมดที่ “มีสิทธิ์นับ”
    const [smmOrders, otpOrders] = await Promise.all([
      Order.find({ userId: { $in: refIds }, status: { $in: Array.from(SMM_OK) } })
           .select('userId user status quantity rate rateAtOrder cost estCost charged refundAmount partialRefunds remains startCount currentCount providerResponse.lastStatus.remains')
           .lean(),
      Otp24Order.find({ user: { $in: refIds }, status: { $in: Array.from(OTP_OK) } })
                .select('user status salePrice refundAmount')
                .lean(),
    ]);

    orders   += smmOrders.length + otpOrders.length;
    spentTHB += smmOrders.reduce((s, o) => s + calcOrderNetTHB(o), 0);
    spentTHB += otpOrders.reduce((s, o) => s + calcOtp24NetTHB(o), 0);
  }

  // 🔹 รวม “โบนัสจาก Bonustime” ที่จ่ายเป็น affiliateRewardTHB
  let btBonusTHB = 0;
  const oid = toOid(uid);
  if (oid) {
    const btAgg = await BonustimeOrder.aggregate([
      { $match: { referrer: oid } },
      {
        $group: {
          _id: null,
          reward: { $sum: '$affiliateRewardTHB' },
        },
      },
    ]);

    btBonusTHB = round2(btAgg?.[0]?.reward || 0);
  }

  // อัตรา/การถอน (คง logic เดิม)
  const paidTHB   = Number(me?.affiliate?.paidTHB || 0);
  const refCount  = referred.length;
  const tier      = tierRateFor(refCount, spentTHB);
  const adminRate = Number(me?.affiliate?.ratePct ?? NaN);
  const ratePct   = Math.max(tier, Number.isFinite(adminRate) ? adminRate : 0, 5);

  // ✅ รายได้จากยอดใช้จ่ายของเพื่อน + โบนัส Bonustime
  const baseEarnings = round2(spentTHB * (ratePct / 100));
  const earnings     = round2(baseEarnings + btBonusTHB);

  const withdrawableTHB = Math.max(0, round2(earnings - paidTHB));

  // อัปเดต cache เบา ๆ
  await User.updateOne(
    { _id: uid },
    {
      $set: {
        'affiliate.referredCount': refCount,
        'affiliate.earningsTHB': earnings,
        'affiliate.lastCalcAt': new Date(),
        // จะเก็บ field แยกไว้ debug ก็ได้ ถ้าอยาก
        // 'affiliate.btBonusTHB': btBonusTHB,
      },
    }
  );

  return {
    ratePct,
    referredCount: refCount,
    orders,
    spentTHB: round2(spentTHB),
    earningsTHB: earnings,
    paidTHB: round2(paidTHB),
    withdrawableTHB,
    // bonusTHB: btBonusTHB, // เผื่อเอาไปโชว์หน้าเว็บ
  };
}

/* ───────────────────── Debug helper (optional) ───────────────────── */
// คืน breakdown รายคน (เปิดใช้ตอนต้องการ)
export async function computeAffiliateBreakdown(uid) {
  const referred = await User.find({ referredBy: uid }).select('_id username').lean();
  const refIds = referred.map(r => r._id);
  const map = new Map(refIds.map(id => [String(id), { orders:0, spent:0 }]));

  const smm = await Order.find({ userId: { $in: refIds }, status: { $in: Array.from(SMM_OK) } })
    .select('userId status quantity rate rateAtOrder cost estCost charged refundAmount partialRefunds remains startCount currentCount providerResponse.lastStatus.remains').lean();
  for (const o of smm) {
    const k = String(o.userId);
    const rec = map.get(k); if (!rec) continue;
    rec.orders += 1; rec.spent += calcOrderNetTHB(o);
  }

  const otp = await Otp24Order.find({ user: { $in: refIds }, status: { $in: Array.from(OTP_OK) } })
    .select('user status salePrice refundAmount').lean();
  for (const o of otp) {
    const k = String(o.user);
    const rec = map.get(k); if (!rec) continue;
    rec.orders += 1; rec.spent += calcOtp24NetTHB(o);
  }

  return referred.map(r => ({
    userId: r._id,
    username: r.username,
    orders: map.get(String(r._id))?.orders || 0,
    spentTHB: round2(map.get(String(r._id))?.spent || 0),
  }));
}
