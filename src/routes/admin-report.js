// src/routes/admin-report.js
import { Router } from 'express';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import { Order } from '../models/Order.js';
import { Service } from '../models/Service.js';
import { PAID_STATUSES } from '../services/spend.js';

dayjs.extend(utc); dayjs.extend(tz);

const router = Router();

// ───────── helpers ─────────
const nz     = v => Number.isFinite(+v) ? +v : 0;
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** รวมยอด “คืนเงินบางส่วน” ตามฟิลด์ที่อาจพบได้หลายชื่อ */
function getPartialRefund(o) {
  let sum = 0;
  if (Array.isArray(o.partialRefunds)) {
    for (const r of o.partialRefunds) sum += nz(r?.amount ?? r?.value ?? r?.amt);
  }
  sum += nz(o.partialRefundAmount ?? o.refundedPartial ?? 0);

  // คืนเต็มจำนวน
  if ((o.refundType || '').toLowerCase() === 'full' || (o.status || '').toLowerCase() === 'refunded') {
    return Infinity;
  }
  return round2(sum);
}

/** ยอดขายที่ลูกค้าจ่ายจริง (ฝั่งเรา) – จะหัก partial refund ให้เหลือยอดสุทธิ */
function getSaleNetTHB(o) {
  // ยอดขายรวมที่ลูกค้าจ่าย (schema คุณใช้ cost / estCost)
  const gross = nz(
    o.cost ??
    o.estCost ??
    o.total ?? o.amount ?? o.totalPrice ?? o.finalCharge ??
    o.price ?? o.charge ??
    o.costTHB ?? 0
  );

  // 1) ถ้ามีรายการคืนจริง -> ใช้เลย
  const refunded = getPartialRefund(o);
  if (refunded === Infinity) return 0;
  if (refunded > 0) return Math.max(0, round2(gross - refunded));

  // 2) ถ้ายังไม่มีรายการคืน แต่สถานะเป็น partial -> คำนวณสัดส่วนที่ส่งจริง
  if ((o.status || '').toLowerCase() === 'partial') {
    // 2.1 ใช้ remains/quantity ถ้ามี
    const qty = nz(o.quantity ?? o.qty);
    const remains = nz(o.remains ?? o.providerResponse?.lastStatus?.remains);
    if (qty > 0 && remains >= 0) {
      const deliveredRatio = clamp01((qty - remains) / qty);
      return round2(gross * deliveredRatio);
    }

    // 2.2 หรือใช้ charge ของ provider เทียบ rate × (qty/1000)
    const provCharge = nz(o.providerResponse?.lastStatus?.charge) || nz(o.providerResponse?.raw?.charge);
    const rate = nz(o.rateAtOrder ?? o.baseRate ?? o.rawRate ?? o.service?.baseRate ?? o.service?.rate);
    if (provCharge > 0 && rate > 0) {
      const expectedFull = rate * ( (nz(o.quantity ?? o.qty)) / 1000 );
      if (expectedFull > 0) {
        const deliveredRatio = clamp01(provCharge / expectedFull);
        return round2(gross * deliveredRatio);
      }
    }
    // ถ้าคำนวณสัดส่วนไม่ได้ ก็ปล่อยเป็น gross ชั่วคราว (ภายหลังถ้ามี partialRefunds จะหักอัตโนมัติ)
  }

  // 3) กรณีปกติ
  return round2(gross);
}

/** rate ต้นทุนเดิม (ก่อน pricerule) – เผื่อ fallback */
function getBaseRate(o, srv) {
  return nz(
    o.baseRate ?? o.rawRate ?? o.rateBeforeRules ??
    srv?.baseRate ?? srv?.origRate ?? srv?.rate ??
    o.rate ?? o.rateAtOrder ?? 0
  );
}

/** ต้นทุน provider (พยายามอ่านจาก charge ของ provider ก่อน แล้วค่อย fallback เป็น baseRate*qty/1000) */
function getProviderCostTHB(o, srv, qty) {
  const fromProvider =
    nz(o.providerResponse?.lastStatus?.charge) ||
    nz(o.providerResponse?.raw?.charge) ||
    nz(o.providerCharge) || nz(o.providerCost);

  if (fromProvider > 0) return round2(fromProvider);

  const baseRate = getBaseRate(o, srv);
  if (baseRate > 0 && qty > 0) return round2(baseRate * (qty / 1000));

  return 0;
}

/** days in month */
function daysOfMonth(start) {
  const days = [];
  const last = start.daysInMonth();
  for (let d = 1; d <= last; d++) days.push(d);
  return days;
}

// ───────── route ─────────
router.get('/admin/report/summary', async (req, res) => {
  try {
    const monthStr = (req.query.month || dayjs().format('YYYY-MM')).slice(0, 7);
    const tzName   = req.app?.locals?.timezone || 'Asia/Bangkok';
    const start    = dayjs.tz(`${monthStr}-01T00:00:00`, tzName);
    const end      = start.add(1, 'month');

    // ✅ นับเฉพาะสถานะที่ “คิดเป็นยอดจริง” และตัดสถานะยกเลิก/คืนเงินเต็ม ออกชัดเจน
    const EXCLUDE = ['canceled','cancelled','refunded','failed','rejected'];
    const orders = await Order.find({
      createdAt: { $gte: start.toDate(), $lt: end.toDate() },
      status: { $in: PAID_STATUSES, $nin: EXCLUDE }
    })
      .populate({ path: 'service', model: Service, select: 'baseRate rate name' })
      .lean();

    const daily = {}; // { [day]: {cost, sale, count} }
    let m_sumCost = 0, m_sumSale = 0, m_sumCount = 0;

    for (const o of orders) {
      const dnum = dayjs(o.createdAt).tz(tzName).date(); // 1..31
      const qty  = nz(o.quantity ?? o.qty);

      const sale = getSaleNetTHB(o);                 // ✅ ยอดขายสุทธิหลังหัก partial refund
      const cost = getProviderCostTHB(o, o.service, qty); // ✅ ต้นทุนฝั่ง provider

      if (!daily[dnum]) daily[dnum] = { cost:0, sale:0, count:0 };
      daily[dnum].cost  = round2(daily[dnum].cost + cost);
      daily[dnum].sale  = round2(daily[dnum].sale + sale);
      daily[dnum].count = nz(daily[dnum].count + 1);

      m_sumCost  = round2(m_sumCost + cost);
      m_sumSale  = round2(m_sumSale + sale);
      m_sumCount += 1;
    }

    const rows = daysOfMonth(start).map(d => {
      const x = daily[d] || { cost:0, sale:0, count:0 };
      return { day: d, cost: x.cost, sale: x.sale, count: x.count, profit: round2(x.sale - x.cost) };
    });

    const monthTotals = {
      cost: m_sumCost,
      sale: m_sumSale,
      count: m_sumCount,
      profit: round2(m_sumSale - m_sumCost),
    };

    res.render('admin/reportsummary', {
      title: 'สรุปยอดขายรายเดือน',
      monthStr,
      rows,
      monthTotals,
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Report failed: ' + e.message);
  }
});

export default router;
