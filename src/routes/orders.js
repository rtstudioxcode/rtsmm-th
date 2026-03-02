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
  cancelOrder as providerCancelOrder,
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
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const moneyRound = n => Math.round((Number(n) || 0) * 100) / 100;

/** คิดราคารวมตาม unit (หน่วย/step)
 * - unit <= 1  → คิดแบบต่อชิ้น: cost = qty * rate
 * - unit > 1   → คิดแบบเป็นก้อนต่อ unit: cost = (qty / unit) * rate
 */
const calcCostByUnit = (qty, rate, unit) => {
  const q = nz(qty), r = nz(rate), u = Math.max(1, nz(unit));
  const cost = (u <= 1) ? (q * r) : ((q / u) * r);
  return cost < 0 ? 0 : cost;
};

// ใช้ map สถานะไทย (ใช้ซ้ำ)
const mapTH = (x='') => ({
  processing: 'รอดำเนินการ',
  pending: 'รอดำเนินการ',
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
  let refill = !!serviceDoc.refill;
  let cancel = !!serviceDoc.cancel;

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
    const agg = await UsageLog.aggregate([
      { $match: { orderId, type: 'refund' } },
      { $group: { _id: '$orderId', sum: { $sum: '$amount' } } }
    ]);
    already = Number(agg?.[0]?.sum || 0);
  } catch {}

  const delta = Math.max(0, amt - already);
  if (delta <= 0) return { refunded: 0, already, delta: 0 };

  let log = null;
  try {
    log = await UsageLog.create({
      userId, orderId, type: 'refund', amount: delta, currency, note: 'cancel/partial refund'
    });
  } catch (e) {
    if (e?.code === 11000) return { refunded: 0, already: amt, delta: 0 };
    throw e;
  }

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
  const cancelId = order?.meta?.cancelId || order?.cancelId;
  if (cancelId) {
    try {
      const r = await getCancelById(cancelId);
      if (r?.status === 'canceled' || r?.status === 'partial') {
        order.status = (r.status === 'canceled') ? 'canceled' : 'partial';
        if (r?.refundAmount != null) {
          order.refundAmount = Number(r.refundAmount) || 0;
          order.refundType   = (r.status === 'partial') ? 'partial' : 'full';
        }
        order.updatedAt = new Date();
        await order.save();
        await reconcileUserByOrderEvent(order, 'cancel_confirmed');
        return true;
      }
    } catch {}
  }

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
  } catch {}

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
  } catch {}

  return false;
}

const PERPAGE_DEFAULT = 20;
const PERPAGE_ALLOWED = [10, 20, 50, 100, 250, 500, 1000];

function clampPerPage(n) {
  const maxAllowed = Math.max(...PERPAGE_ALLOWED);
  return Math.min(n, maxAllowed);
}

// ===============================
// RATE UNIT CONFIG (LOCAL)
// ===============================
const DEFAULT_RATE_UNIT = 1000;

