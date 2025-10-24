// routes/orders.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { Order } from '../models/Order.js';
import { Service } from '../models/Service.js';
import { User } from '../models/User.js';
import { computePrice } from '../lib/pricing.js';
import { ProviderSettings } from '../models/ProviderSettings.js';
import { recalcUserTotals } from '../services/spend.js';

import {
  createOrder as providerCreateOrder,
  getOrderStatus,
  cancelOrder as providerCancelOrder,
  requestRefill as providerRequestRefill,
  getBalance,
} from '../lib/iplusviewAdapter.js';

const router = Router();
router.use(requireAuth);

const lastRefreshAt = new Map();
const REFRESH_COOLDOWN_MS = 45_000;

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────
const toNum = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const nz = v => (Number.isFinite(v) ? v : 0);
const calcCost = (q, rate) => Math.max(0, (nz(q) / 1000) * nz(rate));
const round2 = n => Math.round(n * 100) / 100;

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
  if (qty <= 0) return (typeof o.progress === 'number') ? Math.max(0, Math.min(100, o.progress)) : 0;
  if (typeof o.progress === 'number') return Math.max(0, Math.min(100, o.progress));
  if (typeof o.remains === 'number')  return Math.max(0, Math.min(100, (1 - Math.max(0, o.remains)/qty) * 100));
  if (typeof o.startCount === 'number' && typeof o.currentCount === 'number') {
    const gained = Math.max(0, o.currentCount - o.startCount);
    return Math.max(0, Math.min(100, (gained/qty) * 100));
  }
  return String(o.status||'').toLowerCase() === 'completed' ? 100 : 0;
}

