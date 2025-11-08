// src/routes/otp24.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { Otp24Product } from '../models/Otp24Product.js';
import { Otp24Order } from '../models/Otp24Order.js';
import { User } from '../models/User.js';
import { buyOtp, getOtpStatus, OTP24_COUNTRIES } from '../lib/otp24Adapter.js';

const router = Router();
const round2 = n => Math.round(Number(n || 0) * 100) / 100;

/**
 * คำนวณจำนวนเงินที่จะคืน
 * - ถ้า ord.salePrice เป็นตัวเลข → คืนตามนั้น
 * - ถ้าไม่มีก็ไปดูราคาขายจริงใน Product (basePrice > price)
 * - ปัดทศนิยม 2 ตำแหน่ง
 */
async function calcRefund(ordLike) {
  const sale = Number(ordLike?.salePrice);
  if (Number.isFinite(sale)) return round2(sale);

  const pid = ordLike?.productId;
  if (pid) {
    const prod = await Otp24Product.findById(pid).lean();
    if (prod) {
      const p = Number(prod.basePrice ?? prod.price ?? 0);
      if (Number.isFinite(p)) return round2(p);
    }
  }
  return 0;
}

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
      // ซื้อไม่สำเร็จ → คืนเงินตามราคาที่ตัดจริง (อย่าอ้าง ord ก่อนสร้าง)
      user.balance = round2(Number(user.balance || 0) + salePrice);
      await user.save();
      return res
        .status(502)
        .json({ ok: false, error: r?.error || 'ซื้อไม่สำเร็จ', raw: r?.rawText || r?.raw });
    }

    // บันทึกออเดอร์ (ตั้งเวลาหมดเขต 10 นาที)
    const TEN_MIN = 10 * 60 * 1000;
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
      expiresAt: new Date(Date.now() + TEN_MIN),
      message: 'ระบบกำลังรอ OTP…',
    });

    return res.json({ ok: true, orderId: ord.orderId, redirect: '/otp24?tab=orders' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'internal error' });
  }
});

// รีเฟรชสถานะ + คืนเงินอัตโนมัติเมื่อครบ 10 นาที
router.post('/orders/:orderId/refresh', requireAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const ord = await Otp24Order.findOne({ orderId, user: req.user?._id });
    if (!ord) return res.status(404).json({ ok: false, error: 'ไม่พบคำสั่งซื้อ' });

    // ยังไม่หมดเวลา → ลองเช็คกับผู้ให้บริการ
    if (ord.status === 'processing') {
      const r = await getOtpStatus(orderId);
      if (r?.ok) {
        const st = String(r.status || '').toLowerCase();
        if (st.includes('success') && r.otp) {
          ord.status = 'success';
          ord.otp = r.otp;
          ord.message = r.msg || 'ได้รับ OTP แล้ว';
          await ord.save();
        } else if (st.includes('timeout')) {
          ord.status = 'timeout';
          ord.message = r.msg || 'หมดเวลา';
          await ord.save();
        } else if (st.includes('failed')) {
          ord.status = 'failed';
          ord.message = r.msg || 'ล้มเหลว';
          await ord.save();
        } else {
          ord.message = r.msg || 'กำลังรอ OTP…';
          await ord.save();
        }
      }
    }

    // หมดเวลาแล้วและยังไม่สำเร็จ → คืนเครดิตตามกติกาเดียวกันทุกที่
    if (ord.status === 'processing' && ord.expiresAt && ord.expiresAt.getTime() <= Date.now()) {
      const user = await User.findById(ord.user);
      if (user) {
        const refund = await calcRefund(ord);
        user.balance = round2(Number(user.balance || 0) + refund);
        await user.save();
      }
      ord.status = 'refunded';
      ord.refundedAt = new Date();
      ord.refundNote = 'ไม่ได้รับ OTP ใน 10 นาที ระบบคืนเครดิตอัตโนมัติ';
      ord.message = 'คืนเครดิตแล้ว';
      await ord.save();
    }

    return res.json({
      ok: true,
      patch: {
        orderId: ord.orderId,
        status: ord.status,
        otp: ord.otp || '',
        message: ord.message || '',
        phone: ord.phone || '',
        expiresAt: ord.expiresAt ? ord.expiresAt.toISOString() : null,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'internal error' });
  }
});

// (ออปชัน) รีเฟรชสถานะออเดอร์ทั้งหมด (งานที่ยัง processing)
router.post('/orders/refresh-all', requireAuth, async (req, res) => {
  const orders = await Otp24Order.find({
    user: req.user?._id,
    status: 'processing',
  }).limit(100);

  const changes = [];
  const now = Date.now();

  for (const ord of orders) {
    try {
      // หมดเวลาแล้ว → คืนเครดิต
      if (ord.expiresAt && ord.expiresAt.getTime() <= now) {
        const user = await User.findById(ord.user);
        if (user && !ord.refundedAt) {
          const refund = await calcRefund(ord);
          user.balance = round2(Number(user.balance || 0) + refund);
          await user.save();
        }
        ord.status = 'refunded';
        ord.refundedAt = ord.refundedAt || new Date();
        ord.message = ord.message || 'ไม่ได้รับ OTP ใน 10 นาที ระบบคืนเครดิตอัตโนมัติ';
        await ord.save();
        changes.push({
          orderId: ord.orderId,
          status: 'refunded',
          otp: ord.otp || '',
          phone: ord.phone || '',
          message: ord.message || '',
        });
        continue;
      }

      // ยังไม่หมดเวลา → เช็คผู้ให้บริการ
      const r = await getOtpStatus(ord.orderId);
      if (!r?.ok) {
        changes.push({
          orderId: ord.orderId,
          status: ord.status,
          otp: ord.otp || '',
          phone: ord.phone || '',
          message: r?.error || ord.message || 'กำลังรอ',
        });
        continue;
      }

      const raw = String(r.status || '').toLowerCase();
      if (raw.includes('success') && r.otp) {
        ord.status = 'success';
        ord.otp = r.otp;
        ord.message = r.msg || 'ได้รับ OTP แล้ว';
        ord.finishedAt = new Date();
        await ord.save();
        changes.push({
          orderId: ord.orderId,
          status: 'success',
          otp: ord.otp || '',
          phone: ord.phone || '',
          message: ord.message || '',
          expiresAt: ord.expiresAt ? ord.expiresAt.toISOString() : null,
        });
      } else if (raw.includes('failed') || raw.includes('timeout')) {
        // คืนเครดิตเมื่อผู้ให้บริการตอบล้มเหลว/หมดเวลา
        const user = await User.findById(ord.user);
        if (user && !ord.refundedAt) {
          const refund = await calcRefund(ord);
          user.balance = round2(Number(user.balance || 0) + refund);
          await user.save();
        }
        ord.status = 'refunded';
        ord.message = r.msg || raw;
        ord.refundedAt = ord.refundedAt || new Date();
        ord.finishedAt = new Date();
        await ord.save();
        changes.push({
          orderId: ord.orderId,
          status: 'refunded',
          otp: '',
          phone: ord.phone || '',
          message: ord.message || '',
        });
      } else {
        // ยังรออยู่
        ord.message = r.msg || 'กำลังรอ OTP…';
        await ord.save();
        changes.push({
          orderId: ord.orderId,
          status: 'processing',
          otp: '',
          phone: ord.phone || '',
          message: ord.message || '',
          expiresAt: ord.expiresAt ? ord.expiresAt.toISOString() : null,
        });
      }
    } catch {
      // กลบ error รายรายการ เพื่อไม่ให้ทั้งรอบล้ม
    }
  }

  res.json({ ok: true, changes });
});

export default router;
