// src/routes/otp24.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { Otp24Product } from '../models/Otp24Product.js';
import { Otp24Order } from '../models/Otp24Order.js';
import { User } from '../models/User.js';
import { buyOtp, getOtpStatus, OTP24_COUNTRIES, buyOtpAgain } from '../lib/otp24Adapter.js';
import { refreshOtp24BalanceAsync } from '../lib/otp24BalanceUtil.js';

const router = Router();
const ACTIVE_STATUSES = ['processing','pending','waiting','purchased'];

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

function round2(n){ return Math.round((Number(n)||0)*100)/100; }


// GET /otp24 — หน้าแสดงบริการ + ประวัติในหน้าเดียว
router.get('/', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  const filter = { provider: 'otp24' };
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { name: { $regex: safe, $options: 'i' } },
      { code: { $regex: safe, $options: 'i' } },
    ];
  }
  const items = await Otp24Product.find(filter).sort({ name: 1 }).lean();

  const products = items.map(p => ({
    _id: String(p._id),
    name: p.name,
    icon: p.raw?.img || null,
    code: p.raw?.type || p.extId || p.code, // โค้ดสั้นของผู้ให้บริการ
    base: Number(p.basePrice || p.price || 0),
    price: Math.round((Number(p.basePrice || p.price || 0) * 1.5) * 100) / 100,
  }));

  const orders = await Otp24Order.find({ user: req.user?._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  res.render('otp24/index', {
    title: 'RTSMM-TH | บริการ OTP',
    products,
    countries: OTP24_COUNTRIES,
    q,
    orders,
    COUNTDOWN_ENABLED: false,
  });
});

// POST /otp24/buy — ซื้อทันที
router.post('/buy', requireAuth, async (req, res) => {
  try {
    const { productId, countryId } = req.body || {};
    if (!productId || !countryId) {
      return res.status(400).json({ ok: false, error: 'ข้อมูลไม่ครบ' });
    }

    const prod = await Otp24Product.findById(productId).lean();
    if (!prod) return res.status(404).json({ ok: false, error: 'ไม่พบบริการ' });

    // โค้ด type ที่ OTP24 ต้องการ (สั้น ๆ เช่น "go")
    const serviceCode = prod?.raw?.type || prod?.extId || prod?.code;
    if (!serviceCode) {
      return res.status(400).json({ ok: false, error: 'บริการนี้ยังไม่มีรหัส type' });
    }

    const providerPrice = Number(prod.basePrice || prod.price || 0);
    const salePrice = round2(providerPrice * 1.5);

    const user = await User.findById(req.user?._id);
    if (!user) return res.status(401).json({ ok: false, error: 'ต้องเข้าสู่ระบบ' });
    if ((user.balance || 0) < salePrice) {
      return res.status(400).json({ ok: false, error: 'ยอดเงินไม่พอ' });
    }

    // หักเงินก่อน
    user.balance = round2(Number(user.balance) - salePrice);
    await user.save();

    // ยิงซื้อกับผู้ให้บริการ
    const r = await buyOtp({ type: serviceCode, ct: Number(countryId) });

    if (!r?.ok) {
      // ซื้อไม่สำเร็จ → คืนเงินทันที (rollback เท่านั้น, ไม่ใช่ระบบคืนเครดิตหลังการซื้อ)
      // user.balance = round2(Number(user.balance || 0) + salePrice);
      // await user.save();
      return res
        .status(502)
        .json({ ok: false, error: r?.error || 'ซื้อไม่สำเร็จ', raw: r?.rawText || r?.raw });
    }

    // บันทึกออเดอร์ (ตั้งเวลาหมดเขต 10 นาที)
    const now = Date.now();
    const createdAt = new Date(now);
    const ord = await Otp24Order.create({
      user: user._id,
      productId: prod._id,
      appName: prod.name,
      serviceCode,
      countryId: Number(countryId),
      providerPrice,
      salePrice,
      orderId: r.orderId,
      phone: r.phone || undefined,
      status: 'processing',
      createdAt,
      message: 'ระบบกำลังรอ OTP…',
    });

    refreshOtp24BalanceAsync();

    return res.json({ ok: true, orderId: ord.orderId, redirect: '/otp24?tab=orders' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'internal error' });
  }
});