function isDone(o) {
  return computeDonePct(o) >= 99.995 || String(o.status||'').toLowerCase() === 'completed';
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
    const quantity = nz(req.body.quantity);

    if (!link || !quantity) {
      return res.status(400).json({ error: 'missing fields' });
    }

    // 1) เลือกบริการ
    let baseDoc = null;
    let chosen = null;
    let providerIdForApi = null;

    if (serviceId) {
      baseDoc = await Service.findById(serviceId).lean();
      if (!baseDoc) return res.status(404).json({ error: 'service not found' });
      chosen = { ...baseDoc };
      providerIdForApi = baseDoc.providerServiceId || baseDoc.providerServiceID || baseDoc.id;
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
      };
      providerIdForApi = child.id;
    } else {
      return res.status(400).json({ error: 'missing fields' });
    }

    // 2) ตรวจ min/max
    if (!(quantity > 0)) return res.status(400).json({ error: 'จำนวนต้องมากกว่า 0' });
    if (chosen.min && quantity < chosen.min) return res.status(400).json({ error: `ขั้นต่ำ ${chosen.min}` });
    if (chosen.max && quantity > chosen.max) return res.status(400).json({ error: `สูงสุด ${chosen.max}` });

    // 3) คิดราคา
    let rate = nz(chosen.rate);
    try {
      if (typeof computePrice === 'function') {
        rate = await computePrice(rate, {
          categoryId: chosen.category,
          subcategoryId: chosen.subcategory,
          serviceId: baseDoc._id,
        });
      }
    } catch { /* ใช้ rate เดิม */ }

    const cost = calcCost(quantity, rate);
    const currency = chosen.currency || 'THB';

    // 4) ตัดเงิน
    const me = req.session?.user || req.user;
    const userId = String(me?._id || '');
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const debited = await User.findOneAndUpdate(
      { _id: userId, balance: { $gte: cost } },
      { $inc: { balance: -cost } },
      { new: true, projection: { balance: 1 } }
    );
    if (!debited) return res.status(400).json({ error: 'ยอดเงินไม่พอ', need: cost });

    // 5) call provider
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
      await User.updateOne({ _id: userId }, { $inc: { balance: cost } });
      return res.status(502).json({
        error: 'สั่งงานผู้ให้บริการไม่สำเร็จ',
        detail: e?.response?.data || e.message,
      });
    }

    // 6) save order
    const np = normalizeProviderFields(providerResp);
    const fields = {
      user: userId,
      userId,
      service: baseDoc._id,
      providerServiceId: providerIdForApi,
      providerOrderId: np.providerOrderId,
      link,
      quantity,
      cost,
      estCost: cost,
      currency,
      rateAtOrder: rate,
      status: 'processing',
      providerResponse: np.raw || providerResp || null,
      startCount:   np.startCount,
      currentCount: np.currentCount,
      remains:      np.remains,
      progress:     np.progress,
      acceptedAt:   np.acceptedAt,
    };

    if (fields.progress == null && fields.startCount != null && fields.currentCount != null && quantity > 0) {
      fields.progress = Math.max(0, Math.min(100, ((fields.currentCount - fields.startCount) / quantity) * 100));
    }

    try {
      const order = await Order.create(fields);

      await User.updateOne({ _id: userId }, { $inc: {totalOrders: 1 } }); 
      // อัปเดตเครดิตผู้ให้บริการอัตโนมัติหลังสั่งออเดอร์ (ไม่บล็อก response)
      setTimeout(() => {
        refreshProviderBalanceNow().catch(() => {});
        recalcUserTotalSpent(userId).catch(() => {});
        recalcUserTotals(userId).catch(() => {});
      }, 0);

      return res.json({
        ok: true,
        orderId: order._id,
        providerOrderId: np.providerOrderId,
        charged: { amount: cost, currency },
        balance: debited.balance,
      });
    } catch (e) {
      await User.updateOne({ _id: userId }, { $inc: { balance: cost } });
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

    const find = { user: userId };
    if (from) find.createdAt = { ...(find.createdAt || {}), $gte: new Date(from + 'T00:00:00Z') };
    if (to)   find.createdAt = { ...(find.createdAt || {}), $lte: new Date(to   + 'T23:59:59Z') };
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rgx  = new RegExp(safe, 'i');
      find.$or = [{ _id: q }, { link: rgx }, { providerOrderId: q }];
    }

    const list = await Order.find(find).sort({ createdAt: -1 }).limit(500).lean();

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
          canCancel: (flags.cancel === true) && !isDone(o) && !!o.providerOrderId,
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

    res.render('orders/history', {
      list: listWithSvc,
      from, to, q,
      pillClass, thStatus,
      title: 'ประวัติ ออเดอร์',
      bodyClass: 'orders-wide',
      syncError: req.flash?.('syncError')?.[0] || '',
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
    setTimeout(() => recalcUserTotals(order.userId || order.user).catch(()=>{}), 0);

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
    };
    if (upd.progress == null && upd.startCount != null && upd.currentCount != null && o.quantity > 0) {
      upd.progress = Math.max(0, Math.min(100, ((upd.currentCount - upd.startCount) / o.quantity) * 100));
    }

    const prevStatus = o.status; 
    Object.assign(o, upd);   
    await o.save();
    setTimeout(() => recalcUserTotals(o.userId || o.user).catch(()=>{}), 0);

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

    const mapTH = (x='') => ({
      processing: 'รอดำเนินการ',
      inprogress: 'กำลังทำ',
      completed:  'เสร็จสิ้น',
      partial:    'ส่วนบางส่วน',
      canceled:   'ยกเลิก',
    }[String(x).toLowerCase()] || x);

    return res.json({
      ok: true,
      status: o.status,
      status_th: mapTH(o.status),
      refundAmount: o.refundAmount ?? 0,
      refundType: o.refundType || null,
      updatedAt: o.updatedAt,
      // เพิ่ม:
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
      status: { $in: ['processing', 'inprogress', 'partial'] }
    }).sort({ createdAt: -1 }).limit(300);

    let updated = 0;
    const changes = [];

    for (const o of list) {
      if (!o.providerOrderId) continue;
      try {
        const s  = await getOrderStatus(o.providerOrderId);
        const st = String(s.status || o.status || 'processing').toLowerCase();

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

        // ถ้าเจอยกเลิกจากฝั่ง Provider → คืนเงิน (ครั้งเดียว)
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
            setTimeout(() => recalcUserTotalSpent(o.userId || o.user).catch(()=>{}), 0);
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
            refundType
          });
          continue; // ไปออเดอร์ถัดไป
        }

        // push เฉพาะเมื่อมีการเปลี่ยนแปลง
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
      } catch {}
    }
    setTimeout(() => recalcUserTotals(userId).catch(()=>{}), 0);

    // รวมรายการที่ DB เพิ่งอัปเดตในช่วงสั้น ๆ เผื่อมีการเปลี่ยนสถานะ/คืนเงินจาก process อื่น
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
// NEW: cancel (ยกเลิก+คืนเงิน) และ refill
// ─────────────────────────────────────────────────────────────
/**
 * Cancel เฉพาะกรณี:
 * 1) เป็นออเดอร์ของผู้เรียก
 * 2) status = processing และยัง "ไม่เริ่ม" (isNotStarted)
 * 3) service.cancel = true (รองรับ child service)
 * - ยกเลิกที่ provider (ถ้ามี orderId)
 * - อัปเดต DB → status=canceled
 * - คืนเงินทันที (ใช้ estCost || cost || calcCost)
 */
