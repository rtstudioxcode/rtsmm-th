// src/jobs/orderStatusJob.js
import os from 'os';
import pLimit from 'p-limit';
import { Order } from '../models/Order.js';
import { getOrderStatus } from '../lib/iplusviewAdapter.js';
import { connectMongoIfNeeded } from '../config.js';

const TICK_MS       = Number(process.env.ORDER_STATUS_TICK_MS || 60_000);
const CONCURRENCY   = Number(process.env.ORDER_STATUS_CONCURRENCY || 100);
const BATCH_LIMIT   = Number(process.env.ORDER_STATUS_BATCH_LIMIT || 1_000);

const VERBOSE = String(process.env.ORDER_STATUS_VERBOSE || '1') !== '0'; // เปิด log ไว้เป็นค่าเริ่มต้น

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────
function mapProviderStatus(s) {
  const x = String(s || '').toLowerCase();
  if (['completed', 'success', 'done', 'finished'].includes(x)) return 'completed';
  if (['partial', 'partially', 'refunded'].includes(x))         return 'partial';
  if (['canceled', 'cancelled', 'rejected', 'fail', 'failed'].includes(x)) return 'canceled';
  if (['pending', 'processing', 'inprogress'].includes(x))      return 'processing';
  return 'processing';
}

function resolveNextStatus(currentLocal, providerRawStatus) {
  const local  = String(currentLocal || '').toLowerCase();
  const mapped = mapProviderStatus(providerRawStatus);
  if (local === 'canceling') {
    if (mapped === 'canceled')  return 'canceled';
    if (mapped === 'completed') return 'completed';
    if (mapped === 'partial')   return 'partial';
    return 'canceling';
  }
  return mapped;
}

function pickLastStatus(res) {
  const ls = res?.lastStatus || res || {};
  const n = v => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    status:        ls.status ?? res?.status ?? null,
    rawStatus:     ls.rawStatus ?? null,
    charge:        n(ls.charge ?? res?.charge),
    currency:      ls.currency ?? res?.currency ?? null,
    remains:       n(ls.remains ?? res?.remains),
    start_count:   n(ls.start_count ?? res?.start_count),
    current_count: n(ls.current_count ?? res?.current_count),
    providerOrderId: res?.id || res?.order_id || res?.providerOrderId || null,
    checkedAt: new Date()
  };
}

function computeDonePct(oLike) {
  const qty = Number(oLike.quantity) || 0;
  if (qty > 0) {
    if (typeof oLike.remains === 'number') {
      const left = Math.max(0, oLike.remains);
      return Math.max(0, Math.min(100, (1 - (left / qty)) * 100));
    }
    if (typeof oLike.startCount === 'number' && typeof oLike.currentCount === 'number') {
      const gained = Math.max(0, oLike.currentCount - oLike.startCount);
      return Math.max(0, Math.min(100, (gained / qty) * 100));
    }
  }
  if (typeof oLike.progress === 'number') {
    return Math.max(0, Math.min(100, oLike.progress));
  }
  return 0;
}

function computeRefund(oDoc, providerRes) {
  const est = Number(oDoc.estCost ?? oDoc.cost ?? 0);
  if (!Number.isFinite(est) || est <= 0) return null;

  const status = mapProviderStatus(
    providerRes?.status || providerRes?.rawStatus || providerRes?.lastStatus?.status || providerRes?.lastStatus?.rawStatus
  );
  const chg = Number(providerRes?.charge ?? NaN);

  if (Number.isFinite(chg)) {
    const refund = Math.max(0, est - chg);
    if (status === 'canceled') {
      return { amount: Math.min(refund, est), type: refund >= est ? 'full' : (refund > 0 ? 'partial' : 'full') };
    }
    if (status === 'partial') {
      return refund > 0 ? { amount: Math.min(refund, est), type: 'partial' } : null;
    }
  }

  const qty = Number(oDoc.quantity) || 0;
  const rem = Number.isFinite(providerRes?.remains) ? Number(providerRes.remains) : null;

  if (qty > 0 && rem != null) {
    const done = Math.max(0, qty - Math.max(0, rem));
    const ratioDone = Math.max(0, Math.min(1, done / qty));
    const chargedEstimated = est * ratioDone;
    const refund = Math.max(0, est - chargedEstimated);

    if (status === 'canceled') return { amount: Math.min(refund, est), type: refund >= est ? 'full' : 'partial' };
    if (status === 'partial')  return refund > 0 ? { amount: Math.min(refund, est), type: 'partial' } : null;
  }

  if (status === 'canceled') return { amount: est, type: 'full' };
  return null;
}

