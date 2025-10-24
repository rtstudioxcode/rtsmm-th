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

export async function recalcUserTotalSpent(userId) {
  const uid = (userId instanceof mongoose.Types.ObjectId)
    ? userId
    : new mongoose.Types.ObjectId(String(userId));

  // รวมยอดทุกออเดอร์ของผู้ใช้ ยกเว้นที่ถูกยกเลิก
  const rows = await Order.aggregate([
    { $match: {
        $and: [
          { $or: [{ userId: uid }, { user: uid }] },
          { status: { $ne: 'canceled' } }
        ]
      }
    },
    { $group: {
        _id: null,
        total: { $sum: { $ifNull: ['$cost', '$estCost'] } }
      }
    }
  ]);

  const total = Math.round((rows?.[0]?.total || 0) * 100) / 100;
  const level = computeLevel(total);

  await User.updateOne({ _id: uid }, { $set: { totalSpent: total, level } });
  return { totalSpent: total, level };
}

export { LEVELS };
