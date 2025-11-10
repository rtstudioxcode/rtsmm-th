import mongoose from 'mongoose';
import process from 'node:process';

// ====== ปรับให้ตรงโปรเจกต์คุณ ======
const MONGODB_URI = 'mongodb://mongo:UExusYQYbMpqTLSRXPKAMfHyuVaRoVnK@ballast.proxy.rlwy.net:33636/rtsmm-th?replicaSet=rs0&authSource=admin&retryWrites=true&w=majority';

// ถ้ามีไฟล์ model อยู่ใน src/models ให้ import ตรง ๆ:
import { User } from '../src/models/User.js';
import { Order } from '../src/models/Order.js';
import { Otp24Order } from '../src/models/Otp24Order.js';

// ─────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(s => {
    const [k, v = true] = s.replace(/^--/, '').split('=');
    return [k, v === 'false' ? false : v === 'true' ? true : v];
  })
);

const DRY   = !args.apply;          // default dry-run
const ONE   = args.user || null;    // ObjectId หรือ username
const BATCH = Number(args.batch || 200);
const SINCE = args.since ? new Date(String(args.since)) : null; // override เส้นตัดด้วย CLI

// ─────────────────────────────────────────────────────────────
// utils
// ─────────────────────────────────────────────────────────────
const nz     = v => (Number.isFinite(+v) ? +v : 0);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

function matchesUser(userIdOrDoc) {
  const s = String(userIdOrDoc || '');
  const oid = mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
  return oid ? { $or: [{ user: oid }, { userId: oid }, { _id: oid }] } : { $or: [{ user: s }, { userId: s }] };
}

function dateFilter(resetAt) {
  return resetAt ? { createdAt: { $gte: resetAt } } : {};
}

function calcSmmNet(order) {
  const st = String(order.status || '').toLowerCase();

  const qty  = nz(order.quantity);
  const rate = nz(order.rateAtOrder) || nz(order.rate);
  const baseCost =
    nz(order.cost) || nz(order.estCost) || nz(order.charged) ||
    (qty ? (rate * qty) / 1000 : 0);

  if (st === 'completed') {
    let refund = nz(order.refundAmount);
    if (!refund && Array.isArray(order.partialRefunds)) {
      refund = order.partialRefunds.reduce((s, r) => s + nz(r?.amount), 0);
    }
    return Math.max(0, round2(baseCost - refund));
  }

  if (st === 'partial') {
    let delivered = 0;

    if (qty > 0) {
      const remains = nz(order.remains);
      if (remains > 0) {
        delivered = Math.max(0, Math.min(qty, qty - remains));
      } else {
        const d1 = nz(order.currentCount) - nz(order.startCount);
        if (d1 > 0) delivered = Math.min(qty, d1);
        else {
          const r2 = nz(order?.providerResponse?.lastStatus?.remains);
          if (r2 > 0) delivered = Math.max(0, Math.min(qty, qty - r2));
        }
      }
    }

    const ratio = (qty > 0) ? Math.max(0, Math.min(1, delivered / qty)) : 0;
    return round2(baseCost * ratio);
  }

  return 0;
}

function calcOtpNet(doc) {
  const st = String(doc.status || '').toLowerCase();
  if (st !== 'success') return 0;
  const gross = nz(doc.salePrice);
  const refund = nz(doc.refundAmount);
  return Math.max(0, round2(gross - refund));
}

/** fallback เดิม กรณีไม่มีเส้นตัด */
function computeRedeemedSpentFallback(u, totalRaw) {
  const r1 = nz(u.redeemedSpent);

  let r2 = 0;
  const pRedeemed = nz(u.pointsRedeemed);
  const pValue = nz(u.pointValueTHB);
  if (pRedeemed > 0 && pValue > 0) r2 = round2(pRedeemed * pValue);

  let r3 = 0;
  const dbTotalSpent = nz(u.totalSpent);
  if (dbTotalSpent > 0 && totalRaw > 0 && totalRaw >= dbTotalSpent) {
    r3 = round2(totalRaw - dbTotalSpent);
  }

  const eff = Math.min(totalRaw, Math.max(r1, r2, r3));
  return round2(Math.max(0, eff));
}

function resolveResetAt(u) {
  // รองรับหลายชื่อฟิลด์ที่อาจมีในโปรเจกต์คุณ
  // แนะนำให้บันทึกจริงชื่อเดียว เช่น pointsResetAt เวลาแลกแต้ม
  const cand = [
    u.pointsResetAt,
    u.lastRedeemedAt,
    u.redeemResetAt,
    u.lastPointsRedeemAt
  ].filter(Boolean);

  const chosen = cand.length ? new Date(cand[0]) : null;
  if (SINCE) return SINCE;      // CLI override มาก่อน
  return (chosen && !isNaN(chosen)) ? chosen : null;
}

