// routes/orders.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { Order } from '../models/Order.js';
import { Service } from '../models/Service.js';
import { User } from '../models/User.js';
import { computeEffectiveRateEx } from '../lib/pricing.js';
import { ProviderSettings } from '../models/ProviderSettings.js';
import { recalcUserTotals, reconcileUserByOrderEvent } from '../services/spend.js';

import {
  createOrder as providerCreateOrder,
  getOrderStatus,
  cancelOrder as providerCancelOrder, // ✅ ใช้ alias ที่ชี้ไป createCancel ใน adapter
  getCancelById,
  findCancelsByIds,
  requestRefill as providerRequestRefill,
  getBalance,
} from '../lib/iplusviewAdapter.js';

import { UsageLog } from '../models/UsageLog.js';

const router = Router();
router.use(requireAuth);

const lastRefreshAt = new Map();
const REFRESH_COOLDOWN_MS = 45_000;

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────
const toNum = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const nz = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const calcCost = (q, rate) => Math.max(0, (nz(q)/1000) * nz(rate));
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const moneyRound = n => Math.round((Number(n) || 0) * 100) / 100;

// ใช้ map สถานะไทย (ใช้ซ้ำ)
const mapTH = (x='') => ({
  processing: 'รอดำเนินการ',
  inprogress: 'กำลังทำ',
  completed:  'เสร็จสิ้น',
  partial:    'ส่วนบางส่วน',
  canceled:   'ยกเลิก',
  canceling:  'กำลังยกเลิก',
}[String(x).toLowerCase()] || x);

/** รวมผลตอบกลับของ provider ให้เข้ากับสคีมาเรา */
function normalizeProviderFields(resp) {
  const r = resp || {};
  return {
    providerOrderId: r.providerOrderId ?? r.order_id ?? r.orderId ?? r.id ?? null,
    startCount:   toNum(r.start_count ?? r.startCount),
    currentCount: toNum(r.current_count ?? r.currentCount),
    remains:      toNum(r.remains),
    progress:     toNum(r.progress),
    acceptedAt:   r.accepted_at ? new Date(r.accepted_at)
                 : (r.acceptedAt ? new Date(r.acceptedAt) : null),
    raw:          r,
  };
}

/** คืนค่า flags {refill, cancel} ของ service (รองรับทั้ง group-child และตัวหลัก) */
function getServiceFlags(serviceDoc, providerServiceId) {
  if (!serviceDoc) return { refill: false, cancel: false };
  // base flags
  let refill = !!serviceDoc.refill;
  let cancel = !!serviceDoc.cancel;

  // child overrides
  const children = Array.isArray(serviceDoc?.details?.services)
    ? serviceDoc.details.services : [];
  if (children.length) {
    const child = children.find(c => String(c.id) === String(providerServiceId));
    if (child) {
      if (typeof child.refill === 'boolean') refill = child.refill;
      if (typeof child.cancel === 'boolean') cancel = child.cancel;
    }
  }
  return { refill, cancel };
}

/** คำนวณ % ที่ทำไปแล้ว จาก progress/remains/start-current */
function computeDonePct(o) {
  const qty = Number(o.quantity) || 0;
  if (typeof o.progress === 'number') return Math.max(0, Math.min(100, o.progress));
  if (typeof o.remains === 'number' && qty > 0) {
    const left = Math.max(0, o.remains);
    return Math.max(0, Math.min(100, (1 - left / qty) * 100));
  }
  if (typeof o.startCount === 'number' && typeof o.currentCount === 'number' && qty > 0) {
    const gained = Math.max(0, o.currentCount - o.startCount);
    return Math.max(0, Math.min(100, (gained / qty) * 100));
  }
  return 0;
}

function isDone(o) {
  return computeDonePct(o) >= 99.995 || String(o.status||'').toLowerCase() === 'completed';
}

// คืนเงินแบบ idempotent: คืนเฉพาะ “ส่วนต่าง” ที่ยังไม่เคยคืน
async function refundIdempotent({ userId, orderId, currency = 'THB', amount }) {
  const amt = Math.max(0, Number(amount) || 0);
  if (amt <= 0) return { refunded: 0, already: 0, delta: 0 };

  let already = 0;
  try {
    // รวมยอดที่เคยคืนไปแล้วจาก usage_logs
    const agg = await UsageLog.aggregate([
      { $match: { orderId, type: 'refund' } },
      { $group: { _id: '$orderId', sum: { $sum: '$amount' } } }
    ]);
    already = Number(agg?.[0]?.sum || 0);
  } catch {
    // ถ้าไม่มี UsageLog model ก็ปล่อยผ่าน (ยังกันซ้ำจาก refundCommitted ได้อีกชั้น ถ้าคุณเพิ่มใน schema)
  }

  const delta = Math.max(0, amt - already);
  if (delta <= 0) return { refunded: 0, already, delta: 0 };

  let log = null;
  try {
    log = await UsageLog.create({
      userId, orderId, type: 'refund', amount: delta, currency, note: 'cancel/partial refund'
    });
  } catch (e) {
    // กันซ้ำระดับ DB (unique index) — ถ้าชน 11000 แปลว่ามี Log แล้ว → ไม่ต้อง inc ซ้ำ
    if (e?.code === 11000) return { refunded: 0, already: amt, delta: 0 };
    throw e;
  }

  // เพิ่มเงินเข้าบัญชีผู้ใช้ตาม "ส่วนต่าง"
  await User.updateOne({ _id: userId }, { $inc: { balance: delta } });
  return { refunded: delta, already, delta, logId: log?._id || null };
}

/** อัปเดตยอดเครดิตผู้ให้บริการ (ไม่ throw เพื่อไม่รันค้าง) */
async function refreshProviderBalanceNow() {
  try {
    const balRaw = await getBalance();
    const keys = ['balance', 'credit', 'credits', 'amount'];
    const val = Number(keys.map(k => balRaw?.[k]).find(v => v !== undefined));
    let ps = await ProviderSettings.findOne();
    if (!ps) ps = new ProviderSettings();
    ps.lastBalance = Number.isFinite(val) ? val : 0;
    ps.lastSyncAt = new Date();
    await ps.save();
    console.log('[balance] synced =>', ps.lastBalance);
  } catch (e) {
    console.warn('[balance] sync failed:', e?.response?.data || e.message || e);
  }
}

