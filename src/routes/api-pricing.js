// routes/api-pricing.js  (ESM)
import express from 'express';
import { Service } from '../models/Service.js';
import { computeEffectiveRate } from '../lib/pricing.js';

// (ถ้ามี middleware requireAuth ให้ใช้ได้ แต่ endpoint นี้ออกแบบให้ทำงานได้ทั้งมี/ไม่มีล็อกอิน)
// import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/pricing/effective-rate
 * query:
 *  - serviceId:   _id ของเอกสาร Service (กลุ่ม)
 *  - childId:     (optional) id ของบริการย่อย (details.services[].id)
 *  - qty:         (optional) จำนวนหน่วย เพื่อคำนวณ cost ประมาณการ
 *
 * response:
 *  {
 *    ok: true,
 *    serviceId: "....",
 *    childId: "...." | null,
 *    rate: <number>,        // อัตราที่ใช้คิดบิล (ต่อ 1,000)
 *    baseRate: <number>,    // อัตราพื้นฐานจากฐานข้อมูล
 *    currency: "THB",
 *    cost: <number>,        // ถ้าส่ง qty มา (qty/1000 * rate) ปัดทศนิยม 2
 *    source: "effective" | "base" // ใช้ราคาที่คำนวณตามกฎ หรือราคาพื้นฐาน
 *  }
 */
router.get('/pricing/effective-rate', async (req, res) => {
  try {
    const serviceId = String(req.query.serviceId || '').trim();
    const childId   = req.query.childId != null ? String(req.query.childId).trim() : null;
    const qtyRaw    = req.query.qty;
    const qty       = Number.isFinite(Number(qtyRaw)) ? Number(qtyRaw) : null;

    if (!serviceId) {
      return res.status(400).json({ ok: false, error: 'missing serviceId' });
    }

    // ผู้ใช้ปัจจุบัน (ถ้ามี)
    const me     = req.user || req.session?.user || null;
    const userId = me?._id ? String(me._id) : null;

    // โหลดเอกสารบริการ (เอาไว้หาสกุลเงิน/อัตราพื้นฐาน)
    const s = await Service.findById(serviceId).lean();
    if (!s) return res.status(404).json({ ok: false, error: 'service not found' });

    // หา baseRate + currency จากตัวหลัก/child
    let baseRate, currency;
    if (childId != null && Array.isArray(s?.details?.services)) {
      const c = s.details.services.find(x => String(x?.id) === String(childId));
      if (!c) return res.status(404).json({ ok: false, error: 'child service not found' });
      baseRate = Number(c?.rate ?? s.rate ?? 0);
      currency = c?.currency || s?.currency || 'THB';
    } else {
      baseRate = Number(s?.rate || 0);
      currency = s?.currency || 'THB';
    }

    // คำนวณ effective rate ตามกฎ (ต่อผู้ใช้ ถ้ามี userId)
    const eff = await computeEffectiveRate({
      service: s,
      childId: childId ?? null,
      userId,
      baseRate
    });

    // ถ้า eff เท่ากับ base → ถือว่า source = base
    const rate   = Number(eff);
    const source = (Number.isFinite(rate) && rate !== Number(baseRate)) ? 'effective' : 'base';

    // คำนวณ cost ถ้ามี qty
    const cost = qty != null ? Math.max(0, Math.round(((qty / 1000) * rate) * 100) / 100) : undefined;

    return res.json({
      ok: true,
      serviceId,
      childId: childId || null,
      rate,
      baseRate: Number(baseRate),
      currency,
      ...(cost !== undefined ? { cost } : {}),
      source
    });
  } catch (err) {
    console.error('GET /api/pricing/effective-rate error:', err);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

export default router;
