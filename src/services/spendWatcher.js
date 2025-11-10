// src/services/spendWatcher.js
import mongoose from 'mongoose';

const POKE_FIELDS = new Set([
  'status','cost','estCost','charged','refundAmount',
  'quantity','rateAtOrder','rate','partialRefunds'
]);

const OTP24_POKE_FIELDS = new Set([
  'status','cost','price','priceTHB','amountTHB','refundAmount','salePrice'
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
  const Otp24Order = mongooseConn.model('Otp24Order');

  let last = new Date(Date.now() - 60 * 1000);

  const timer = setInterval(async () => {
    try {
      const [changedOrd, changedOtp] = await Promise.all([
        Order.find({ updatedAt: { $gt: last } }, { _id:1, userId:1, user:1, updatedAt:1 }).lean(),
        Otp24Order.find({ updatedAt: { $gt: last } }, { _id:1, userId:1, user:1, updatedAt:1 }).lean(),
      ]);

      const all = [...changedOrd, ...changedOtp];
      if (all.length) {
        last = all.reduce((m, d) => (d.updatedAt > m ? d.updatedAt : m), last);

        for (const doc of all) {
          const uid = doc.userId || doc.user;
          if (!uid) continue;

          // reconcile ต่อใบ (เด้งถูกประเภท)
          (async () => {
            try {
              if (doc._id && changedOtp.find(x => String(x._id) === String(doc._id))) {
                const { reconcileOtp24OrderSpend } = await import('./spend.js');
                await reconcileOtp24OrderSpend(doc._id);
              } else {
                const { reconcileOrderSpend } = await import('./spend.js');
                await reconcileOrderSpend(doc._id);
              }
            } catch (e) {
              console.error('[spendWatcher/poll] reconcile failed:', e?.message || e);
            }
          })();

          // debounce ต่อ user
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
  const collOrders = mongooseConn.collection('orders');
  const collOtp24  = mongooseConn.collection('otp24orders');

  if (!collOrders?.watch || !collOtp24?.watch) {
    console.warn('[spendWatcher] change streams unsupported (no watch). Using polling.');
    return startPollingFallback(mongooseConn);
  }

  const startWatch = (coll, kind) => {
    const pipeline = [{ $match: { operationType: { $in: ['insert','update','replace'] } } }];
    const cs = coll.watch(pipeline, { fullDocument: 'updateLookup' });
    console.log(`[spendWatcher] watching ${kind}…`);

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
          const touched = kind === 'orders'
            ? updated.some(k => POKE_FIELDS.has(k))
            : updated.some(k => OTP24_POKE_FIELDS.has(k));
          if (!touched) return;
        }

        (async () => {
          try {
            if (kind === 'orders') {
              const { reconcileOrderSpend } = await import('./spend.js');
              await reconcileOrderSpend(orderId);
            } else {
              const { reconcileOtp24OrderSpend } = await import('./spend.js');
              await reconcileOtp24OrderSpend(orderId);
            }
          } catch (e) {
            console.error(`[spendWatcher] reconcile ${kind} failed:`, e?.message || e);
          }
        })();

        scheduleUser(uid, async () => {
          try {
            const { recalcUserTotals } = await import('./spend.js');
            await recalcUserTotals(uid, { force: true, reason: `change_stream_${kind}` });
          } catch (e) {
            console.error('[spendWatcher] recalcUserTotals failed:', e?.message || e);
          }
        });
      } catch (e) {
        console.error('[spendWatcher] change handler error:', e?.message || e);
      }
    });

    cs.on('error', async (e) => {
      console.error(`[spendWatcher] stream error (${kind}):`, e?.message || e);
      try { cs.close(); } catch {}
      startPollingFallback(mongooseConn);
    });

    return cs;
  };

  try {
    const cs1 = startWatch(collOrders, 'orders');
    const cs2 = startWatch(collOtp24, 'otp24orders');
    return () => { try{ cs1?.close(); }catch{} try{ cs2?.close(); }catch{} };
  } catch (e) {
    console.error('[spendWatcher] watch init failed:', e?.message || e);
    return startPollingFallback(mongooseConn);
  }
}