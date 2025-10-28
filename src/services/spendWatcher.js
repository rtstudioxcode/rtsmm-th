// src/services/spendWatcher.js
import mongoose from 'mongoose';

const POKE_FIELDS = new Set([
  'status','cost','estCost','charged','refundAmount',
  'quantity','rateAtOrder','rate','partialRefunds'
]);

const userQueue = new Map();
function scheduleUser(userId, fn) {
  const key = String(userId);
  if (userQueue.has(key)) clearTimeout(userQueue.get(key));
  const t = setTimeout(fn, 2500);
  userQueue.set(key, t);
}

// NEW: ตัวช่วย fallback แบบ polling
async function startPollingFallback(mongooseConn, intervalMs = 5000) {
  console.warn('[spendWatcher] using polling fallback (no replica set).');
  const Order = mongooseConn.model('Order');

  let last = new Date(Date.now() - 60 * 1000); // เริ่มดูย้อนหลัง 1 นาที
  const timer = setInterval(async () => {
    try {
      // ดึงออเดอร์ที่พึ่งถูกสร้าง/อัปเดตหลังเวลา last
      const changed = await Order.find(
        { updatedAt: { $gt: last } },
        { _id: 1, userId: 1, user: 1, updatedAt: 1 }
      ).lean();

      if (changed.length) {
        last = changed.reduce((m, d) => (d.updatedAt > m ? d.updatedAt : m), last);

        for (const doc of changed) {
          const uid = doc.userId || doc.user;
          if (!uid) continue;

          // 1) reconcile ต่อใบ
          (async () => {
            try {
              const { reconcileOrderSpend } = await import('./spend.js');
              await reconcileOrderSpend(doc._id);
            } catch (e) {
              console.error('[spendWatcher/poll] reconcileOrderSpend failed:', e?.message || e);
            }
          })();

          // 2) debounce ต่อผู้ใช้
          scheduleUser(uid, async () => {
            try {
              const { recalcUserTotals } = await import('./spend.js');
              await recalcUserTotals(uid, { force: true, reason: 'polling' });
            } catch (e) {
              console.error('[spendWatcher/poll] recalcUserTotals failed:', e?.message || e);
            }
          });
        }
      }
    } catch (e) {
      console.error('[spendWatcher/poll] error:', e?.message || e);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

export function startSpendAutoRecalc(mongooseConn = mongoose.connection) {
  const coll = mongooseConn.collection('orders');

  // ถ้าไม่มี .watch ให้ fallback ทันที
  if (!coll?.watch) {
    console.warn('[spendWatcher] change streams unsupported (no watch). Using polling.');
    return startPollingFallback(mongooseConn);
  }

  // พยายามเปิด change stream ถ้า fail → fallback
  try {
    const pipeline = [{ $match: { operationType: { $in: ['insert','update','replace'] } } }];
    const cs = coll.watch(pipeline, { fullDocument: 'updateLookup' });
    console.log('[spendWatcher] watching orders…');

    cs.on('change', async (chg) => {
      try {
        const doc = chg.fullDocument || {};
        const uid =
          doc.userId || doc.user ||
          chg.updateDescription?.updatedFields?.userId ||
          chg.updateDescription?.updatedFields?.user;
        if (!uid) return;

        const orderId = doc?._id;

        if (chg.operationType === 'update') {
          const updated = Object.keys(chg.updateDescription?.updatedFields || {});
          const touched = updated.some(k => POKE_FIELDS.has(k));
          if (!touched) return;
        }

        (async () => {
          try {
            const { reconcileOrderSpend } = await import('./spend.js');
            await reconcileOrderSpend(orderId);
          } catch (e) {
            console.error('[spendWatcher] reconcileOrderSpend failed:', e?.message || e);
          }
        })();

        scheduleUser(uid, async () => {
          try {
            const { recalcUserTotals } = await import('./spend.js');
            await recalcUserTotals(uid, { force: true, reason: 'change_stream' });
          } catch (e) {
            console.error('[spendWatcher] recalcUserTotals failed:', e?.message || e);
          }
        });
      } catch (e) {
        console.error('[spendWatcher] change handler error:', e?.message || e);
      }
    });

    cs.on('error', async (e) => {
      console.error('[spendWatcher] stream error:', e?.message || e);
      // ปิด stream แล้วสลับเป็น polling
      try { cs.close(); } catch {}
      startPollingFallback(mongooseConn);
    });

    // ฟังก์ชัน stop
    return () => {
      try { cs.close(); } catch {}
    };

  } catch (e) {
    // error ตอนเปิด watch → ใช้ polling เลย
    console.error('[spendWatcher] watch init failed:', e?.message || e);
    return startPollingFallback(mongooseConn);
  }
}