router.post('/api/orders/:id/cancel', async (req, res) => {
  try {
    const me = req.session?.user || req.user;
    const userId = String(me?._id || '');
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const o = await Order.findById(req.params.id);
    if (!o) return res.status(404).json({ error: 'not found' });
    if (String(o.user) !== userId && String(o.userId) !== userId) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (!o.providerOrderId) {
      return res.status(400).json({ error: 'ไม่มีหมายเลขออเดอร์ของผู้ให้บริการ จึงยกเลิกไม่ได้' });
    }

    const svc = await Service.findById(o.service).lean();
    const { cancel } = getServiceFlags(svc, o.providerServiceId);
    if (!cancel) return res.status(400).json({ error: 'บริการนี้ไม่รองรับการยกเลิก' });

    // 1) ต้องยกเลิกที่ผู้ให้บริการให้สำเร็จ (adapter ยิง /cancels แล้ว)
    let cancelResp;
    try {
      cancelResp = await providerCancelOrder(o.providerOrderId); // ตอนนี้ยิง /cancels แล้ว
    } catch (e) {
      console.error('Provider cancel failed:', e?.response?.data || e.message);
      return res.status(502).json({
        error: 'ผู้ให้บริการปฏิเสธการยกเลิก',
        detail: e?.response?.data || e.message
      });
    }

    // 2) ดึงสถานะล่าสุด (เพื่อคิดสัดส่วน)
    try {
      const s = await getOrderStatus(o.providerOrderId);
      o.startCount   = toNum(s.start_count ?? s.startCount)   ?? o.startCount;
      o.currentCount = toNum(s.current_count ?? s.currentCount) ?? o.currentCount;
      o.remains      = toNum(s.remains) ?? o.remains;
      o.progress     = toNum(s.progress) ?? o.progress;
    } catch {/* ถ้าดึงไม่ได้ก็ใช้ข้อมูลที่มี */}

    // 3) คำนวณคืนเงิน
    const est = nz(o.estCost ?? o.cost ?? calcCost(o.quantity, o.rateAtOrder));
    const donePct = computeDonePct(o);              // 0..100
    const leftRatio = Math.max(0, Math.min(1, 1 - (donePct / 100))); // ส่วนที่ยังไม่ได้ทำ
    const refund = Math.round((est * leftRatio) * 100) / 100;        // ปัด 2 ตำแหน่ง
    const refundType = (leftRatio >= 0.999) ? 'full' : (leftRatio <= 0.001 ? 'none' : 'partial');

    // อัปเดตออเดอร์
    o.status = 'canceled';
    o.canceledAt = new Date();
    o.lastCancelId = cancelResp?.cancelId || null;
    o.refundAmount = refund;
    o.refundType = refundType;
    await o.save();

    // 4) คืนเงินจริง (เฉพาะ > 0)
    if (refund > 0) {
      await User.updateOne({ _id: userId }, { $inc: { balance: refund } });
    }
    setTimeout(() => recalcUserTotalSpent(o.userId || o.user).catch(()=>{}), 0);

    return res.json({
      ok: true,
      refundAmount: refund,
      refundType,
      orderId: String(o._id),
      providerOrderId: o.providerOrderId,
      cancelId: cancelResp?.cancelId || null
    });
  } catch (err) {
    console.error('POST /api/orders/:id/cancel error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/**
 * Refill เฉพาะกรณี:
 * 1) เป็นออเดอร์ของผู้เรียก
 * 2) service.refill = true
 * 3) มี providerOrderId
 * 4) โดยทั่วไปจะยอมให้ refill หลัง "เสร็จสิ้น" หรือ "บางส่วน" (แล้วแต่นโยบาย)
 */
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

    // (นโยบาย: ยอมให้ refill เมื่อ done หรือ partial)
    const st = String(o.status || '').toLowerCase();
    if (!(st === 'completed' || st === 'partial')) {
      return res.status(400).json({ error: 'สถานะปัจจุบันไม่รองรับการเติมคืน' });
    }

    // ยิง refill ไป provider
    let resp = null;
    try {
      resp = await providerRequestRefill(o.providerOrderId);
    } catch (e) {
      console.error('Provider refill failed:', e?.response?.data || e.message);
      return res.status(502).json({ error: 'ผู้ให้บริการปฏิเสธการเติมคืน', detail: e?.response?.data || e.message });
    }

    // บันทึกว่าเคย refill
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

export default router;