// override เฉพาะ service ที่ต้องการ
const RATE_UNIT_OVERRIDE = {
  // CANVA
  '27984': 1,'27985': 1,'25037': 1,
  '27984': 1,'27984': 1,'34559': 1,'25038': 1,
  // CHATGPT
  '30643': 1,
  // Disney+ 🔴 Amazon Prime 🔴 Youtube Premium
  '32729': 1,'32723': 1,'30140': 1,'30141': 1,
  '30900': 1,'25886': 1,'26734': 1,'27278': 1,
  '30182': 1,
  // License Key 🔑 Microsoft Office, Windows Key ✈️ บริการพิเศษจากเรา 📧 ใส่อีเมล์เพื่อสั่งซื้อ
  '30117': 1,'30116': 1,'30695': 1,'30119': 1,
  '30118': 1,'30696': 1,'30700': 1,'30697': 1,
  '30699': 1,'30698': 1,
  // License Key 🔑 Adobe, AutoDesk, Steam, Kaspersky, Grammarly, Duolingo, อื่นๆ 📧 ใส่อีเมล์เพื่อสั่งซื้อ
  '27740': 1,'32803': 1,'30111': 1,'30112': 1,'30120': 1,'30121': 1,
  '30109': 1,'30099': 1,'30100': 1,'30115': 1,'30101': 1,'30104': 1,
  '30105': 1,'30106': 1,'30107': 1,'30108': 1,'30113': 1,'30114': 1,'34769': 1,
  // ดาวน์โหลด ไฟล์ลิขสิทธิ์ 📷 ShutterStock, Freepik, Flaticon, Envato, SketchUp, AdobeStock, iStockPhoto, Motion Array
  '29989': 1,'29990': 1,'33144': 1,'29991': 1,'29992': 1,'29993': 1,'29994': 1,'29995': 1,
  '29996': 1,'29997': 1,'29998': 1,'29999': 1,'30000': 1,'30001': 1,'30002': 1,'30003': 1,
  '30004': 1,'30005': 1,'30006': 1,'30007': 1,'30008': 1,'30009': 1,'30010': 1,'30011': 1,
  '30012': 1,'30013': 1,'30014': 1,
  // Discord
  '35034': 1,'35035': 1,'35036': 1,'35037': 1,'35038': 1,'35039': 1,'35040': 1,
  '38515': 1,'38516': 1,'38517': 1,'38518': 1,'38519': 1,'38520': 1,'38521': 1,
  '29258': 1,'29259': 1,'29257': 1,'29256': 1,'29255': 1,'29254': 1,'29253': 1,
  '28270': 1,'28271': 1,'28272': 1,'28273': 1,'28274': 1,'28276': 1,'28275': 1,
  // Telegram
  '26429': 1,'26430': 1,'26431': 1,
  // Backlinks
  '27925': 1,'27926': 1,'27927': 1,'27928': 1,'27929': 1,'27930': 1,'27931': 1,'27932': 1,'27933': 1,'24265': 1,'20147': 1,
  '32959': 1,'32960': 1,'32961': 1,'32962': 1,
  // SEO
  '30816': 1,'30817': 1,'30818': 1,'30819': 1,'30820': 1,'30821': 1,'30822': 1,'30823': 1,'6351': 1,'6352': 1,'6353': 1,'6354': 1,'6355': 1,'6356': 1,
  // Capcut
  '33146': 1,
};

