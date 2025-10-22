// routes/orders.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { Order } from '../models/order.js';
import { Service } from '../models/Service.js';
import { User } from '../models/User.js';
import { computePrice } from '../lib/pricing.js';
import { createOrder as providerCreateOrder, getOrderStatus } from '../lib/iplusviewAdapter.js';

const router = Router();
router.use(requireAuth);

// helper
const toNum = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const nz = v => (Number.isFinite(v) ? v : 0);
const calcCost = (q, rate) => Math.max(0, (nz(q) / 1000) * nz(rate));

// ใช้รวมผลตอบกลับของ provider ให้เป็น format เดียวกับสคีมาเรา
function normalizeProviderFields(resp) {
  const r = resp || {};
  return {
    providerOrderId:
      r.providerOrderId ?? r.order_id ?? r.orderId ?? r.id ?? null,
    startCount:    toNum(r.start_count ?? r.startCount),
    currentCount:  toNum(r.current_count ?? r.currentCount),
    remains:       toNum(r.remains),
    progress:      toNum(r.progress), // 0..100 (ถ้ามี)
    acceptedAt:    r.accepted_at ? new Date(r.accepted_at) : (r.acceptedAt ? new Date(r.acceptedAt) : null),
    raw:           r,                 // เก็บดิบไว้ debug
  };
}

router.get('/my/order', (req, res) => res.redirect(301, '/my/orders'));
router.get('/orders/history', (req, res) => res.redirect(302, '/my/orders'));

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

    // 3) คิดราคา (รองรับกฎเพิ่มเติม)
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

    // 5) สร้างงานกับ provider
    const serviceIdForProvider = Number(providerIdForApi);
    const providerPayload = {
      service_id: serviceIdForProvider,
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

    // 6) เซฟออเดอร์ (🆕 เก็บค่าละเอียดจาก provider)
    const np = normalizeProviderFields(providerResp);
    const fields = {
      user: userId,                        // เผื่อสคีมาเดิม
      userId,                              // สคีมาใหม่ require
      service: baseDoc._id,
      providerServiceId: providerIdForApi,
      providerOrderId: np.providerOrderId,
      link,
      quantity,
      cost,
      estCost: cost,                       // เผื่อ template เดิมอ้าง estCost
      currency,
      rateAtOrder: rate,
      status: 'processing',
      providerResponse: np.raw || providerResp || null,
      // 🆕 ฟิลด์ละเอียด
      startCount:   np.startCount,
      currentCount: np.currentCount,
      remains:      np.remains,
      progress:     np.progress,
      acceptedAt:   np.acceptedAt,
    };

    // ถ้า provider ไม่ให้ progress แต่ให้ start/current → คิดให้
    if (fields.progress == null && fields.startCount != null && fields.currentCount != null && quantity > 0) {
      fields.progress = Math.max(0, Math.min(100, ((fields.currentCount - fields.startCount) / quantity) * 100));
    }

    try {
      const order = await Order.create(fields);
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

/** รายการของฉัน (เหมือนเดิม) */
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
          .select('name rate currency providerServiceId')
          .lean()
      : [];
    const svcMap = Object.fromEntries(services.map(s => [String(s._id), s]));

    const listWithSvc = list.map(o => ({ ...o, service: svcMap[String(o.service)] || null }));

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
      ({
        processing: 'รอดำเนินการ',
        inprogress: 'กำลังทำ',
        completed:  'เสร็จสิ้น',
        partial:    'บางส่วน',
        canceled:   'ยกเลิก',
      }[String(s).toLowerCase()] || s);

    res.render('orders/history', {
      list: listWithSvc,
      from, to, q,
      pillClass, thStatus,
      title: 'ประวัติ ออเดอร์',
      bodyClass: 'orders-wide',
      syncError: req.flash?.('syncError')?.[0] || '',
    });
  } catch (err) {
    next(err);
  }
});

/** ดึงสถานะล่าสุดของออเดอร์เดียว */
router.get('/orders/:id/status', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'not found' });

    if (!order.providerOrderId) {
      return res.json({ ok: true, status: order.status });
    }

    const s = await getOrderStatus(order.providerOrderId);
    const st = String(s.status || order.status || 'processing').toLowerCase();

    // 🆕 อัปเดตฟิลด์ละเอียดจากสถานะ
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

    // ถ้า progress ไม่มีแต่มี start/current → คิดให้
    if (u.progress == null && u.startCount != null && u.currentCount != null && order.quantity > 0) {
      u.progress = Math.max(0, Math.min(100, ((u.currentCount - u.startCount) / order.quantity) * 100));
    }

    Object.assign(order, u);
    await order.save();

    return res.json({ ok: true, status: order.status, provider: s });
  } catch (err) {
    console.error('GET /orders/:id/status error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/** รีเฟรชสถานะออเดอร์เดียว (หน้า EJS เรียก /api/orders/:id/refresh) */
router.post('/api/orders/:id/refresh', async (req, res) => {
  try {
    const o = await Order.findById(req.params.id);
    if (!o) return res.status(404).json({ error: 'not found' });

    if (!o.providerOrderId) {
      return res.json({ ok: true, status: o.status || 'processing' });
    }

    const s = await getOrderStatus(o.providerOrderId);
    const st = String(s.status || o.status || 'processing').toLowerCase();

    const upd = {
      status: st,
      startCount:   toNum(s.start_count ?? s.startCount)   ?? o.startCount,
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

    Object.assign(o, upd);
    await o.save();

    const mapTH = (x='') => ({
      processing: 'รอดำเนินการ',
      inprogress: 'กำลังทำ',
      completed:  'เสร็จสิ้น',
      partial:    'บางส่วน',
      canceled:   'ยกเลิก',
    }[String(x).toLowerCase()] || x);

    return res.json({ ok: true, status: o.status, status_th: mapTH(o.status) });
  } catch (err) {
    console.error('POST /api/orders/:id/refresh error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

/** รีเฟรชสถานะทั้งหมดของผู้ใช้ */
router.post('/api/orders/refresh-all', async (req, res) => {
  try {
    const me = req.session?.user || req.user;
    const userId = String(me?._id || '');
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const list = await Order.find({ user: userId }).sort({ createdAt: -1 }).limit(200);
    let updated = 0;
    const changes = [];

    for (const o of list) {
      if (!o.providerOrderId) continue;
      try {
        const s = await getOrderStatus(o.providerOrderId);
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

        Object.assign(o, upd);
        await o.save();

        const changed =
          before.status !== o.status ||
          before.startCount !== o.startCount ||
          before.currentCount !== o.currentCount ||
          before.remains !== o.remains ||
          before.progress !== o.progress;

        if (changed) {
          updated++;
          // ส่ง payload ที่ฝั่ง client ใช้ render ได้ทันที
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
    return res.json({ ok: true, updated, changes });
  } catch (err) {
    console.error('POST /api/orders/refresh-all error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

export default router;