async function recountForUser(u) {
  const uid = u._id;

  // หาเส้นตัด (resetAt) ก่อน
  const resetAt = resolveResetAt(u);

  // สร้าง filter ตาม user + resetAt
  const baseFilter = matchesUser(uid);
  const timeFilter = dateFilter(resetAt);
  const filter = Object.keys(timeFilter).length ? { ...baseFilter, ...timeFilter } : baseFilter;

  const [smmList, otpList] = await Promise.all([
    Order.find(filter, {
      status: 1,
      quantity: 1,
      rate: 1,
      rateAtOrder: 1,
      cost: 1,
      estCost: 1,
      charged: 1,
      refundAmount: 1,
      partialRefunds: 1,
      remains: 1,
      startCount: 1,
      currentCount: 1,
      createdAt: 1,
      'providerResponse.lastStatus.remains': 1
    }).lean(),

    Otp24Order.find(filter, {
      status: 1,
      salePrice: 1,
      refundAmount: 1,
      createdAt: 1
    }).lean()
  ]);

  const smmNet = round2((smmList || []).reduce((s, o) => s + calcSmmNet(o), 0));
  const otpNet = round2((otpList || []).reduce((s, o) => s + calcOtpNet(o), 0));
  const totalRaw = round2(smmNet + otpNet);

  const totalOrders      = (smmList?.length || 0) + (otpList?.length || 0);
  const totalOrdersPaid =
    (smmList || []).filter(o => ['completed','partial'].includes(String(o.status||'').toLowerCase())).length +
    (otpList || []).filter(o => String(o.status||'').toLowerCase() === 'success').length;

  // กติกาใหม่:
  // - ถ้ามี resetAt (รู้ว่ารอบใหม่เริ่มเมื่อไหร่) → ไม่ต้องหัก redeemed แล้ว เพราะเราไม่นับช่วงก่อน reset อยู่แล้ว
  // - ถ้าไม่มี resetAt → fallback เดิม (คำนวณ redeemed จากฟิลด์ต่างๆ)
  const redeemedSpentEff = resetAt ? 0 : computeRedeemedSpentFallback(u, totalRaw);
  const totalSpent       = Math.max(0, round2(totalRaw - redeemedSpentEff));

  return {
    userId: uid,
    username: u.username,
    resetAt: resetAt || null,
    smmNet, otpNet, totalRaw,
    redeemedSpentEff,
    totalSpent,
    totalOrders, totalOrdersPaid
  };
}

async function main() {
  console.log(`[recount] connect ${MONGODB_URI}`);
  await mongoose.connect(MONGODB_URI, { maxPoolSize: 5 });

  let q = {};
  if (ONE) {
    if (mongoose.Types.ObjectId.isValid(String(ONE))) q = { _id: new mongoose.Types.ObjectId(String(ONE)) };
    else q = { username: String(ONE) };
  }

  const totalUsers = await User.countDocuments(q);
  console.log(`[recount] users = ${totalUsers}${DRY ? ' (dry-run)' : ''}${SINCE ? ` since=${SINCE.toISOString()}` : ''}`);

  const cursor = User.find(q, {
    username: 1,
    redeemedSpent: 1,
    pointsRedeemed: 1,
    pointValueTHB: 1,
    totalSpent: 1,
    // ฟิลด์เส้นตัดที่อาจมีอยู่
    pointsResetAt: 1,
    lastRedeemedAt: 1,
    redeemResetAt: 1,
    lastPointsRedeemAt: 1
  }).cursor({ batchSize: BATCH });

  let i = 0, changed = 0;
  for await (const u of cursor) {
    i++;
    const snap = await recountForUser(u);

    const setDoc = {
      totalOrders: snap.totalOrders,
      totalOrdersPaid: snap.totalOrdersPaid,
      totalSpentRaw: snap.totalRaw, // ✅ นับใหม่เฉพาะหลัง reset
      totalSpent: snap.totalSpent,
      // ถ้ามี resetAt แปลว่าเราไม่ต้องอัปเดต redeemedSpent (ปล่อยให้ระบบแลกแต้มตั้งเอง)
      ...(snap.resetAt ? {} : { redeemedSpent: snap.redeemedSpentEff })
    };

    if (DRY) {
      console.log(
        `[dry] ${snap.username || snap.userId}: ` +
        (snap.resetAt ? `RESET@${snap.resetAt.toISOString()} ` : '') +
        `SMM=฿${snap.smmNet.toLocaleString()} OTP=฿${snap.otpNet.toLocaleString()} ` +
        `RAW=฿${snap.totalRaw.toLocaleString()} ` +
        (snap.resetAt ? '' : `REDEEMED=฿${snap.redeemedSpentEff.toLocaleString()} `) +
        `→ totalSpent=฿${snap.totalSpent.toLocaleString()}`
      );
      continue;
    }

    const r = await User.updateOne({ _id: snap.userId }, { $set: setDoc });
    if (r.modifiedCount) changed++;

    if (i % 50 === 0) console.log(`[recount] ${i}/${totalUsers} …`);
  }

  if (!DRY) console.log(`[recount] done. users updated = ${changed}/${totalUsers}`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
