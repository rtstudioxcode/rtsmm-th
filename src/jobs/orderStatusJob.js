import os from 'os';
import pLimit from 'p-limit';
import { Order } from '../models/Order.js';
import { acquireLock, prolongLock, releaseLock } from '../models/JobLock.js';
import { getOrderStatus } from '../lib/iplusviewAdapter.js';

const JOB_KEY = 'orderStatusPoller';
const TICK_MS = Number(process.env.ORDER_STATUS_TICK_MS || 60_000);
const TICK_CANCELING_MS = Number(process.env.ORDER_STATUS_TICK_CANCELING_MS || 30_000);
const LOCK_TTL_MS = Math.max(TICK_MS, 60_000);
const CONCURRENCY = Number(process.env.ORDER_STATUS_CONCURRENCY || 4);

// map สถานะฝั่ง provider -> ฝั่งเรา
function mapProviderStatus(s){
  const x = String(s||'').toLowerCase();
  if (['completed','success','done','finished'].includes(x)) return 'completed';
  if (['partial','partially','refunded'].includes(x))       return 'partial';
  if (['canceled','cancelled','rejected','fail','failed'].includes(x)) return 'canceled';
  if (['pending','processing','inprogress'].includes(x))    return 'processing';
  return 'processing';
}

function resolveNextStatus(currentLocal, providerRawStatus){
  const local = String(currentLocal||'').toLowerCase();
  const mapped = mapProviderStatus(providerRawStatus);

  // ถ้าเรากำลังสั่งยกเลิกอยู่
  if (local === 'canceling'){
    // ให้ขยับ “เฉพาะ” เมื่อ provider จบจริง
    if (mapped === 'canceled')   return 'canceled';
    if (mapped === 'completed')  return 'completed';
    if (mapped === 'partial')    return 'partial';
    // ยัง pending/processing → คงเป็น canceling ต่อไป
    return 'canceling';
  }

  // กรณีปกติ
  return mapped;
}

// คำนวณยอดคืนจากข้อมูล provider (ถ้ามี)
function computeRefund(o, prov){
  const est = Number(o.estCost ?? o.cost ?? 0);
  if (!Number.isFinite(est) || est <= 0) return null;

  const status = mapProviderStatus(prov?.status || prov?.rawStatus);
  const chg = Number(prov?.charge ?? NaN);

  // ใช้ charge ถ้ามี (เชื่อว่าเป็น "ยอดที่ถูกคิดจริง" ของ provider)
  if (Number.isFinite(chg)) {
    const refund = Math.max(0, est - chg);
    if (status === 'canceled') {
      // ถ้า charge=0 → full refund, ถ้ามากกว่า est ก็กันล้น
      return { amount: Math.min(refund, est), type: refund >= est ? 'full' : (refund>0 ? 'partial' : 'full') };
    }
    if (status === 'partial') {
      return { amount: Math.min(refund, est), type: refund > 0 ? 'partial' : null } || null;
    }
  }

  // ไม่มี charge → ประมาณจาก remains/qty
  const qty = Number(o.quantity) || 0;
  const rem = Number.isFinite(prov?.remains) ? Number(prov.remains) : null;

  if (qty > 0 && rem != null) {
    const done = Math.max(0, qty - Math.max(0, rem));   // ทำได้เท่าไหร่
    const doneRatio = Math.max(0, Math.min(1, done / qty));
    const chargedEstimated = est * doneRatio;           // สมมุติคิดตามส่วนที่ทำได้
    const refund = Math.max(0, est - chargedEstimated);
    if (status === 'canceled') return { amount: Math.min(refund, est), type: refund >= est ? 'full' : 'partial' };
    if (status === 'partial')  return { amount: Math.min(refund, est), type: refund > 0 ? 'partial' : null } || null;
  }

  if (status === 'canceled') return { amount: est, type: 'full' }; // safe default
  return null;
}

