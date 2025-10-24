// src/services/spend.js
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Order } from '../models/Order.js';

const LEVELS = [
  { name:'เลเวล 1',  need:0       },
  { name:'เลเวล 2',  need:5000    },
  { name:'เลเวล 3',  need:10000   },
  { name:'เลเวล 4',  need:30000   },
  { name:'เลเวล 5',  need:50000   },
  { name:'Retail',   need:80000   },
  { name:'Wholesale',need:175000  },
  { name:'Reseller', need:700000  },
  { name:'VIP',      need:1000000 },
  { name:'Legendary',need:5000000 },
];

export function computeLevel(total = 0) {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (total >= LEVELS[i].need) idx = i; else break;
  }
  return String(Math.max(1, idx + 1));
}

/** สร้างเงื่อนไขค้นหาให้ครอบคลุม user/userId ทั้ง ObjectId และ string */
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

/**
 * รีคำนวณยอดรวมจาก DB:
 * - totalOrders: จำนวนออเดอร์ทั้งหมดของผู้ใช้ (ค่าเริ่มต้น “ไม่รวม canceled”)
 * - totalSpent : (cost || estCost) - refundAmount (ต่อออเดอร์) แล้วรวม (ไม่รวม canceled)
 *
 * @param {string|ObjectId} userId
 * @param {{ includeCanceled?: boolean }} opts
 */
export async function recalcUserTotals(userId, opts = {}) {
  const includeCanceled = !!opts.includeCanceled;
  const match = {
    ...buildUserMatch(userId),
    ...(includeCanceled ? {} : { status: { $ne: 'canceled' } }),
  };

  const rows = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalSpent: {
          $sum: {
            $subtract: [
              { $ifNull: ['$cost', { $ifNull: ['$estCost', 0] }] },
              { $ifNull: ['$refundAmount', 0] },
            ],
          },
        },
      },
    },
  ]);

  const agg = rows[0] || { totalOrders: 0, totalSpent: 0 };
  const totalSpentRounded = Math.round((agg.totalSpent || 0) * 100) / 100;
  const level = computeLevel(totalSpentRounded);

  await User.updateOne(
    { _id: userId },
    {
      $set: {
        totalOrders: agg.totalOrders,
        totalSpent: totalSpentRounded,
        level,
      },
    }
  );

  return { totalOrders: agg.totalOrders, totalSpent: totalSpentRounded, level };
}

/* รักษาความเข้ากันได้กับโค้ดเดิมที่เรียกชื่อฟังก์ชันนี้ */
export async function recalcUserTotalSpent(userId, opts = {}) {
  return recalcUserTotals(userId, opts);
}

export { LEVELS };
