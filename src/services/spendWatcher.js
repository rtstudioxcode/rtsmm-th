// src/services/spendWatcher.js
import mongoose from 'mongoose';

const POKE_FIELDS = new Set([
  'status', 'cost', 'estCost', 'charged', 'refundAmount',
  'quantity', 'rateAtOrder', 'rate', 'partialRefunds'
  // หมายเหตุ: ไม่ใส่ 'spentAccounted' เพราะเป็นฟิลด์ snapshot จาก reconcile เอง
]);

const userQueue = new Map(); // userId -> timeoutId

function scheduleUser(userId, fn) {
  const key = String(userId);
  if (userQueue.has(key)) clearTimeout(userQueue.get(key));
  const t = setTimeout(fn, 2500); // debounce 2.5s ต่อผู้ใช้
  userQueue.set(key, t);
}

export function startSpendAutoRecalc(mongooseConn = mongoose.connection) {
  const coll = mongooseConn.collection('orders');
  if (!coll?.watch) {
    console.warn('[spendWatcher] change streams unsupported (not a replica set?). Skipping.');
    return () => {};
  }

  const pipeline = [
    { $match: {
        operationType: { $in: ['insert', 'update', 'replace'] },
      }
    },
  ];

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

      // เฉพาะ update: ถ้าไม่ได้แตะฟิลด์ที่กระทบยอด → ข้าม
      if (chg.operationType === 'update') {
        const updated = Object.keys(chg.updateDescription?.updatedFields || {});
        const touched = updated.some(k => POKE_FIELDS.has(k));
        if (!touched) return;
      }

      // 1) Reconcile ต่อใบ (delta-based) — ทำทันที, ไม่บล็อกงานอื่น
      (async () => {
        try {
          const { reconcileOrderSpend } = await import('./spend.js');
          await reconcileOrderSpend(orderId);
        } catch (e) {
          console.error('[spendWatcher] reconcileOrderSpend failed:', e?.message || e);
        }
      })();

      // 2) Debounce ต่อผู้ใช้ → ค่อยสรุปเลเวล/แต้ม/ตัวเลขโชว์
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

  cs.on('error', (e) => {
    console.error('[spendWatcher] stream error:', e?.message || e);
  });

  return () => {
    try { cs.close(); } catch {}
  };
}