// pretty logger
function fmtMoney(n) {
  if (!Number.isFinite(Number(n))) return '-';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function logOrderUpdate({ o, patch, prevStatus, providerStatus }) {
  if (!VERBOSE) return;

  const id    = String(o._id);
  const prov  = o.providerOrderId || (patch?.['providerResponse.lastStatus']?.providerOrderId) || '-';
  const from  = prevStatus || o.status || '-';
  const to    = (patch.status ?? from);
  const prog  = (patch.progress ?? o.progress);
  const rem   = (patch.remains ?? o.remains);
  const sc    = (patch.startCount ?? o.startCount);
  const cc    = (patch.currentCount ?? o.currentCount);
  const rfAmt = (patch.refundAmount ?? o.refundAmount);
  const rfTyp = (patch.refundType ?? o.refundType) || '';

  // เฉพาะเวลามีการยิง updateOne เท่านั้นที่เราจะ log (เรียกฟังก์ชันนี้หลัง updateOne สำเร็จ)
  console.log(
    `[orderStatusJob] update`,
    `order=${id}`,
    `prov=${prov}`,
    `status=${from}→${to} (prov:${String(providerStatus || '').toLowerCase() || '-'})`,
    `progress=${Number.isFinite(prog) ? prog.toFixed(2) + '%' : '-'}`,
    `remains=${Number.isFinite(rem) ? rem : '-'}`,
    `count=${Number.isFinite(sc) ? sc : '-'}→${Number.isFinite(cc) ? cc : '-'}`,
    (Number.isFinite(rfAmt) && rfAmt > 0) ? `refund=${fmtMoney(rfAmt)} (${rfTyp||'-'})` : ''
  );
}

// ─────────────────────────────────────────────────────────────
// core updater
// ─────────────────────────────────────────────────────────────
async function updateOneOrder(o) {
  if (!o?.providerOrderId) return;

  let res;
  try {
    res = await getOrderStatus(o.providerOrderId);
  } catch {
    return;
  }

  const provStatus =
    res?.status ||
    res?.rawStatus ||
    res?.lastStatus?.rawStatus ||
    res?.lastStatus?.status ||
    'processing';

  const nextStatus = resolveNextStatus(o.status, provStatus);

  const patch = {
    updatedAt: new Date(),
    'providerResponse.lastStatus': pickLastStatus(res),
    'providerResponse.lastCheckedAt': new Date()
  };

  const start = (res?.start_count ?? res?.lastStatus?.start_count);
  const curr  = (res?.current_count ?? res?.lastStatus?.current_count);
  const rem   = (res?.remains ?? res?.lastStatus?.remains);

  if (typeof start === 'number') patch.startCount   = start;
  if (typeof curr  === 'number') patch.currentCount = curr;
  if (typeof rem   === 'number') patch.remains      = rem;

  if (patch.progress == null) {
    const qty = Number(o.quantity) || 0;
    if (qty > 0 && typeof patch.startCount === 'number' && typeof patch.currentCount === 'number') {
      const gained = Math.max(0, patch.currentCount - patch.startCount);
      patch.progress = Math.max(0, Math.min(100, (gained / qty) * 100));
    }
  }

  const prevStatus = String(o.status || '').toLowerCase();
  if (nextStatus !== o.status) {
    patch.status = nextStatus;
  }

  if ((nextStatus === 'partial' || nextStatus === 'canceled') && !o.refundCommitted) {
    const rf = computeRefund(o, res);
    if (rf && rf.amount > 0) {
      const prevAmt = Number(o.refundAmount || 0);
      patch.refundAmount = Math.max(prevAmt, rf.amount);
      patch.refundType   = (patch.refundAmount >= (o.estCost ?? o.cost)) ? 'full' : (rf.type || 'partial');
    }
    if (nextStatus === 'canceled') {
      patch.canceledAt = new Date();
    }
  }

  // ยิงอัปเดตจริง
  const result = await Order.updateOne({ _id: o._id }, { $set: patch });

  // ถ้า DB แจ้งว่ามีการแก้ไข (nModified/modifiedCount) → log ทุกครั้ง
  // (mongoose v7 ใช้ { acknowledged, modifiedCount, matchedCount, upsertedId })
  if (result?.modifiedCount > 0 || result?.nModified > 0) {
    logOrderUpdate({ o, patch, prevStatus, providerStatus: provStatus });
  }
}

/** โพลออเดอร์ที่ยังไม่จบแล้วอัปเดตทั้งหมด */
async function tickOnce() {
  const fields = {
    _id: 1, status: 1, providerOrderId: 1,
    estCost: 1, cost: 1, quantity: 1,
    refundCommitted: 1, refundAmount: 1, refundType: 1,
    startCount: 1, currentCount: 1, remains: 1,
    progress: 1,
  };

  const filter = {
    status: { $in: ['processing', 'inprogress', 'canceling'] },
    providerOrderId: { $exists: true, $ne: null }
  };

  const limit = pLimit(CONCURRENCY);
  const cursor = Order.find(filter, fields).sort({ updatedAt: 1 }).limit(BATCH_LIMIT).lean().cursor();

  const tasks = [];
  for (let o = await cursor.next(); o != null; o = await cursor.next()) {
    tasks.push(limit(() => updateOneOrder(o)));
  }
  await Promise.allSettled(tasks);
}

// ─────────────────────────────────────────────────────────────
// public API
// ─────────────────────────────────────────────────────────────
export function startOrderStatusJob() {
  const instanceId = process.env.INSTANCE_ID || (os.hostname() + ':' + process.pid);
  process.env.INSTANCE_ID = instanceId;

  connectMongoIfNeeded().catch((e) => {
    console.error('[orderStatusJob] Mongo connect failed:', e?.message || e);
  });

  (async () => { try { await tickOnce(); } catch {} })();

  const t = setInterval(() => {
    tickOnce().catch(() => {});
  }, TICK_MS);

  console.log(`[orderStatusJob] started (instance=${instanceId}). interval=${TICK_MS}ms, concurrency=${CONCURRENCY}, verbose=${VERBOSE}`);

  return () => clearInterval(t);
}
