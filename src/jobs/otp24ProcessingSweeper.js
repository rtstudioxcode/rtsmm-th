// src/services/otp24ProcessingSweeper.js
import { Otp24Order } from '../models/Otp24Order.js';
import { User } from '../models/User.js';
import { getOtpStatus } from '../lib/otp24Adapter.js';

function round2(n){ return Math.round((Number(n)||0)*100)/100; }

export function startOtp24ProcessingSweeper () {
  const INTERVAL_MS = 2500;
  let running = false;

  // คืนเครดิตแบบ one-shot ด้วยตัวล็อก refundApplied
  async function refundOnce(row, nextStatus, msg){
    const sale = round2(Number(row.salePrice || 0));

    const res = await Otp24Order.updateOne(
      { _id: row._id, refundApplied: { $ne: true } },
      {
        $set: {
          status:        nextStatus, // ปกติ = 'refunded'
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
      // TODO: ถ้ามีตาราง log กระเป๋า ให้บันทึกตรงนี้ด้วย
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

      // ดึงเฉพาะงานที่ยังไม่ถูก refund (หรือยัง active บางสถานะ)
      const list = await Otp24Order.find({
        status: { $in: ['processing', 'timeout', 'failed', 'fail'] }
      })
        .select('_id orderId message expiresAt user salePrice status refundApplied')
        .limit(200)
        .lean();

      for (const row of list) {
        const status = String(row.status || '').toLowerCase();
        const alreadyRefunded = row.refundApplied === true;

        // 1) หมดเวลาแล้ว และยังไม่ refund → คืนเครดิต + mark refunded
        if (row.expiresAt && new Date(row.expiresAt).getTime() <= now && !alreadyRefunded) {
          await refundOnce(row, 'refunded', row.message || 'คืนเครดิต (หมดเวลา)');
          continue;
        }

        // 2) สถานะใน DB เป็น timeout/failed/fail แล้ว แต่ยังไม่ refund → คืนเครดิต + mark refunded
        if (!alreadyRefunded && (status === 'timeout' || status === 'failed' || status === 'fail')) {
          const reason =
            status === 'timeout'
              ? 'คืนเครดิต (timeout)'
              : 'คืนเครดิต (failed)';
          await refundOnce(row, 'refunded', row.message || reason);
          continue;
        }

        // 3) เฉพาะ processing เท่านั้นที่ไปถาม provider
        if (status !== 'processing') continue;

        const r = await getOtpStatus(row.orderId).catch(() => null);
        if (!r?.ok) continue;

        const st = String(r.status || '').toLowerCase();

        // 3.1 success → อัปเดตเฉย ๆ (ไม่คืนเครดิต)
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

        // 3.2 provider ส่ง refunded → คืนเครดิต one-shot และ mark refunded
        if (st.includes('refunded')) {
          await refundOnce(row, 'refunded', r.msg || 'คืนเครดิต');
          continue;
        }

        // 3.3 provider ส่ง timeout → เราก็ treat เป็น refunded เช่นกัน
        if (st.includes('timeout')) {
          await refundOnce(row, 'refunded', r.msg || 'คืนเครดิต (timeout)');
          continue;
        }

        // 3.4 provider ส่ง fail/failed → treat เป็น refunded เช่นกัน
        if (st.includes('failed') || st.includes('fail')) {
          await refundOnce(row, 'refunded', r.msg || 'คืนเครดิต (failed)');
          continue;
        }

        // 3.5 ยังรอ → อัปเดตข้อความเฉย ๆ
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
