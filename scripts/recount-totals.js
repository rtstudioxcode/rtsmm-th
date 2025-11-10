import mongoose from 'mongoose';
import path from 'node:path';
import process from 'node:process';

// ====== ปรับให้ตรงโปรเจกต์คุณ ======
const MONGODB_URI = 'mongodb://mongo:UExusYQYbMpqTLSRXPKAMfHyuVaRoVnK@ballast.proxy.rlwy.net:33636/rtsmm-th?replicaSet=rs0&authSource=admin&retryWrites=true&w=majority';

// ถ้าคุณมีไฟล์ model อยู่ใน src/models ให้ import ตรง ๆ:
import { User } from '../src/models/User.js';
import { Order } from '../src/models/Order.js';
import { Otp24Order } from '../src/models/Otp24Order.js';

// (ถ้ามี config/init DB ของโปรเจ็กต์ ให้ require เข้ามาก่อนเชื่อม)
const args = Object.fromEntries(
  process.argv.slice(2).map(s => {
    const [k, v = true] = s.replace(/^--/, '').split('=');
    return [k, v === 'false' ? false : v === 'true' ? true : v];
  })
);

const DRY   = !args.apply; // default dry-run
const ONE   = args.user || null; // ObjectId หรือ username
const BATCH = Number(args.batch || 200);

const nz     = v => (Number.isFinite(+v) ? +v : 0);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

function matchesUser(userId, user) {
  // คืน query $or ที่รองรับได้ทั้ง ObjectId/string เก่า ๆ
  const s = String(userId || user || '');
  const oid = mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
  return {
    $or: [
      ...(oid ? [{ user: oid }, { userId: oid }, { _id: oid }] : []),
      { user: s },
      { userId: s }
    ]
  };
}

function calcSmmNet(order) {
  const st = String(order.status || '').toLowerCase();

  // คำนวณ baseCost จากข้อมูลที่มี
  const nz = v => (Number.isFinite(+v) ? +v : 0);
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

  const qty  = nz(order.quantity);
  const rate = nz(order.rateAtOrder) || nz(order.rate);
  // ถ้ามี cost/estCost/charged ใช้ก่อน ไม่งั้นตีความจาก rate*qty/1000
  const baseCost =
    nz(order.cost) || nz(order.estCost) || nz(order.charged) ||
    (qty ? (rate * qty) / 1000 : 0);

  // completed → ฐาน - refund
  if (st === 'completed') {
    let refund = nz(order.refundAmount);
    if (!refund && Array.isArray(order.partialRefunds)) {
      refund = order.partialRefunds.reduce((s, r) => s + nz(r?.amount), 0);
    }
    return Math.max(0, round2(baseCost - refund));
  }

  // partial → คิดตามสัดส่วนที่ส่งสำเร็จ
  if (st === 'partial') {
    let delivered = 0;

    if (qty > 0) {
      // 1) มี remains บนเอกสารหลักก่อน
      const remains = nz(order.remains);
      if (remains > 0) {
        delivered = Math.max(0, Math.min(qty, qty - remains));
      } else {
        // 2) ลอง currentCount - startCount
        const d1 = nz(order.currentCount) - nz(order.startCount);
        if (d1 > 0) {
          delivered = Math.min(qty, d1);
        } else {
          // 3) เผื่อ providerResponse.lastStatus.remains
          const r2 = nz(order?.providerResponse?.lastStatus?.remains);
          if (r2 > 0) {
            delivered = Math.max(0, Math.min(qty, qty - r2));
          }
        }
      }
    }

    const ratio = (qty > 0) ? Math.max(0, Math.min(1, delivered / qty)) : 0;
    return round2(baseCost * ratio); // partial ไม่ต้องหัก refund เพิ่ม
  }

  // สถานะอื่น ๆ ไม่นับ
  return 0;
}

function calcOtpNet(doc) {
  // นับเฉพาะ success และใช้ salePrice เป็นหลัก (หัก refundAmount)
  const st = String(doc.status || '').toLowerCase();
  if (st !== 'success') return 0;

  const gross = nz(doc.salePrice);
  const refund = nz(doc.refundAmount);
  return Math.max(0, round2(gross - refund));
}

async function recountForUser(u) {
  const uid = u._id;
  // โหลดเฉพาะฟิลด์ที่จำเป็น เพื่อลด memory
  const [smmList, otpList] = await Promise.all([
    Order.find(matchesUser(uid, u._id), {
      status: 1,
      quantity: 1,
      rate: 1,
      rateAtOrder: 1,
      cost: 1,
      estCost: 1,
      charged: 1,
      refundAmount: 1,
      partialRefunds: 1,

      // 👇 เพิ่มฟิลด์สำหรับคำนวณ partial
      remains: 1,
      startCount: 1,
      currentCount: 1,
      'providerResponse.lastStatus.remains': 1
    }).lean(),

    Otp24Order.find(matchesUser(uid, u._id), {
      status: 1,
      salePrice: 1,
      refundAmount: 1
    }).lean()
  ]);

  // รวมสุทธิ
  const smmNet = round2((smmList || []).reduce((s, o) => s + calcSmmNet(o), 0));
  const otpNet = round2((otpList || []).reduce((s, o) => s + calcOtpNet(o), 0));
  const totalRaw = round2(smmNet + otpNet);

  // จำนวนออเดอร์/ที่นับ (ตามกติกาใหม่)
  const totalOrders      = (smmList?.length || 0) + (otpList?.length || 0);
  const totalOrdersPaid =
    (smmList || []).filter(o => {
      const s = String(o.status || '').toLowerCase();
      return s === 'completed' || s === 'partial';
    }).length +
    (otpList || []).filter(o => String(o.status || '').toLowerCase() === 'success').length;

  const redeemedSpent = nz(u.redeemedSpent); // รักษายอดแลกเดิม
  const totalSpent    = Math.max(0, round2(totalRaw - redeemedSpent));

  return {
    userId: uid,
    username: u.username,
    smmNet, otpNet, totalRaw, redeemedSpent, totalSpent,
    totalOrders, totalOrdersPaid
  };
}

async function main() {
  console.log(`[recount] connect ${MONGODB_URI}`);
  await mongoose.connect(MONGODB_URI, { maxPoolSize: 5 });

  let q = {};
  if (ONE) {
    // รับได้ทั้ง ObjectId, username, หรือ _id string
    if (mongoose.Types.ObjectId.isValid(String(ONE))) {
      q = { _id: new mongoose.Types.ObjectId(String(ONE)) };
    } else {
      q = { username: String(ONE) };
    }
  }

  const totalUsers = await User.countDocuments(q);
  console.log(`[recount] users = ${totalUsers}${DRY ? ' (dry-run)' : ''}`);

  const cursor = User.find(q, {
    username: 1, redeemedSpent: 1
  }).cursor({ batchSize: BATCH });

  let i = 0, changed = 0;
  for await (const u of cursor) {
    i++;
    const snap = await recountForUser(u);

    const setDoc = {
      totalOrders: snap.totalOrders,
      totalOrdersPaid: snap.totalOrdersPaid,
      totalSpentRaw: snap.totalRaw,
      totalSpent: snap.totalSpent
    };

    if (DRY) {
      console.log(`[dry] ${snap.username || snap.userId}: SMM=฿${snap.smmNet.toLocaleString()} OTP=฿${snap.otpNet.toLocaleString()} RAW=฿${snap.totalRaw.toLocaleString()} → totalSpent=฿${snap.totalSpent.toLocaleString()}`);
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
