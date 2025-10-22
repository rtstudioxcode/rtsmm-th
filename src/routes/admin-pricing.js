// routes/admin-pricing.js  (ESM)
import express from 'express';
import { PriceRule } from '../models/PriceRule.js';
import { Category } from '../models/Category.js';
import { Subcategory } from '../models/Subcategory.js';
import { Service } from '../models/Service.js';
import { applyAllPricingRules } from '../lib/pricing.js';

const router = express.Router();

router.get('/pricing', async (req, res, next) => {
  try {
    const [cats, rules] = await Promise.all([
      Category.find({}).lean(),
      PriceRule.find({}).sort({ priority: -1, createdAt: -1 }).lean(),
    ]);
    res.render('admin/pricing', { cats, rules });
  } catch (e) { next(e); }
});

router.post('/pricing', async (req, res, next) => {
  try {
    const { scope, mode, value, priority = 0 } = req.body;
    // targetId อาจเป็น _id ของ Service หรือ id ของ child
    const targetId = (req.body.targetId || '').trim();

    await PriceRule.create({
      scope, mode,
      targetId,                  // string ได้ทั้งสองแบบ
      value: Number(value),
      priority: Number(priority),
      isActive: true,
    });

    await applyAllPricingRules();
    res.redirect('/admin/pricing');
  } catch (e) { next(e); }
});

router.post('/pricing/:id/delete', async (req, res, next) => {
  try {
    await PriceRule.deleteOne({ _id: req.params.id });
    await applyAllPricingRules();
    res.redirect('/admin/pricing');
  } catch (e) { next(e); }
});

// — lookups —
router.get('/pricing/lookup/subs/:catId', async (req, res) => {
  const subs = await Subcategory.find({ category: req.params.catId }).lean();
  res.json(subs.map(s => ({ _id: String(s._id), name: s.name })));
});

// ✅ คืน "บริการย่อยจริง ๆ" ภายใต้ subcategory นั้น
router.get('/pricing/lookup/services/:subId', async (req, res) => {
  const docs = await Service.find({ subcategory: req.params.subId }).lean();

  const children = [];
  for (const d of docs) {
    const list = Array.isArray(d?.details?.services) ? d.details.services : [];
    for (const c of list) {
      children.push({
        _id: String(c.id),            // ใช้ id ของ child เป็น targetId
        name: c.name,
      });
    }
  }
  res.json(children);
});

export default router;