// helper
const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

async function forceCheckProviderAndUpdate(order) {
  // 1) ถ้ามี cancelId ก็ลองถามปลายทางตรง ๆ
  const cancelId = order?.meta?.cancelId || order?.cancelId;
  if (cancelId) {
    try {
      const r = await getCancelById(cancelId);
      // ตัวอย่าง: r.status อาจเป็น 'canceled' | 'partial' | 'processing'
      if (r?.status === 'canceled' || r?.status === 'partial') {
        order.status = (r.status === 'canceled') ? 'canceled' : 'partial';
        if (r?.refundAmount != null) {
          order.refundAmount = Number(r.refundAmount) || 0;
          order.refundType   = (r.status === 'partial') ? 'partial' : 'full';
        }
        order.updatedAt = new Date();
        await order.save();
        // อัปเดตยอด/รีคอนซายล์เครดิต ฯลฯ
        await reconcileUserByOrderEvent(order, 'cancel_confirmed');
        return true;
      }
    } catch { /* เงียบไว้ แล้วไป fallback ต่อ */ }
  }

  // 2) Fallback: หา by orderId ถ้าผู้ให้บริการรองรับ
  try {
    const r2 = await findCancelsByIds([order.providerOrderId].filter(Boolean));
    const hit = Array.isArray(r2) ? r2.find(x => String(x.orderId) === String(order.providerOrderId)) : null;
    if (hit && (hit.status === 'canceled' || hit.status === 'partial')) {
      order.status = (hit.status === 'canceled') ? 'canceled' : 'partial';
      if (hit?.refundAmount != null) {
        order.refundAmount = Number(hit.refundAmount) || 0;
        order.refundType   = (hit.status === 'partial') ? 'partial' : 'full';
      }
      order.updatedAt = new Date();
      await order.save();
      await reconcileUserByOrderEvent(order, 'cancel_confirmed');
      return true;
    }
  } catch { /* ผ่าน */ }

  // 3) สำรองสุดท้าย: เช็กสถานะออเดอร์
  try {
    const s = await getOrderStatus(order.providerOrderId);
    const st = String(s?.status || '').toLowerCase();
    if (st === 'canceled' || st === 'partial') {
      order.status = (st === 'canceled') ? 'canceled' : 'partial';
      if (s?.refundAmount != null) {
        order.refundAmount = Number(s.refundAmount) || 0;
        order.refundType   = (st === 'partial') ? 'partial' : 'full';
      }
      order.updatedAt = new Date();
      await order.save();
      await reconcileUserByOrderEvent(order._id, { reason: 'cancel_confirmed', force: true });
      return true;
    }
  } catch { /* ผ่าน */ }

  return false;
}


const PERPAGE_DEFAULT = 20;
const PERPAGE_ALLOWED = [10, 20, 50, 100, 250, 500, 1000];

function clampPerPage(n) {
  const maxAllowed = Math.max(...PERPAGE_ALLOWED);
  return Math.min(n, maxAllowed);
}

// ─────────────────────────────────────────────────────────────
// redirects
// ─────────────────────────────────────────────────────────────
router.get('/my/order', (req, res) => res.redirect(301, '/my/orders'));
router.get('/orders/history', (req, res) => res.redirect(302, '/my/orders'));

