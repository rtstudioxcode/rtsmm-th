// src/services/spend.js
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';

// นับ “ยอดจ่ายจริง” เฉพาะสถานะเหล่านี้ (แก้ได้ตามนโยบาย)
export const PAID_STATUSES = [
  'processing', 'inprogress', // ถูกตัดยอดตั้งแต่สร้าง
  'partial',
  'completed', 'success', 'done',
  'refilled'
];

/** ตารางเลเวลตามยอดใช้จ่ายสะสม (THB) */
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

/** ป้องกัน spam เรียกถี่ (debounce ต่อผู้ใช้) */
const lastRunAt = new Map();
const COOLDOWN_MS = 5_000;

/** ปัดทศนิยม 2 ตำแหน่งแบบคงที่สำหรับ "ยอดเงิน" */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** เลือกเลเวลจากยอดสะสม (คืนค่าเป็น "เลขเลเวล" เพื่อเข้ากันได้กับโค้ดเดิม) */
export function computeLevel(total = 0) {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (total >= LEVELS[i].need) idx = i; else break;
  }
  return String(Math.max(1, idx + 1));
}

/** (ใหม่) คืนรายละเอียดเลเวลสำหรับใช้งานเพิ่มในอนาคต */
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

/** ครอบคลุมฟิลด์ user/userId ทั้ง ObjectId และ string */
function buildUserMatch(userId) {
  const idStr = String(userId || '');
  const oid = mongoose.Types.ObjectId.isValid(idStr)
    ? new mongoose.Types.ObjectId(idStr)
    : null;

  return {
    $or: [
      ...(oid ? [{ user: oid }, { userId: oid }] : []),
      { user: idStr },
      { userId: idStr },
    ],
  };
}

/** คำนวณ "ยอดที่เรียกเก็บจริง" ของออเดอร์ (THB)
 * ลำดับ: cost → estCost → charged → (ratePer1k * quantity / 1000) → 0
 * แล้วหัก refundAmount (ไม่ให้ติดลบ) จากนั้นปัด 2 ตำแหน่ง
 */
export function calcOrderPaidAmount(order) {
  if (!order) return 0;

  const refund = Number(order.refundAmount) || 0;

  // 1) ฟิลด์ยอดที่บันทึกไว้
  if (Number.isFinite(order.cost)) {
    return round2(Math.max(0, Number(order.cost) - refund));
  }
  if (Number.isFinite(order.estCost)) {
    return round2(Math.max(0, Number(order.estCost) - refund));
  }
  if (Number.isFinite(order.charged)) {
    return round2(Math.max(0, Number(order.charged) - refund));
  }

  // 2) ประเมินจากเรต/จำนวน (fallback)
  const qty = Number(order.quantity) || 0;
  const ratePer1k =
    Number(order.rate) ??
    Number(order?.rateAtOrder) ??            // เผื่อมีเก็บเรตตอนสั่ง
    Number(order?.service?.rateTHB) ??
    Number(order?.service?.baseRateTHB) ??
    Number(order?.service?.rate) ?? 0;

  const est = (qty * ratePer1k) / 1000;
  return round2(Math.max(0, est - refund));
}

/**
 * รีคำนวณยอดรวมจาก DB (อัตโนมัติ, ไม่ต้องกดปุ่ม):
 * - totalOrders      : จำนวนออเดอร์ของผู้ใช้ (ไม่รวม canceled โดยค่าเริ่มต้น)
 * - totalOrdersPaid  : จำนวนออเดอร์ที่ "นับยอดจ่ายจริง"
 * - totalSpent       : ผลรวมยอดจ่ายจริง (หัก refund แล้ว) — ปัดรายออเดอร์ก่อน sum
 * - level            : เลเวล (String) เข้ากันได้กับโค้ดเดิม
 *
 * opts:
 *  - includeCanceled?: รวมออเดอร์ canceled ใน totalOrders ด้วยหรือไม่ (default: false)
 *  - statuses?: override รายชื่อสถานะที่นับยอดจริง (default: PAID_STATUSES)
 *  - force?: true เพื่อข้าม cooldown
 */
export async function recalcUserTotals(userId, opts = {}) {
  const {
    includeCanceled = false,
    statuses = PAID_STATUSES,
    force = false,
  } = opts;

  if (!userId) return { ok: false, error: 'userId is required' };

  // debounce
  const now = Date.now();
  const last = lastRunAt.get(String(userId)) || 0;
  if (!force && now - last < COOLDOWN_MS) {
    return { ok: true, skipped: true, reason: 'cooldown' };
  }
  lastRunAt.set(String(userId), now);

  const userMatch = buildUserMatch(userId);

  // 1) นับจำนวนออเดอร์ทั้งหมด (ไม่รวม canceled โดยปริยาย)
  const baseMatch = {
    ...userMatch,
    ...(includeCanceled ? {} : { status: { $ne: 'canceled' } }),
  };
  const totalOrders = await Order.countDocuments(baseMatch);

  // 2) ดึงออเดอร์ที่ "นับยอดจ่ายจริง" (ดึงฟิลด์ที่จำเป็น รวม estCost)
  const paidMatch = { ...userMatch, status: { $in: statuses } };
  const paidOrders = await Order.find(paidMatch, {
    quantity: 1,
    rate: 1,
    rateAtOrder: 1,
    cost: 1,
    estCost: 1,
    charged: 1,
    refundAmount: 1,
    createdAt: 1,
    updatedAt: 1,
    service: 1,
    status: 1,
  }).lean();

  let totalSpent = 0;
  let lastPaidAt = null;

  for (const o of paidOrders) {
    totalSpent += calcOrderPaidAmount(o); // ปัด 2 ตำแหน่งรายออเดอร์แล้ว
    const when = o.updatedAt || o.createdAt;
    if (!lastPaidAt || (when && new Date(when) > new Date(lastPaidAt))) {
      lastPaidAt = when;
    }
  }

  totalSpent = round2(totalSpent);
  const totalOrdersPaid = paidOrders.length;

  // 3) คำนวณเลเวล
  const level = computeLevel(totalSpent);
  const lvMeta = decideLevel(totalSpent);

  // 4) อัปเดตผู้ใช้
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        totalOrders,
        totalOrdersPaid,
        totalSpent,
        level,                // เข้ากันได้กับโค้ดเดิม (string)
        levelIndex: lvMeta.index,
        levelName: lvMeta.name,
        levelNeed: lvMeta.need,
        nextLevelName: lvMeta.nextName,
        toNextLevel: lvMeta.toNext,
        lastSpentAt: lastPaidAt || new Date(),
      },
    }
  );

  return {
    ok: true,
    totalOrders,
    totalOrdersPaid,
    totalSpent,
    level,
    levelInfo: lvMeta,
  };
}

/** alias เพื่อคงความเข้ากันได้กับโค้ดเดิม */
export async function recalcUserTotalSpent(userId, opts = {}) {
  return recalcUserTotals(userId, opts);
}