router.post('/buy-again', requireAuth, async (req, res) => {
  try {
    const { orderId, preview } = req.body || {};
    if (!orderId) return res.status(400).json({ ok:false, error:'ข้อมูลไม่ครบ' });

    // 1) หาออเดอร์เดิม (ต้อง success เท่านั้น)
    const old = await Otp24Order.findOne({ orderId, user:req.user?._id }).lean();
    if (!old) {
      return res.status(404).json({ ok:false, code:'NOT_FOUND', error:'ไม่พบคำสั่งซื้อเดิม' });
    }
    if (String(old.status).toLowerCase() !== 'success') {
      return res.status(400).json({ ok:false, code:'NOT_SUCCESS', error:'ซื้อเบอร์เดิมได้เฉพาะออเดอร์ที่สำเร็จเท่านั้น' });
    }

    // 2) กันออเดอร์ซ้ำที่ยัง active อยู่
    const activeExists = await Otp24Order.exists({
      user: req.user._id,
      phone: old.phone,
      status: { $in: ACTIVE_STATUSES }
    });
    if (activeExists) {
      return res.status(409).json({
        ok:false, code:'ACTIVE_ORDER', active:true,
        error:'เบอร์ของคุณยังอยู่ในสถานะกำลังทำงานอยู่'
      });
    }

    // 3) (ถ้ามี) ตรวจ reuse ได้ไหม
    let reusable = true;
    if (typeof canReuse === 'function') {
      try { reusable = await canReuse({ orderId }); }
      catch { reusable = null; } // provider งอแง → unknown
    }
    if (reusable === false) {
      return res.status(410).json({ ok:false, code:'REMOVED', error:'เบอร์นี้ถูกนำออกจากระบบไปแล้ว' });
    }

    // 4) คำนวณราคา (จาก provider เดิม +70%)
    const providerPrice = Number(old.providerPrice || 0);
    const salePrice = round2(providerPrice * 2.7);

    // 5) โหมดพรีวิว
    if (preview) {
      return res.json({
        ok:true,
        preview: {
          appName:   old.appName,
          phone:     old.phone,
          countryId: old.countryId,
          price:     salePrice
        }
      });
    }

    // 6) ตัดเงินก่อน
    const user = await User.findById(req.user?._id);
    if (!user) return res.status(401).json({ ok:false, error:'ต้องเข้าสู่ระบบ' });
    if ((user.balance || 0) < salePrice) {
      return res.status(400).json({ ok:false, code:'NO_MONEY', error:'ยอดเงินไม่พอ' });
    }
    user.balance = round2(Number(user.balance) - salePrice);
    await user.save();

    // 7) เรียกซื้อซ้ำจากผู้ให้บริการ
    let r;
    try {
      r = await buyOtpAgain({ orderId }); // { ok, status, msg, id, order_id, number, ... }
    } catch (e) {
      // provider ล่ม → คืนแล้วจบ (ไม่สร้างออเดอร์ใหม่)
      user.balance = round2(Number(user.balance) + salePrice);
      await user.save();
      return res.status(502).json({
        ok:false, code:'PROVIDER_DOWN',
        error:'ระบบผู้ให้บริการขัดข้อง กรุณาลองใหม่',
        raw:String(e?.message||e)
      });
    }

    const statusStr = String(r?.status || '').toLowerCase();
    const successProvider = r?.ok && statusStr === 'success';

    // 8) ถ้าผู้ให้บริการ “ไม่ success” → คืนทันทีที่นี่ แล้วจบ
    if (!successProvider) {
      const providerMsg = (r && (r.msg || r.message)) || '';
      const removedLike = /not\s*available|removed|cannot\s*reuse|not\s*reusable|invalid/i.test(providerMsg);

      user.balance = round2(Number(user.balance) + salePrice);
      await user.save();

      return res.status(removedLike ? 410 : 502).json({
        ok:false,
        code: removedLike ? 'REMOVED' : 'PROVIDER_ERROR',
        error: removedLike ? 'เบอร์นี้ถูกนำออกจากระบบไปแล้ว' : (providerMsg || 'สั่งซื้อไม่สำเร็จ'),
        raw:r
      });
    }

    // 9) ผู้ให้บริการ success → สร้างออเดอร์ใหม่ (ตั้ง 10 นาทีจาก "ตอนนี้")
    const now = Date.now();
    const createdAt = new Date(now);

    const ord = await Otp24Order.create({
      user: user._id,
      productId: old.productId,
      appName: old.appName,
      serviceCode: old.serviceCode,
      countryId: old.countryId,
      providerPrice,
      salePrice,
      orderId: r.order_id || r.id,
      phone: r.number || old.phone,
      status: 'processing',
      createdAt,
      message: 'ระบบกำลังรอ OTP… (เบอร์เดิม)'
    });

    try { refreshOtp24BalanceAsync?.(); } catch {}

    return res.json({ ok:true, orderId: ord.orderId, redirect:'/otp24?tab=orders' });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || 'internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// (แถม) GET /otp24/buy-again/preview?orderId=...
// ใช้ลอจิกเดียวกับ POST แต่เป็นการเช็คอย่างเดียว
// ─────────────────────────────────────────────────────────────
router.get('/buy-again/preview', requireAuth, async (req, res) => {
  try {
    const { orderId } = req.query || {};
    if (!orderId) return res.status(400).json({ ok:false, error:'ข้อมูลไม่ครบ' });

    const old = await Otp24Order.findOne({ orderId, user:req.user?._id }).lean();
    if (!old) return res.status(404).json({ ok:false, code:'NOT_FOUND', error:'ไม่พบคำสั่งซื้อเดิม' });
    if (String(old.status).toLowerCase() !== 'success') {
      return res.status(400).json({ ok:false, code:'NOT_SUCCESS', error:'ซื้อเบอร์เดิมได้เฉพาะออเดอร์ที่สำเร็จเท่านั้น' });
    }

    const activeExists = await Otp24Order.exists({
      user: req.user._id,
      phone: old.phone,
      status: { $in: ACTIVE_STATUSES }
    });
    if (activeExists) {
      return res.status(409).json({
        ok:false,
        code:'ACTIVE_ORDER',
        active:true,
        error:'เบอร์ของคุณยังอยู่ในสถานะกำลังทำงานอยู่'
      });
    }

    let reusable = true;
    if (typeof canReuse === 'function') {
      try { reusable = await canReuse({ orderId }); } catch { reusable = null; }
    }
    if (reusable === false) {
      return res.status(410).json({ ok:false, code:'REMOVED', error:'เบอร์นี้ถูกนำออกจากระบบไปแล้ว' });
    }

    const providerPrice = Number(old.providerPrice || 0);
    const salePrice = round2(providerPrice * 2.7);

    return res.json({
      ok:true,
      preview:{
        appName:   old.appName,
        phone:     old.phone,
        countryId: old.countryId,
        price:     salePrice
      }
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'internal error' });
  }
});

// รีเฟรชสถานะ (ปิดการคืนเครดิต: เปลี่ยนเป็น timeout/failed เฉย ๆ)
router.post('/orders/:orderId/refresh', requireAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const ord = await Otp24Order.findOne({ orderId, user: req.user?._id });
    if (!ord) return res.status(404).json({ ok: false, error: 'ไม่พบคำสั่งซื้อ' });

    // ดึงสถานะล่าสุดจากผู้ให้บริการเมื่อยัง processing
    if (ord.status === 'processing') {
      const r = await getOtpStatus(orderId).catch(() => null);

      if (r?.ok) {
        // 1) OTP ได้แล้ว
        if (r.otp && !ord.otp) {
          ord.otp = String(r.otp);
          // ส่วนใหญ่แปลว่าเสร็จสิ้น
          if (!['refunded', 'failed', 'timeout'].includes(String(r.status || '').toLowerCase())) {
            ord.status = 'success';
          }
          ord.message = 'ได้รับ OTP แล้ว';
          ord.completedAt = new Date();
        }

        // 2) ปรับสถานะตามผู้ให้บริการ (กันเคสคืนเงิน/หมดเวลา)
        if (r.status && r.status !== ord.status) {
          ord.status = String(r.status).toLowerCase();  // e.g. processing/success/refunded/failed/timeout
        }

        // 3) อัปเดตเบอร์/ข้อความถ้ามี
        if (r.phone && !ord.phone) ord.phone = String(r.phone);
        if (r.msg && r.msg !== ord.message) ord.message = r.msg;

        await ord.save();
      }
    }

    return res.json({
      ok: true,
      patch: {
        orderId: ord.orderId,
        status: ord.status,
        otp: ord.otp || '',
        phone: ord.phone || '',
        message: ord.message || '',
        // expiresAt: ord.expiresAt ? ord.expiresAt.toISOString() : null
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'internal error' });
  }
});

export default router;