async function updateOne(o){
  if (!o.providerOrderId) return;

  let res;
  try {
    res = await getOrderStatus(o.providerOrderId);
  } catch (e) {
    // provider ล่ม/timeout → อย่าแตะอะไร
    return;
  }

  // บาง adapter อาจใส่ไว้ใน res.lastStatus
  const provStatus = res?.status || res?.rawStatus || res?.lastStatus?.rawStatus || res?.lastStatus?.status;
  const nextStatus = resolveNextStatus(o.status, provStatus);

  const patch = { updatedAt: new Date() };

  // fields ตัวเลข
  const start = (res?.start_count ?? res?.lastStatus?.start_count);
  const curr  = (res?.current_count ?? res?.lastStatus?.current_count);
  const rem   = (res?.remains ?? res?.lastStatus?.remains);

  if (typeof start === 'number') patch.startCount   = start;
  if (typeof curr  === 'number') patch.currentCount = curr;
  if (typeof rem   === 'number') patch.remains      = rem;

  // สถานะ: ห้ามดันกลับจาก canceling → processing
  if (nextStatus !== o.status) {
    patch.status = nextStatus;

    // คำนวณ/บันทึกคืนเงินเฉพาะ “จังหวะเปลี่ยนเป็น” canceled/partial
    if ((nextStatus === 'partial' || nextStatus === 'canceled')
        && !o.refundCommitted) { // ถ้าคืนไปแล้ว ไม่คิดซ้ำ
      const rf = computeRefund(o, res);
      if (rf && rf.amount > 0) {
        // ถ้าเคยมีค่าเดิม และเดิมมากกว่า → คงค่าที่สูงสุด (กันกรณี provider ให้ข้อมูลช้า)
        const prevAmt = Number(o.refundAmount || 0);
        patch.refundAmount = Math.max(prevAmt, rf.amount);
        patch.refundType   = (patch.refundAmount >= (o.estCost ?? o.cost)) ? 'full' : (rf.type || 'partial');
      }
    }
  }

  await Order.updateOne({ _id: o._id }, { $set: patch });
}

async function scanAndUpdateBatch(filter, limitN){
  const fields = {
    _id: 1, status: 1, providerOrderId: 1,
    estCost: 1, cost: 1, quantity: 1,
    refundCommitted: 1, refundAmount: 1, refundType: 1,
    updatedAt: 1
  };

  const cursor = Order.find(filter, fields).sort({ updatedAt: 1 }).limit(limitN).lean().cursor();
  const limit = pLimit(CONCURRENCY);
  const tasks = [];
  let processed = 0;

  for (let o = await cursor.next(); o != null; o = await cursor.next()){
    tasks.push(limit(async () => {
      await updateOne(o);
      // ต่ออายุ lock เป็นระยะ
      processed++;
      if (processed % 100 === 0) {
        try { await prolongLock(JOB_KEY + ':normal', LOCK_TTL_MS); } catch {}
        try { await prolongLock(JOB_KEY + ':canceling', LOCK_TTL_MS); } catch {}
      }
    }));
  }
  await Promise.allSettled(tasks);
}

export function startOrderStatusJob(){
  process.env.INSTANCE_ID = process.env.INSTANCE_ID || (os.hostname() + ':' + process.pid);

  async function tickNormal(){
    const key = `${JOB_KEY}:normal`;
    const lock = await acquireLock(key, LOCK_TTL_MS);
    if (!lock) return;
    try {
      await scanAndUpdateBatch(
        { status: { $in: ['processing','inprogress','partial'] }, providerOrderId: { $exists: true, $ne: null } },
        300
      );
    } finally {
      await releaseLock(key).catch(()=>{});
    }
  }

  async function tickCanceling(){
    const key = `${JOB_KEY}:canceling`;
    const lock = await acquireLock(key, LOCK_TTL_MS);
    if (!lock) return;
    try {
      await scanAndUpdateBatch(
        { status: 'canceling', providerOrderId: { $exists: true, $ne: null } },
        500
      );
    } finally {
      await releaseLock(key).catch(()=>{});
    }
  }

  // run ทันที
  tickNormal().catch(()=>{});  tickCanceling().catch(()=>{});

  const t1 = setInterval(() => tickNormal().catch(()=>{}),    TICK_MS);
  const t2 = setInterval(() => tickCanceling().catch(()=>{}), TICK_CANCELING_MS);
  console.log(`[orderStatusJob] started. normal=${TICK_MS}ms canceling=${TICK_CANCELING_MS}ms`);
  return () => { clearInterval(t1); clearInterval(t2); };
}