function getRateUnit(providerServiceId) {
  const key = String(providerServiceId || '');
  return RATE_UNIT_OVERRIDE[key] ?? DEFAULT_RATE_UNIT;
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

    // Comments & Keywords
    const bodyComments = (req.body.comments || '').trim();
    const bodyKeywords = (req.body.keywords || '').trim();

    if (!link || !quantity) {
      return res.status(400).json({ error: 'missing fields' });
    }

    // 0) Auth
    const me = req.session?.user || req.user;
    const userId = String(me?._id || '');
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    // 1) หา Service (เดี่ยว หรือ กลุ่ม + child)
    let baseDoc = null;
    let chosen = null;
    let providerIdForApi = null;

    if (serviceId) {
      baseDoc = await Service.findById(serviceId).lean();
      if (!baseDoc) return res.status(404).json({ error: 'service not found' });

      chosen = { ...baseDoc };
      providerIdForApi =
        baseDoc.providerServiceId ||
        baseDoc.providerServiceID ||
        baseDoc.id ||
        baseDoc.provider_id;

    } else if (groupId && providerServiceId) {
      baseDoc = await Service.findById(groupId).lean();
      if (!baseDoc) return res.status(404).json({ error: 'service group not found' });

      const children = Array.isArray(baseDoc?.details?.services)
        ? baseDoc.details.services
        : [];

      const child = children.find(c => String(c.id) === String(providerServiceId));
      if (!child) return res.status(404).json({ error: 'child service not found' });

      chosen = {
        ...child,
        _id: baseDoc._id,
        category: baseDoc.category,
        subcategory: baseDoc.subcategory,
        currency: child.currency || baseDoc.currency || 'THB',
        rate: nz(child.rate ?? baseDoc.rate),
        min: nz(child.min ?? baseDoc.min),
        max: nz(child.max ?? baseDoc.max),
        step: nz(child.step ?? baseDoc.step ?? 1),
        name: child.name || baseDoc.name
      };

      providerIdForApi = child.id;

    } else {
      return res.status(400).json({ error: 'missing fields' });
    }

    // 2) ตรวจ min/max/step
    if (!(quantity > 0)) return res.status(400).json({ error: 'จำนวนต้องมากกว่า 0' });
    if (chosen.min && quantity < chosen.min)
      return res.status(400).json({ error: `ขั้นต่ำ ${chosen.min}` });
    if (chosen.max && quantity > chosen.max)
      return res.status(400).json({ error: `สูงสุด ${chosen.max}` });

    const stepUnit = Math.max(1, nz(chosen.step)); // unit/step ที่ DB กำหนด
    if (quantity % stepUnit !== 0) {
      const fixed = Math.floor(quantity / stepUnit) * stepUnit;
      if (fixed < Math.max(1, nz(chosen.min))) {
        return res.status(400).json({ error: `ปริมาณต้องเป็นทวีคูณของ ${stepUnit}` });
      }
      quantity = fixed;
    }

    // 3) pricing + คิดราคา (single service)
    const baseRate = nz(chosen.rate);
    let effectiveRate = baseRate;
    const rateUnit = getRateUnit(providerIdForApi);

    try {
      const ex = await computeEffectiveRateEx({
        serviceId: chosen._id,
        userId: req.user._id,
        baseRate
      });
      effectiveRate = Number(ex.finalRate ?? baseRate);
    } catch {
      effectiveRate = baseRate; // fallback
    }

    // ✅ สูตรคิดเงินจริง (สำคัญ)
    // quantity / rateUnit * rate
    const cost = moneyRound(
      (quantity / rateUnit) * effectiveRate
    );

    const currency = chosen.currency || 'THB';

    // 4) ตัดเงิน
    const debited = await User.findOneAndUpdate(
      { _id: userId, balance: { $gte: cost } },
      { $inc: { balance: -cost } },
      { new: true, projection: { balance: 1 } }
    );
    if (!debited)
      return res.status(400).json({ error: 'ยอดเงินไม่พอ', need: cost, currency });

    // 5) เตรียม payload ส่ง Provider
    const providerPayload = {
      service_id: Number(providerIdForApi),
      link,
      quantity,
      ...(req.body?.dripfeed !== undefined ? { dripfeed: !!req.body.dripfeed } : {}),
      ...(req.body?.runs !== undefined ? { runs: Number(req.body.runs) } : {}),
      ...(req.body?.interval !== undefined ? { interval: String(req.body.interval) } : {})
    };

    // === รวม comments + keywords ===
    let combinedComments = null;
    if (bodyComments && bodyKeywords) {
      combinedComments = `${bodyComments} | ${bodyKeywords}`;
    } else if (bodyComments) {
      combinedComments = bodyComments;
    } else if (bodyKeywords) {
      combinedComments = bodyKeywords;
    }
    if (combinedComments) providerPayload.comments = combinedComments;

    // 6) ยิง Provider
    let providerResp;
    try {
      providerResp = await providerCreateOrder(providerPayload);
    } catch (e) {
      console.error('Provider order failed:', e?.response?.data || e.message);
      await User.updateOne({ _id: userId }, { $inc: { balance: cost } });
      return res.status(502).json({
        error: 'สั่งงานผู้ให้บริการไม่สำเร็จ',
        detail: e?.response?.data || e.message
      });
    }

    // 7) Normalize response และเตรียมข้อมูลบันทึก DB
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
      rateAtOrder: effectiveRate,
      rateUnitAtOrder: rateUnit,
      baseRateAtOrder: nz(chosen.rate),
      serviceName: chosen.name || baseDoc.name,
      status: 'processing',
      providerResponse: np.raw || providerResp || null,
      startCount: np.startCount ?? undefined,
      currentCount: np.currentCount ?? undefined,
      remains: np.remains ?? undefined,
      progress: np.progress ?? undefined,
      acceptedAt: np.acceptedAt || undefined,
      category: baseDoc.category,
      subcategory: baseDoc.subcategory
    };

    if (bodyComments) fields.comments = bodyComments;
    if (bodyKeywords) fields.keywords = bodyKeywords;

    if (
      fields.progress == null &&
      fields.startCount != null &&
      fields.currentCount != null &&
      quantity > 0
    ) {
      fields.progress = round2(
        Math.max(0, Math.min(100, ((fields.currentCount - fields.startCount) / quantity) * 100))
      );
    }

    // 8) บันทึก Order ลงฐานข้อมูล
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
        balance: debited.balance
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
    const {
      from,
      to,
      q = '',
      status = 'all',
    } = req.query || {};

    const find = { user: userId };

    if (from || to) {
      find.createdAt = {};
      if (from) find.createdAt.$gte = new Date(from + 'T00:00:00.000Z');
      if (to)   find.createdAt.$lte = new Date(to   + 'T23:59:59.999Z');
    }

    if (status && status !== 'all') {
      find.status = String(status).toLowerCase();
    }

    if (q && q.trim()) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx   = new RegExp(safe, 'i');
      find.$or = [
        { _id: q },
        { providerOrderId: q },
        { link: rx },
        { serviceName: rx },
      ];
    }

    const total = await Order.countDocuments(find);

    const PERPAGE_OPTIONS = [10,20,50,100,250,500,1000];
    const perPageRaw = String(req.query.perPage ?? '20').toLowerCase();

    let perPage;
    if (perPageRaw === 'all') {
      perPage = total || 1_000_000;
    } else {
      const n = Math.max(1, parseInt(perPageRaw,10) || 20);
      perPage = PERPAGE_OPTIONS.includes(n) ? n : 20;
    }

    const pages = Math.max(1, Math.ceil(total / Math.max(1, perPage)));
    let page    = Math.max(1, parseInt(req.query.page || '1', 10));
    if (page > pages) page = pages;

    const skip = (page - 1) * perPage;

    const list = await Order.find(find)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .lean();

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
      if (s === 'pending') return 'warn';
      if (s === 'inprogress') return 'blue';
      if (s === 'completed')  return 'ok';
      if (s === 'partial')    return 'violet';
      if (s === 'canceled')   return 'danger';
      return '';
    };
    const thStatus = (s = '') =>
      ({ processing:'รอดำเนินการ', pending:'รอดำเนินการ', inprogress:'กำลังทำ', completed:'เสร็จสิ้น', partial:'คืนบางส่วน', canceled:'ยกเลิก' }[String(s).toLowerCase()] || s);

    res.render('orders/history', {
      list: listWithSvc,
      from,
      to,
      q,
      status,
      pillClass,
      thStatus,
      title: 'ประวัติการใช้บริการ Social',
      bodyClass: 'orders-wide',
      syncError: req.flash?.('syncError')?.[0] || '',
      showMyOrdersNav: true,
      page,
      perPage,
      total
    });
  } catch (err) {
    next(err);
  }
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
      processing:'รอดำเนินการ', pending:'รอดำเนินการ', inprogress:'กำลังทำ', completed:'เสร็จสิ้น',
      partial:'ส่วนบางส่วน', canceled:'ยกเลิก', canceling:'กำลังยกเลิก'
    }[String(x).toLowerCase()] || x);

    if (String(o.status||'').toLowerCase() === 'canceling' && o.lastCancelId) {
      try {
        const c = await getCancelById(o.lastCancelId);
        const st = String(c.status || '').toLowerCase();

        if (/^(canceled|cancelled|success|ok|accepted|done|finished|completed)$/.test(st)) {
          const est0 = nz(o.estCost ?? o.cost);
          const est  = Math.max(0, Number(est0) || 0);
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
      } catch (e) {
        console.warn('check cancel status failed:', e?.response?.data || e.message);
      }
    }

    if (!o.providerOrderId) {
      return res.json({ ok: true, status: o.status || 'processing' });
    }

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

    const prevStatus = o.status; 
    Object.assign(o, upd);   
    await o.save();
    setTimeout(() => reconcileUserByOrderEvent(o._id).catch(()=>{}), 0);

    if (st === 'canceled' && prevStatus !== 'canceled') {
      const est0 = nz(o.estCost ?? o.cost);
      const est  = Math.max(0, Number(est0) || 0);
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
        await o.save();
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

    const list = await Order.find({
      user: userId,
      status: { $in: ['processing', 'pending', 'inprogress', 'partial', 'canceling'] }
    }).sort({ createdAt: -1 }).limit(300);

    let updated = 0;
    const changes = [];

    const canceling = list.filter(o =>
      String(o.status).toLowerCase() === 'canceling' && o.lastCancelId
    );
    const cancelIds = canceling.map(o => String(o.lastCancelId));

    let cancelMap = {};
    if (cancelIds.length) {
      try {
        const arr = await findCancelsByIds(cancelIds);
        cancelMap = Object.fromEntries(arr
          .filter(x => x && x.id)
          .map(x => [String(x.id), x]));
      } catch (e) {
        console.warn('findCancelsByIds failed:', e?.response?.data || e.message);
      }
    }

    for (const o of list) {
      const curSt = String(o.status || '').toLowerCase();

      if (curSt === 'canceling' && o.lastCancelId) {
        const c = cancelMap[String(o.lastCancelId)];
        if (c) {
          const st = String(c.status || '').toLowerCase();
          if (/^(canceled|cancelled|success|ok|accepted|done|finished|completed)$/.test(st)) {
            const est0 = nz(o.estCost ?? o.cost);
            const est  = Math.max(0, Number(est0) || 0);
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
        continue;
      }

      if (!o.providerOrderId) continue;

      try {
        const s  = await getOrderStatus(o.providerOrderId);
        let st   = String(s.status || o.status || 'processing').toLowerCase();

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
        // เงียบไว้
      }
    }

    setTimeout(() => recalcUserTotals(userId, { force: true }).catch(() => {}), 0);

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

    let cancelId = null;
    if (ord.providerOrderId) {
      try {
        const resp = await providerCancelOrder(ord.providerOrderId);
        cancelId = resp?.cancelId ?? null;
      } catch (e) {
        const msg = e?.response?.data?.error || e?.response?.data?.message || e.message || 'cancel denied by provider';
        return res.status(400).json({ ok:false, error: msg });
      }
    }

    ord.status = 'canceling';
    ord.cancelInfo = {
      providerCancelId: cancelId || null,
      requestedAt: new Date(),
      providerStatus: cancelId ? 'pending' : 'requested',
    };
    ord.lastCancelId = cancelId || ord.lastCancelId || null;

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

router.post('/orders/:id/cancel/refresh', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const me = req.user || req.session?.user;

    const ord = await Order.findById(id).exec();
    if (!ord) return res.status(404).json({ ok:false, error:'ไม่พบออเดอร์' });

    const isOwner = String(ord.user) === String(me?._id || '');
    const isAdmin = me?.role === 'admin';
    if (!(isOwner || isAdmin)) return res.status(403).json({ ok:false, error:'forbidden' });

    if (String(ord.status||'').toLowerCase() === 'canceled') {
      return res.json({ ok:true, updated:false, providerStatus: ord.cancelInfo?.providerStatus || 'done' });
    }

    const cancelId = ord?.cancelInfo?.providerCancelId || ord?.lastCancelId || null;
    if (!cancelId) {
      return res.status(400).json({ ok:false, error:'ยังไม่เคยส่งคำขอยกเลิก' });
    }

    ord.cancelInfo = ord.cancelInfo || { providerCancelId: cancelId, requestedAt: ord.createdAt || new Date() };

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
      ord.cancelInfo.providerStatus = provStatus || 'pending';
      if (String(ord.status||'').toLowerCase() !== 'canceling') ord.status = 'canceling';
      await ord.save();
      return res.json({ ok:true, updated:false, providerStatus: provStatus || 'pending' });
    }

    const est0   = nz(ord.estCost ?? ord.cost);
    const est    = Math.max(0, Number(est0) || 0);
    const donePct   = computeDonePct(ord);
    const leftRatio = Math.max(0, Math.min(1, 1 - (donePct/100)));
    const computed  = round2(est * leftRatio);

    let shouldRefund = Number.isFinite(+c?.amount) ? +c.amount : computed;
    shouldRefund = Math.max(0, Math.min(shouldRefund, est));

    let finalStatus = 'canceled';
    if (shouldRefund > 0 && shouldRefund < est) finalStatus = 'partial';

    const { delta } = await refundIdempotent({
      userId: ord.user,
      orderId: ord._id,
      currency: ord.currency || 'THB',
      amount: shouldRefund
    });

    ord.status = finalStatus;
    ord.canceledAt = new Date();
    ord.refundAmount = shouldRefund;
    ord.refundType = (shouldRefund >= est - 1e-6) ? 'full' : (shouldRefund > 0 ? 'partial' : null);
    ord.cancelInfo.providerStatus = provStatus || 'done';
    ord.cancelInfo.confirmedAt = new Date();
    await ord.save();

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
 */
router.post('/orders/:id/cancel/await', async (req, res) => {
  const { id } = req.params;

  const PER_REQUEST_WAIT = 30_000;
  const start = Date.now();
  let order = await Order.findById(id);
  if (!order) return res.status(404).json({ ok:false, error:'ไม่พบออเดอร์' });

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

  const interval = 3_000;
  while (Date.now() - start < PER_REQUEST_WAIT) {
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

  return res.json({ ok:true, updated:false, keepWaiting:true });
});

router.get('/api/orders/:id/local-status', async (req, res) => {
  try {
    const { id } = req.params;

    const query = { _id: id };
    if (req.user?.role !== 'admin') {
      query.user = req.user._id;
    }

    const o = await Order.findOne(query)
      .select('_id status progress remains startCount currentCount updatedAt createdAt refundAmount refundType');

    if (!o) {
      return res.status(404).json({ error: 'Order not found' });
    }

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
