// src/services/otp24ProcessingSweeper.js
import { Otp24Order } from '../models/Otp24Order.js';
import { User } from '../models/User.js';
import { getOtpStatus } from '../lib/otp24Adapter.js';

function round2(n){ return Math.round((Number(n)||0)*100)/100; }

export function startOtp24ProcessingSweeper () {
  const INTERVAL_MS = 5000;
  let running = false;

  // คืนเครดิตแบบ one-shot ด้วยตัวล็อก refundApplied
  async function refundOnce(row, nextStatus, msg){
    const sale = round2(Number(row.salePrice || 0));
    // ล็อกกันซ้ำ + เซ็ตสถานะ + บันทึกจำนวนที่คืน
    const res = await Otp24Order.updateOne(
      { _id: row._id, refundApplied: { $ne: true } },
      {
        $set: {
          status:        nextStatus,                    // 'refunded' | 'timeout' | 'failed'
          message:       msg || 'คืนเครดิต',
          refundApplied: true,
          refundAmount:  sale,
          refundedAt:    new Date()
        }
      }
    );

    if (res.modifiedCount === 1 && sale > 0){
      // เพิ่มเงินเข้ากระเป๋าผู้ใช้ครั้งเดียว
      await User.updateOne({ _id: row.user }, { $inc: { balance: sale } });
      // (ถ้ามีตาราง log กระเป๋า ให้บันทึกตรงนี้ด้วย)
    } else {
      // เคยคืนไปแล้ว → sync สถานะ/ข้อความให้ตรง
      await Otp24Order.updateOne(
        { _id: row._id },
        { $set: { status: nextStatus, message: msg || 'คืนเครดิต' } }
      );
    }
  }

  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();

      // ดึงเฉพาะงานที่ยัง active เพื่อลดโหลด/ลด race
      const list = await Otp24Order.find({ status: 'processing' })
        .select('_id orderId message expiresAt user salePrice')
        .limit(200)
        .lean();

      for (const row of list) {
        // 1) หมดเวลา (ถ้าโครงสร้างยังใช้อยู่) → คืนเครดิต one-shot
        if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) {
          await refundOnce(row, 'คืนเครดิต', row.message || 'คืนเครดิต');
          continue;
        }

        // 2) เช็คผู้ให้บริการ
        const r = await getOtpStatus(row.orderId).catch(() => null);
        if (!r?.ok) continue;

        const st = String(r.status || '').toLowerCase();

        // 2.1 success → อัปเดตเฉย ๆ (ไม่คืนเครดิต)
        if (st.includes('success') && r.otp) {
          await Otp24Order.updateOne(
            { _id: row._id, status: 'processing' },
            {
              $set: {
                status:  'success',
                otp:     r.otp,
                message: r.msg || 'ได้รับ OTP แล้ว'
              }
            }
          );
          continue;
        }

        // 2.2 refunded → คืนเครดิต one-shot
        if (st.includes('refunded')) {
          await refundOnce(row, 'refunded', r.msg || 'คืนเครดิต');
          continue;
        }

        // 2.3 timeout (จาก provider) → คืนเครดิต one-shot (สถานะคงเป็น timeout)
        if (st.includes('timeout')) {
          await refundOnce(row, 'refunded', r.msg || 'คืนเครดิต');
          continue;
        }

        // 2.4 failed → คืนเครดิต one-shot (สถานะคงเป็น failed)
        if (st.includes('failed')) {
          await refundOnce(row, 'refunded', r.msg || 'คืนเครดิต');
          continue;
        }

        // 2.5 ยังรอ → อัปเดตข้อความเฉย ๆ
        const msg = r.msg || 'กำลังรอ OTP…';
        await Otp24Order.updateOne(
          { _id: row._id, status: 'processing', message: { $ne: msg } },
          { $set: { message: msg } }
        );
      }
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
}