// ─────────────────────────────────────────────────────────────
// create order
// ─────────────────────────────────────────────────────────────
router.post('/orders', async (req, res) => {
  try {
    const { serviceId, groupId, providerServiceId, link } = req.body;
    let quantity = nz(req.body.quantity);

    if (!link || !quantity) {
      return res.status(400).json({ error: 'missing fields' });
    }

    // 0) auth
    const me = req.session?.user || req.user;
    const userId = String(me?._id || '');
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    // 1) ระบุบริการ (เดี่ยว หรือ กลุ่ม+child)
    let baseDoc = null;
    let chosen = null;
    let providerIdForApi = null;

    if (serviceId) {
      baseDoc = await Service.findById(serviceId).lean();
      if (!baseDoc) return res.status(404).json({ error: 'service not found' });
      chosen = { ...baseDoc };
      providerIdForApi =
        baseDoc.providerServiceId || baseDoc.providerServiceID || baseDoc.id || baseDoc.provider_id;
    } else if (groupId && providerServiceId) {
      baseDoc = await Service.findById(groupId).lean();
      if (!baseDoc) return res.status(404).json({ error: 'service group not found' });

      const children = Array.isArray(baseDoc?.details?.services) ? baseDoc.details.services : [];
      const child = children.find(c => String(c.id) === String(providerServiceId));
      if (!child) return res.status(404).json({ error: 'child service not found' });

      chosen = {
        ...child,
        _id: baseDoc._id,
        category: baseDoc.category,
        subcategory: baseDoc.subcategory,
        currency: child.currency || baseDoc.currency || 'THB',
        rate: nz(child.rate ?? baseDoc.rate),
        min:  nz(child.min  ?? baseDoc.min),
        max:  nz(child.max  ?? baseDoc.max),
        step: nz(child.step ?? baseDoc.step ?? 1),
        name: child.name || baseDoc.name
      };
      providerIdForApi = child.id;
    } else {
      return res.status(400).json({ error: 'missing fields' });
    }

    // 2) ตรวจ min/max + บังคับ step (ใช้ nz/round2 ของคุณ)
    if (!(quantity > 0)) return res.status(400).json({ error: 'จำนวนต้องมากกว่า 0' });
    if (chosen.min && quantity < chosen.min) return res.status(400).json({ error: `ขั้นต่ำ ${chosen.min}` });
    if (chosen.max && quantity > chosen.max) return res.status(400).json({ error: `สูงสุด ${chosen.max}` });

    const step = Math.max(1, nz(chosen.step));
    if (quantity % step !== 0) {
      const fixed = Math.floor(quantity / step) * step; // ปัดลงให้เป็นทวีคูณ
      if (fixed < Math.max(1, nz(chosen.min))) {
        return res.status(400).json({ error: `ปริมาณต้องเป็นทวีคูณของ ${step}` });
      }
      quantity = fixed;
    }

    // 3) คิดราคา (ยึด calcCost + moneyRound ของคุณ)
    let rate = nz(chosen.rate);
    let cost = moneyRound(calcCost(quantity, rate));
    try {
      const ex = await computeEffectiveRateEx({
        serviceId: baseDoc._id,
        childId: (serviceId ? null : providerIdForApi),
        userId,
        baseRate: rate,
        quantity
      });
      rate = nz(ex.finalRate ?? rate);
      cost = moneyRound(ex.lineCost ?? calcCost(quantity, rate));
    } catch {}

    const currency = chosen.currency || 'THB';

    // 4) เดบิต
    const debited = await User.findOneAndUpdate(
      { _id: userId, balance: { $gte: cost } },
      { $inc: { balance: -cost } },
      { new: true, projection: { balance: 1 } }
    );
    if (!debited) return res.status(400).json({ error: 'ยอดเงินไม่พอ', need: cost, currency });

    // 5) ยิงผู้ให้บริการ
    const providerPayload = {
      service_id: Number(providerIdForApi),
      link,
      quantity,
      ...(req.body?.dripfeed !== undefined ? { dripfeed: !!req.body.dripfeed } : {}),
      ...(req.body?.runs     !== undefined ? { runs: Number(req.body.runs) } : {}),
      ...(req.body?.interval !== undefined ? { interval: String(req.body.interval) } : {}),
      ...(req.body?.comments !== undefined ? { comments: String(req.body.comments) } : {}),
    };

    let providerResp;
    try {
      providerResp = await providerCreateOrder(providerPayload);
    } catch (e) {
      console.error('Provider order failed:', e?.response?.data || e.message);
      await User.updateOne({ _id: userId }, { $inc: { balance: cost } }); // คืนเงิน
      return res.status(502).json({ error: 'สั่งงานผู้ให้บริการไม่สำเร็จ', detail: e?.response?.data || e.message });
    }

    // 6) บันทึก (normalize ผลลัพธ์, ใช้ snapshot ราคา/บริการ)
    const np = normalizeProviderFields(providerResp);
    const fields = {
      user: userId,
      userId,
      service: baseDoc._id,
      providerServiceId: providerIdForApi,
      providerOrderId: np.providerOrderId,
      link,
      quantity,
      cost, estCost: cost, currency,
      rateAtOrder: rate,
      baseRateAtOrder: nz(chosen.rate),
      serviceName: chosen.name || baseDoc.name,
      status: 'processing',
      providerResponse: np.raw || providerResp || null,
      startCount:   (np.startCount   != null ? np.startCount   : undefined),
      currentCount: (np.currentCount != null ? np.currentCount : undefined),
      remains:      (np.remains      != null ? np.remains      : undefined),
      progress:     (np.progress     != null ? np.progress     : undefined),
      acceptedAt:   (np.acceptedAt || undefined),
      category:     baseDoc.category,
      subcategory:  baseDoc.subcategory
    };

    if (fields.progress == null && fields.startCount != null && fields.currentCount != null && quantity > 0) {
      fields.progress = Math.max(0, Math.min(100, ((fields.currentCount - fields.startCount) / quantity) * 100));
      fields.progress = round2(fields.progress);
    }

    try {
      const order = await Order.create(fields);
      await User.updateOne({ _id: userId }, { $inc: { totalOrders: 1 } });

      setTimeout(() => {
        refreshProviderBalanceNow().catch(() => {});
        reconcileUserByOrderEvent(order._id).catch(() => {});
      }, 0);

      return res.json({
        ok: true,
        orderId: order._id,
        providerOrderId: np.providerOrderId,
        charged: { amount: cost, currency },
        balance: debited.balance,
      });
    } catch (e) {
      await User.updateOne({ _id: userId }, { $inc: { balance: cost } }); // rollback
      console.error('Order create failed, refunded:', e);
      return res.status(500).json({ error: 'save order failed' });
    }
  } catch (err) {
    console.error('POST /orders error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// my orders (ส่ง flag ไปให้ history.ejs ใช้แสดง/ซ่อนปุ่ม)
// ─────────────────────────────────────────────────────────────
router.get('/my/orders', requireAuth, async (req, res, next) => {
  try {
    const me = req.user || res.locals.me || req.session?.user;
    if (!me || !me._id) return res.redirect('/login');

    const userId = String(me._id);
    const { from, to, q } = req.query;

    // ---------- ค้นหา ----------
    const find = { user: userId };
    if (from) find.createdAt = { ...(find.createdAt || {}), $gte: new Date(from + 'T00:00:00Z') };
    if (to)   find.createdAt = { ...(find.createdAt || {}), $lte: new Date(to   + 'T23:59:59Z') };

    if (q && q.trim()) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rgx  = new RegExp(safe, 'i');
      // ค้นหา _id ตรง, providerOrderId ตรง, หรือฟิลด์อื่นแบบ regex
      find.$or = [
        { _id: q },
        { providerOrderId: q },
        { link: rgx },
        { serviceName: rgx }
      ];
    }

    // ---------- นับรวมทั้งหมด (สำหรับ paginator) ----------
    const total = await Order.countDocuments(find);

    // ---------- perPage/page ----------
    const PERPAGE_OPTIONS = [10, 20, 50, 100, 250, 500, 1000];
    const perPageRaw = String(req.query.perPage ?? '20').toLowerCase();

    let perPage;
    if (perPageRaw === 'all') {
      // แสดงทั้งหมด
      perPage = total || 1_000_000; // กัน division by zero
    } else {
      const n = Math.max(1, parseInt(perPageRaw, 10) || 20);
      perPage = PERPAGE_OPTIONS.includes(n) ? n : 20;
    }

    const pages = Math.max(1, Math.ceil(total / Math.max(1, perPage)));
    let page = Math.max(1, parseInt(req.query.page || '1', 10));
    if (page > pages) page = pages;

    const skip = (page - 1) * perPage;

    // ---------- ดึงรายการตามหน้า ----------
    const list = await Order.find(find)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .lean();

    // ---------- เติมข้อมูล service/flags ----------
    const serviceIds = [...new Set(list.map(o => o?.service).filter(Boolean).map(String))];
    const services = serviceIds.length
      ? await Service.find({ _id: { $in: serviceIds } })
          .select('name rate currency providerServiceId refill cancel details.services')
          .lean()
      : [];
    const svcMap = Object.fromEntries(services.map(s => [String(s._id), s]));

    const listWithSvc = list.map(o => {
      const svc = svcMap[String(o.service)] || null;
      const flags = getServiceFlags(svc, o.providerServiceId);
      const _isDone = isDone(o);
      return {
        ...o,
        service: svc ? {
          _id: svc._id, name: svc.name, rate: svc.rate,
          currency: svc.currency, providerServiceId: svc.providerServiceId
        } : null,
        uiFlags: {
          canCancel: (flags.cancel === true) && !_isDone && !!o.providerOrderId,
          canRefill: (flags.refill === true) && _isDone && !!o.providerOrderId,
          isDone: _isDone
        }
      };
    });

    const pillClass = (s = '') => {
      s = String(s).toLowerCase();
      if (s === 'processing') return 'warn';
      if (s === 'inprogress') return 'blue';
      if (s === 'completed')  return 'ok';
      if (s === 'partial')    return 'violet';
      if (s === 'canceled')   return 'danger';
      return '';
    };
    const thStatus = (s = '') =>
      ({ processing:'รอดำเนินการ', inprogress:'กำลังทำ', completed:'เสร็จสิ้น', partial:'ส่วนบางส่วน', canceled:'ยกเลิก' }[String(s).toLowerCase()] || s);

    // ---------- ส่งตัวแปรที่ history.ejs ใช้ ----------
    res.render('orders/history', {
      list: listWithSvc,
      from, to, q,
      pillClass, thStatus,
      title: 'ประวัติการใช้บริการ Social',
      bodyClass: 'orders-wide',
      syncError: req.flash?.('syncError')?.[0] || '',

      // สำหรับ pager ใน EJS:
      page,                // เลขหน้าปัจจุบัน
      perPage,             // จำนวนต่อหน้า (ตัวเลขจริง; ถ้า user เลือก "all" = total)
      total                // จำนวนรายการทั้งหมด
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────
// single order status (GET) + refresh (POST)
// ─────────────────────────────────────────────────────────────
router.get('/orders/:id/status', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'not found' });

    if (!order.providerOrderId) {
      return res.json({ ok: true, status: order.status });
    }

    const s = await getOrderStatus(order.providerOrderId);
    const st = String(s.status || order.status || 'processing').toLowerCase();

    const u = {
      status: st,
      startCount:   toNum(s.start_count ?? s.startCount)   ?? order.startCount,
      currentCount: toNum(s.current_count ?? s.currentCount) ?? order.currentCount,
      remains:      toNum(s.remains) ?? order.remains,
      progress:     toNum(s.progress) ?? order.progress,
      acceptedAt:   s.accepted_at ? new Date(s.accepted_at)
                   : (s.acceptedAt ? new Date(s.acceptedAt) : (order.acceptedAt || null)),
      providerResponse: { ...(order.providerResponse || {}), lastStatus: s },
    };
    if (u.progress == null && u.startCount != null && u.currentCount != null && order.quantity > 0) {
      u.progress = Math.max(0, Math.min(100, ((u.currentCount - u.startCount) / order.quantity) * 100));
    }

    Object.assign(order, u);
    await order.save();
    setTimeout(() => reconcileUserByOrderEvent(order._id).catch(()=>{}), 0);

    return res.json({ ok: true, status: order.status, provider: s });
  } catch (err) {
    console.error('GET /orders/:id/status error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

router.post('/api/orders/:id/refresh', async (req, res) => {
  try {
    const o = await Order.findById(req.params.id);
    if (!o) return res.status(404).json({ error: 'not found' });

    const mapTHL = (x='') => ({
      processing:'รอดำเนินการ', inprogress:'กำลังทำ', completed:'เสร็จสิ้น',
      partial:'ส่วนบางส่วน', canceled:'ยกเลิก', canceling:'กำลังยกเลิก'
    }[String(x).toLowerCase()] || x);

    // ถ้าอยู่ในสถานะ "canceling" และมี cancelId → เช็คสถานะจาก provider ก่อน
    if (String(o.status||'').toLowerCase() === 'canceling' && o.lastCancelId) {
      try {
        const c = await getCancelById(o.lastCancelId);
        const st = String(c.status || '').toLowerCase();

        if (/^(canceled|cancelled|success|ok|accepted|done|finished|completed)$/.test(st)) {
          // ✅ provider คอนเฟิร์มยกเลิกแล้ว → เปลี่ยนเป็น canceled + คืนเงินตามสัดส่วน
          const est       = nz(o.estCost ?? o.cost ?? calcCost(o.quantity, o.rateAtOrder));
          const donePct   = computeDonePct(o);
          const leftRatio = Math.max(0, Math.min(1, 1 - (donePct/100)));
          const refund    = round2(est * leftRatio);
          const refundType = (leftRatio >= 0.999) ? 'full'
                            : (leftRatio <= 0.001) ? 'none' : 'partial';

          o.status = 'canceled';
          o.canceledAt = new Date();
          o.refundAmount = refund;
          o.refundType = (refundType === 'none') ? null : refundType;
          await o.save();

          if (refund > 0) {
            await User.updateOne({ _id: o.user }, { $inc: { balance: refund } });
          }
          setTimeout(() => reconcileUserByOrderEvent(o._id).catch(()=>{}), 0);

          return res.json({
            ok: true,
            status: o.status,
            status_th: mapTHL(o.status),
            refundAmount: o.refundAmount ?? 0,
            refundType: o.refundType || null,
            updatedAt: o.updatedAt,
            progress: o.progress ?? null,
            remains: o.remains ?? null,
            start_count: o.startCount ?? null,
            current_count: o.currentCount ?? null
          });
        }
        // ถ้ายังไม่สำเร็จ → ปล่อยให้เป็น canceling ต่อไป
      } catch (e) {
        console.warn('check cancel status failed:', e?.response?.data || e.message);
      }
    }

    if (!o.providerOrderId) {
      return res.json({ ok: true, status: o.status || 'processing' });
    }

    const s  = await getOrderStatus(o.providerOrderId);
    const st = String(s.status || o.status || 'processing').toLowerCase();

    // เตรียมอัปเดตจาก provider
    const upd = {
      status: st,
      startCount:   toNum(s.start_count ?? s.startCount)     ?? o.startCount,
      currentCount: toNum(s.current_count ?? s.currentCount) ?? o.currentCount,
      remains:      toNum(s.remains) ?? o.remains,
      progress:     toNum(s.progress) ?? o.progress,
      acceptedAt:   s.accepted_at ? new Date(s.accepted_at)
                   : (s.acceptedAt ? new Date(s.acceptedAt) : (o.acceptedAt || null)),
      providerResponse: { ...(o.providerResponse || {}), lastStatus: s },
      updatedAt: new Date()
    };
    if (upd.progress == null && upd.startCount != null && upd.currentCount != null && o.quantity > 0) {
      upd.progress = Math.max(0, Math.min(100, ((upd.currentCount - upd.startCount) / o.quantity) * 100));
    }

    const prevStatus = o.status; 
    Object.assign(o, upd);   
    await o.save();
    setTimeout(() => reconcileUserByOrderEvent(o._id).catch(()=>{}), 0);

    if (st === 'canceled' && prevStatus !== 'canceled') {
      const est       = nz(o.estCost ?? o.cost ?? calcCost(o.quantity, o.rateAtOrder));
      const donePct   = computeDonePct(o);     
      const leftRatio = Math.max(0, Math.min(1, 1 - (donePct/100)));
      const refund    = round2(est * leftRatio);
      const refundType = (leftRatio >= 0.999) ? 'full'
                        : (leftRatio <= 0.001) ? 'none' : 'partial';

      o.status = 'canceled';
      o.canceledAt = new Date();
      if (!Number.isFinite(o.refundAmount) || o.refundAmount <= 0) {
        o.refundAmount = refund;
        o.refundType = refundType;
        await o.save();
        if (refund > 0) {
          await User.updateOne({ _id: o.user }, { $inc: { balance: refund } });
        }
      } else {
        await o.save(); // เคยคืนแล้ว ก็แค่อัปเดตเวลา/สถานะ
      }
    }

    return res.json({
      ok: true,
      status: o.status,
      status_th: mapTHL(o.status),
      refundAmount: o.refundAmount ?? 0,
      refundType: o.refundType || null,
      updatedAt: o.updatedAt,
      progress: o.progress ?? null,
      remains: o.remains ?? null,
      start_count: o.startCount ?? null,
      current_count: o.currentCount ?? null
    });
  } catch (err) {
    console.error('POST /api/orders/:id/refresh error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// refresh-all
// ─────────────────────────────────────────────────────────────
router.post('/api/orders/refresh-all', async (req, res) => {
  try {
    const me = req.session?.user || req.user;
    const userId = String(me?._id || '');
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const prev = lastRefreshAt.get(userId) || 0;
    const now  = Date.now();
    if (now - prev < REFRESH_COOLDOWN_MS) {
      return res.json({ ok: true, updated: 0, changes: [], cooldown: true });
    }
    lastRefreshAt.set(userId, now);

    // ดึงเฉพาะที่ยัง active เพื่อลดโหลด
    const list = await Order.find({
      user: userId,
      status: { $in: ['processing', 'inprogress', 'partial', 'canceling'] }
    }).sort({ createdAt: -1 }).limit(300);

    let updated = 0;
    const changes = [];

    // ─────────────────────────────────────────────
    // 1) ตรวจผลยกเลิกจาก Cancel API แบบรวดเดียว
    // ─────────────────────────────────────────────
    const canceling = list.filter(o =>
      String(o.status).toLowerCase() === 'canceling' && o.lastCancelId
    );
    const cancelIds = canceling.map(o => String(o.lastCancelId));

    let cancelMap = {};
    if (cancelIds.length) {
      try {
        const arr = await findCancelsByIds(cancelIds); // ← adapter คืน array
        cancelMap = Object.fromEntries(arr
          .filter(x => x && x.id)
          .map(x => [String(x.id), x]));
      } catch (e) {
        console.warn('findCancelsByIds failed:', e?.response?.data || e.message);
      }
    }

    for (const o of list) {
      const curSt = String(o.status || '').toLowerCase();

      // ─────────────────────────────────────────────
      // 1.1) ถ้าเป็น "canceling" → อนุญาตอัปเดตเป็น canceled
      //      เฉพาะเมื่อ Cancel API ยืนยันเท่านั้น
      // ─────────────────────────────────────────────
      if (curSt === 'canceling' && o.lastCancelId) {
        const c = cancelMap[String(o.lastCancelId)];
        if (c) {
          const st = String(c.status || '').toLowerCase();
          if (/^(canceled|cancelled|success|ok|accepted|done|finished|completed)$/.test(st)) {
            const est       = nz(o.estCost ?? o.cost ?? calcCost(o.quantity, o.rateAtOrder));
            const donePct   = computeDonePct(o);
            const leftRatio = Math.max(0, Math.min(1, 1 - (donePct / 100)));
            const refund    = round2(est * leftRatio);
            const refundType = (leftRatio >= 0.999) ? 'full'
                              : (leftRatio <= 0.001) ? 'none' : 'partial';

            o.status = 'canceled';
            o.canceledAt = new Date();
            if (!Number.isFinite(o.refundAmount) || o.refundAmount <= 0) {
              o.refundAmount = refund;
              o.refundType = (refundType === 'none') ? null : refundType;
              await o.save();
              if (refund > 0) {
                await User.updateOne({ _id: o.user }, { $inc: { balance: refund } });
              }
            } else {
              await o.save();
            }

            updated++;
            changes.push({
              _id: String(o._id),
              status: o.status,
              startCount: o.startCount ?? null,
              currentCount: o.currentCount ?? null,
              remains: o.remains ?? null,
              progress: o.progress ?? null,
              quantity: o.quantity ?? 0,
              updatedAt: o.updatedAt,
              refundAmount: o.refundAmount ?? 0,
              refundType: o.refundType || null
            });
          }
        }

        // ⛔️ ข้ามการรีเฟรชสถานะ (ไม่เรียก getOrderStatus) สำหรับออเดอร์ที่ยัง canceling
        continue;
      }

      // ─────────────────────────────────────────────
      // 2) ออเดอร์อื่น ๆ (ไม่ใช่ canceling) ค่อยดึงสถานะตามปกติ
      // ─────────────────────────────────────────────
      if (!o.providerOrderId) continue;

      try {
        const s  = await getOrderStatus(o.providerOrderId);
        let st   = String(s.status || o.status || 'processing').toLowerCase();

        // 🔒 กันโดน override เป็น canceled จากช่อง status ทั่วไป
        //    (ต้องให้ cancel API เป็นผู้ยืนยันเท่านั้น)
        if (String(o.status).toLowerCase() === 'canceling') {
          st = 'canceling';
        }

        const upd = {
          status: st,
          startCount:   toNum(s.start_count ?? s.startCount)     ?? o.startCount,
          currentCount: toNum(s.current_count ?? s.currentCount) ?? o.currentCount,
          remains:      toNum(s.remains) ?? o.remains,
          progress:     toNum(s.progress) ?? o.progress,
          acceptedAt:   s.accepted_at ? new Date(s.accepted_at)
                       : (s.acceptedAt ? new Date(s.acceptedAt) : (o.acceptedAt || null)),
          providerResponse: { ...(o.providerResponse || {}), lastStatus: s },
          updatedAt: new Date()
        };
        if (upd.progress == null && upd.startCount != null && upd.currentCount != null && o.quantity > 0) {
          upd.progress = Math.max(0, Math.min(100, ((upd.currentCount - upd.startCount) / o.quantity) * 100));
        }

        const before = {
          status: o.status,
          startCount: o.startCount,
          currentCount: o.currentCount,
          remains: o.remains,
          progress: o.progress
        };

        const prevStatus = o.status;
        Object.assign(o, upd);
        await o.save();

        // ⛔️ ตัดทิ้งการ flip เป็น canceled จากช่องสถานะทั่วไป
        //    เรา "ไม่" คืนเงิน/ปิดงานที่นี่อีกแล้ว
        //    (ให้ cancel API เป็นผู้ flip เท่านั้น)

        const changed =
          before.status !== o.status ||
          before.startCount !== o.startCount ||
          before.currentCount !== o.currentCount ||
          before.remains !== o.remains ||
          before.progress !== o.progress;

        if (changed) {
          updated++;
          changes.push({
            _id: String(o._id),
            status: o.status,
            startCount: o.startCount ?? null,
            currentCount: o.currentCount ?? null,
            remains: o.remains ?? null,
            progress: o.progress ?? null,
            quantity: o.quantity ?? 0,
            updatedAt: o.updatedAt
          });
        }
      } catch {
        // เงียบไว้; ไม่ให้ทั้งหน้า error
      }
    }

    setTimeout(() => recalcUserTotals(userId, { force: true }).catch(() => {}), 0);

    // รวมรายการที่ DB เพิ่งอัปเดตในช่วงสั้น ๆ (กันตกหล่น)
    const RECENT_WINDOW_MS = 10 * 60 * 1000; // 10 นาที
    const recent = await Order.find({
      user: userId,
      updatedAt: { $gte: new Date(Date.now() - RECENT_WINDOW_MS) }
    })
      .select('_id status startCount currentCount remains progress quantity updatedAt refundAmount refundType')
      .sort({ updatedAt: -1 })
      .limit(300)
      .lean();

    for (const r of recent) {
      if (!changes.find(c => String(c._id) === String(r._id))) {
        changes.push({
          _id: String(r._id),
          status: r.status,
          startCount: r.startCount ?? null,
          currentCount: r.currentCount ?? null,
          remains: r.remains ?? null,
          progress: r.progress ?? null,
          quantity: r.quantity ?? 0,
          updatedAt: r.updatedAt,
          refundAmount: r.refundAmount ?? 0,
          refundType: r.refundType || null,
        });
      }
    }

    return res.json({ ok: true, updated, changes });
  } catch (err) {
    console.error('POST /api/orders/refresh-all error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// NEW: cancel (สั่งยกเลิก → ตั้ง canceling) และ refill
// ─────────────────────────────────────────────────────────────
// UI กดจากหน้ารายการ (web) → สั่งยกเลิกและตั้งสถานะ "canceling"
router.post('/orders/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const me = req.user || req.session?.user;

    const ord = await Order.findById(id).populate('user', 'username role').exec();
    if (!ord) return res.status(404).json({ ok:false, error:'ไม่พบออเดอร์' });

    const isOwner = String(ord.user?._id || '') === String(me?._id || '');
    const isAdmin = me?.role === 'admin';
    if (!(isOwner || isAdmin)) return res.status(403).json({ ok:false, error:'forbidden' });

    const st = String(ord.status || '').toLowerCase();
    if (['canceled','cancelled','completed','partial'].includes(st)) {
      return res.status(400).json({ ok:false, error:`สถานะ "${st}" ไม่สามารถยกเลิกได้` });
    }

    // ยิงไป provider ถ้ามี providerOrderId
    let cancelId = null;
    if (ord.providerOrderId) {
      try {
        const resp = await providerCancelOrder(ord.providerOrderId); // POST /cancels/:orderId
        cancelId = resp?.cancelId ?? null;
      } catch (e) {
        const msg = e?.response?.data?.error || e?.response?.data?.message || e.message || 'cancel denied by provider';
        return res.status(400).json({ ok:false, error: msg });
      }
    }

    // ตั้งเป็นกำลังยกเลิก + เก็บ cancelInfo
    ord.status = 'canceling';
    ord.cancelInfo = {
      providerCancelId: cancelId || null,
      requestedAt: new Date(),
      providerStatus: cancelId ? 'pending' : 'requested',
    };
    ord.lastCancelId = cancelId || ord.lastCancelId || null;

    // ล้างฟิลด์ผลยกเลิก/คืนเงินเก่า (กันแสดงผลก่อนเวลา)
    ord.canceledAt   = null;
    ord.refundAmount = null;
    ord.refundType   = null;

    await ord.save();
    return res.json({ ok:true, status: 'canceling', cancelId: ord.cancelInfo.providerCancelId });
  } catch (e) {
    console.error('cancel order error:', e);
    return res.status(500).json({ ok:false, error:e.message || 'cancel failed' });
  }
});

// ปุ่ม refresh ของ modal ยกเลิก
router.post('/orders/:id/cancel/refresh', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const me = req.user || req.session?.user;

    const ord = await Order.findById(id).exec();
    if (!ord) return res.status(404).json({ ok:false, error:'ไม่พบออเดอร์' });

    const isOwner = String(ord.user) === String(me?._id || '');
    const isAdmin = me?.role === 'admin';
    if (!(isOwner || isAdmin)) return res.status(403).json({ ok:false, error:'forbidden' });

    // ถ้าปัจจุบันเป็น canceled อยู่แล้ว → ไม่ต้องทำซ้ำ
    if (String(ord.status||'').toLowerCase() === 'canceled') {
      return res.json({ ok:true, updated:false, providerStatus: ord.cancelInfo?.providerStatus || 'done' });
    }

    const cancelId = ord?.cancelInfo?.providerCancelId || ord?.lastCancelId || null;
    if (!cancelId) {
      return res.status(400).json({ ok:false, error:'ยังไม่เคยส่งคำขอยกเลิก' });
    }

    ord.cancelInfo = ord.cancelInfo || { providerCancelId: cancelId, requestedAt: ord.createdAt || new Date() };

    // 1) เรียกผลจาก Cancel API
    let c;
    try {
      c = await getCancelById(cancelId);
    } catch {
      ord.cancelInfo.providerStatus = 'pending';
      await ord.save();
      return res.json({ ok:true, updated:false, providerStatus: 'pending' });
    }

    const provStatus = String(c?.status || '').toLowerCase();
    const DONE = /^(canceled|cancelled|success|ok|accepted|done|finished|completed|partial)$/i;

    if (!DONE.test(provStatus)) {
      // ยังไม่จบ → คง canceling
      ord.cancelInfo.providerStatus = provStatus || 'pending';
      if (String(ord.status||'').toLowerCase() !== 'canceling') ord.status = 'canceling';
      await ord.save();
      return res.json({ ok:true, updated:false, providerStatus: provStatus || 'pending' });
    }

    // 2) เสร็จสิ้นฝั่ง provider → คำนวณยอดที่ควรคืน
    const est0   = nz(ord.estCost ?? ord.cost ?? calcCost(ord.quantity, ord.rateAtOrder));
    const est    = Math.max(0, Number(est0) || 0);
    const donePct   = computeDonePct(ord);
    const leftRatio = Math.max(0, Math.min(1, 1 - (donePct/100)));
    const computed  = round2(est * leftRatio);

    // ถ้า API ส่ง amount มาให้ ใช้อันนั้น; ไม่งั้นใช้คำนวณเอง
    let shouldRefund = Number.isFinite(+c?.amount) ? +c.amount : computed;
    shouldRefund = Math.max(0, Math.min(shouldRefund, est));

    // ตัดสินสถานะสุดท้าย: partial ถ้าได้คืน < est (และ > 0), ไม่งั้น canceled (เต็มหรือศูนย์)
    let finalStatus = 'canceled';
    if (shouldRefund > 0 && shouldRefund < est) finalStatus = 'partial';

    // 3) คืนเงินแบบ idempotent (คืนเฉพาะ “ส่วนต่าง” ที่ยังไม่เคยคืน)
    const { delta } = await refundIdempotent({
      userId: ord.user,
      orderId: ord._id,
      currency: ord.currency || 'THB',
      amount: shouldRefund
    });

    // 4) อัปเดตออเดอร์ครั้งเดียว
    ord.status = finalStatus;
    ord.canceledAt = new Date();
    ord.refundAmount = shouldRefund;
    ord.refundType = (shouldRefund >= est - 1e-6) ? 'full' : (shouldRefund > 0 ? 'partial' : null);
    ord.cancelInfo.providerStatus = provStatus || 'done';
    ord.cancelInfo.confirmedAt = new Date();
    await ord.save();

    // sync totals (async)
    setTimeout(() => reconcileUserByOrderEvent(ord._id).catch(()=>{}), 0);

    return res.json({
      ok:true,
      updated:true,
      providerStatus: provStatus || 'done',
      order: {
        status: ord.status,
        refundAmount: ord.refundAmount,
        refundType: ord.refundType,
        refundDelta: delta
      }
    });
  } catch (e) {
    console.error('cancel refresh error:', e);
    return res.status(500).json({ ok:false, error:e.message || 'cancel refresh failed' });
  }
});

// API เส้นทางสั้น ๆ (ถ้า UI เรียกผ่าน fetch)
router.post('/api/orders/:id/cancel/start', async (req, res) => {
  try {
    const me = req.session?.user || req.user;
    const userId = String(me?._id || '');
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const o = await Order.findById(req.params.id);
    if (!o) return res.status(404).json({ error: 'not found' });

    const isOwner = (String(o.user) === userId || String(o.userId) === userId);
    const isAdmin = String(me?.role || '').toLowerCase() === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'forbidden' });

    if (String(o.status || '').toLowerCase() === 'canceled') {
      return res.json({ ok: true, already: true, status: 'canceled', status_th: mapTH('canceled'),
        refundAmount: o.refundAmount || 0, refundType: o.refundType || null });
    }

    const svc = await Service.findById(o.service).lean();
    const { cancel } = getServiceFlags(svc, o.providerServiceId);
    if (!cancel) return res.status(400).json({ error: 'บริการนี้ไม่รองรับการยกเลิก' });

    let cancelId = null;
    if (o.providerOrderId) {
      try {
        const resp = await providerCancelOrder(o.providerOrderId);
        cancelId = resp?.cancelId ?? null;
      } catch (e) {
        console.warn('provider cancel error:', e?.response?.data || e.message);
      }
    }

    o.status = 'canceling';
    if (cancelId) o.lastCancelId = cancelId;
    o.updatedAt = new Date();
    await o.save();

    return res.json({ ok:true, status:'canceling', status_th: mapTH('canceling'), cancelId });
  } catch (err) {
    console.error('POST /api/orders/:id/cancel/start error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

router.post('/api/orders/:id/cancel', async (req, res) => {
  try {
    const me = req.session?.user || req.user;
    const userId = String(me?._id || '');
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const o = await Order.findById(req.params.id);
    if (!o) return res.status(404).json({ error: 'not found' });

    const isOwner = (String(o.user) === userId || String(o.userId) === userId);
    const isAdmin = String(me?.role || '').toLowerCase() === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'forbidden' });

    if (String(o.status || '').toLowerCase() === 'canceled') {
      return res.json({
        ok: true, already: true,
        status: 'canceled', status_th: mapTH('canceled'),
        refundAmount: o.refundAmount || 0, refundType: o.refundType || null
      });
    }

    const svc = await Service.findById(o.service).lean();
    const { cancel } = getServiceFlags(svc, o.providerServiceId);
    if (!cancel) return res.status(400).json({ error: 'บริการนี้ไม่รองรับการยกเลิก' });

    let cancelId = null;
    if (o.providerOrderId) {
      try {
        const resp = await providerCancelOrder(o.providerOrderId);
        cancelId = resp?.cancelId ?? null;
      } catch (e) {
        console.warn('provider cancel error:', e?.response?.data || e.message);
      }
    }

    o.cancelRequestedAt = new Date();
    o.cancelRequestedBy = userId;
    o.cancelProgressAtRequest = (typeof o.progress === 'number') ? o.progress : null;

    o.status = 'canceling';
    if (cancelId) o.lastCancelId = cancelId;
    o.updatedAt = new Date();
    await o.save();

    return res.json({
      ok: true,
      status: 'canceling',
      status_th: mapTH('canceling'),
      cancelId
    });
  } catch (err) {
    console.error('POST /api/orders/:id/cancel error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

router.post('/api/orders/:id/refill', async (req, res) => {
  try {
    const me = req.session?.user || req.user;
    const userId = String(me?._id || '');
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const o = await Order.findById(req.params.id);
    if (!o) return res.status(404).json({ error: 'not found' });
    if (String(o.user) !== userId && String(o.userId) !== userId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const svc = await Service.findById(o.service).lean();
    const { refill } = getServiceFlags(svc, o.providerServiceId);
    if (!refill) return res.status(400).json({ error: 'บริการนี้ไม่รองรับเติมคืน (Refill)' });
    if (!o.providerOrderId) return res.status(400).json({ error: 'ไม่มีหมายเลขออเดอร์ของผู้ให้บริการ' });

    const st = String(o.status || '').toLowerCase();
    if (!(st === 'completed' || st === 'partial')) {
      return res.status(400).json({ error: 'สถานะปัจจุบันไม่รองรับการเติมคืน' });
    }

    let resp = null;
    try {
      resp = await providerRequestRefill(o.providerOrderId);
    } catch (e) {
      console.error('Provider refill failed:', e?.response?.data || e.message);
      return res.status(502).json({ error: 'ผู้ให้บริการปฏิเสธการเติมคืน', detail: e?.response?.data || e.message });
    }

    await Order.updateOne({ _id: o._id }, {
      $set: {
        lastRefillAt: new Date(),
        lastRefillResponse: resp || null
      },
      $inc: { refillCount: 1 }
    });

    return res.json({ ok: true, provider: resp || { ok: true } });
  } catch (err) {
    console.error('POST /api/orders/:id/refill error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});
/**
 * Long-poll endpoint: รอผลยกเลิกให้จริงก่อนค่อยตอบ
 * จะเช็กทุก 3 วินาที สูงสุด ~7 นาที (ปรับได้ตามต้องการ)
 */
router.post('/orders/:id/cancel/await', async (req, res) => {
  const { id } = req.params;

  // หน้าต่างรอครั้งละ 30s เพื่อกันรีเวสต์ค้างนานเกินไป (client จะยิงซ้ำอัตโนมัติ)
  const PER_REQUEST_WAIT = 30_000;
  const DEADLINE_MS      = 7 * 60 * 1000; // รวม ๆ ถ้าคลิกซ้ำต่อเนื่อง

  const start = Date.now();
  let order = await Order.findById(id);
  if (!order) return res.status(404).json({ ok:false, error:'ไม่พบออเดอร์' });

  // ถ้าระหว่างรอกลายเป็น canceled/partial แล้ว ให้ตอบเลย
  const early = String(order.status||'').toLowerCase();
  if (early === 'canceled' || early === 'partial') {
    return res.json({
      ok:true, updated:true,
      status: order.status,
      refundAmount: order.refundAmount ?? 0,
      refundType: order.refundType ?? null,
      updatedAt: order.updatedAt
    });
  }

  // วนเช็กในหน้าต่าง 30s พร้อมกระตุ้นปรับสถานะจาก provider
  const interval = 3_000;
  while (Date.now() - start < PER_REQUEST_WAIT) {
    // พยายามกระตุ้น/อัปเดตสถานะ (ถ้าพร้อม)
    await order.populate('service');
    const advanced = await forceCheckProviderAndUpdate(order);
    if (advanced) {
      return res.json({
        ok:true, updated:true,
        status: order.status,
        refundAmount: order.refundAmount ?? 0,
        refundType: order.refundType ?? null,
        updatedAt: order.updatedAt
      });
    }

    // เผื่อมี worker อื่นอัปเดต DB
    order = await Order.findById(id);
    const st = String(order?.status||'').toLowerCase();
    if (st === 'canceled' || st === 'partial') {
      return res.json({
        ok:true, updated:true,
        status: order.status,
        refundAmount: order.refundAmount ?? 0,
        refundType: order.refundType ?? null,
        updatedAt: order.updatedAt
      });
    }

    await sleep(interval);
  }

  // ยังไม่เสร็จภายในหน้าต่างรอครั้งนี้ → ให้ client ยิงมาใหม่เพื่อยืดเวลารอต่อ (จนสุด 7 นาที)
  return res.json({ ok:true, updated:false, keepWaiting:true });
});

router.get('/api/orders/:id/local-status', async (req, res) => {
  try {
    const { id } = req.params;

    // จำกัดสิทธิ์: user เห็นได้เฉพาะของตัวเอง ยกเว้น admin
    const query = { _id: id };
    if (req.user?.role !== 'admin') {
      query.user = req.user._id;
    }

    const o = await Order.findOne(query)
      .select('_id status progress remains startCount currentCount updatedAt createdAt refundAmount refundType');

    if (!o) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // คืนค่าที่ฝั่ง client ใช้โดยตรง
    return res.json({
      ok: true,
      status:        o.status,
      progress:      (typeof o.progress === 'number') ? o.progress : undefined,
      remains:       Number.isFinite(o.remains) ? o.remains : undefined,
      start_count:   Number.isFinite(o.startCount) ? o.startCount : undefined,
      current_count: Number.isFinite(o.currentCount) ? o.currentCount : undefined,
      updatedAt:     (o.updatedAt || o.createdAt),
      refundAmount:  (typeof o.refundAmount === 'number') ? o.refundAmount : undefined,
      refundType:    (typeof o.refundType === 'string') ? o.refundType : undefined
    });
  } catch (e) {
    console.error('local-status error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
