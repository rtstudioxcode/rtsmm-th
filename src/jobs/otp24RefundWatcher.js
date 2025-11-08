// src/jobs/otp24RefundWatcher.js
import { Otp24Order } from '../models/Otp24Order.js';
import { User } from '../models/User.js';

export function startOtp24RefundWatcher() {
  const TICK_MS = 30_000; // ทุก 30 วิ
  setInterval(async () => {
    const now = new Date();
    const list = await Otp24Order.find({
      status: 'processing',
      expiresAt: { $lte: now }
    }).limit(200);

    for (const ord of list) {
      try {
        await User.updateOne({ _id: ord.user }, { $inc: { balance: ord.salePrice || 0 } });
        ord.status = 'refund';
        ord.message = 'ไม่ได้รับ OTP ใน 10 นาที ระบบคืนเครดิตอัตโนมัติ';
        ord.finishedAt = new Date();
        await ord.save();
      } catch {}
    }
  }, TICK_MS);
}
