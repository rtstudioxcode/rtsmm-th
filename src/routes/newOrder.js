import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { Category } from '../models/Category.js';
import { Subcategory } from '../models/Subcategory.js';
import { Service } from '../models/Service.js';
import { computePrice } from '../lib/pricing.js';

const router = express.Router();

/* หน้า UI */
router.get('/orders/new', requireAuth, async (req, res) => {
  const cats = await Category.find({}).lean().sort({ name: 1 });
  res.render('orders/new', { title: 'สั่งซื้อใหม่', cats });
});

/* ชั้น 1: แพลตฟอร์ม */
router.get('/api/platforms', requireAuth, async (req, res) => {
  const cats = await Category.find({}).lean().sort({ name: 1 });
  res.json(cats);
});

/* ชั้น 2: หมวด (ServiceType) ใต้แพลตฟอร์ม */
router.get('/api/subcategories', requireAuth, async (req, res) => {
  const { cat } = req.query;
  const subs = await Subcategory.find({ category: cat }).lean().sort({ name: 1 });
  res.json(subs);
});

/* ยูทิล: flatten service เดียวให้เป็น “บริการที่เลือกได้” */
function flattenOne(svc, base) {
  const rate = Number(base?.rate ?? svc.rate ?? 0);
  const currency = base?.currency || svc.currency || 'THB';
  const min = Number(base?.min ?? svc.min ?? 0);
  const max = Number(base?.max ?? svc.max ?? 0);
  const step = Number(base?.step ?? svc.step ?? 1);
  const avg = base?.average_delivery || svc.average_delivery || '';
  const refill = !!(base?.refill ?? svc.refill);
  const cancel = !!(base?.cancel ?? svc.cancel);
  const drip = !!(base?.dripfeed ?? svc.dripfeed);

  return {
    // ใช้ _id ของ document แม่ + providerServiceId ย่อย เพื่อให้ unique
    _id: svc._id?.toString?.() || base?._id?.toString?.() || undefined,
    parentId: base?._id?.toString?.() || null,
    providerServiceId: Number(base?.providerServiceId ?? svc.providerServiceId ?? base?.id ?? svc.id),
    name: base?.name || svc.name || '',
    description: base?.description || svc.description || '',
    rate, currency, min, max, step,
    average_delivery: avg,
    refill, cancel, dripfeed: drip,
    updatedAt: base?.updatedFromProviderAt || svc.updatedFromProviderAt || svc.updatedAt || base?.updatedAt || null,
    category: base?.category || svc.category,
    subcategory: base?.subcategory || svc.subcategory,
    // สำหรับคำนวณราคาโชว์ (เผื่อมี markup)
    displayRate: rate, // จะโดน computePrice ด้านล่างอีกที
    details: base?.details || svc.details || null,
  };
}

router.get('/api/service-groups', requireAuth, async (req, res) => {
  const cat = req.query.cat;
  const groups = await Service.find({ category: cat })
    .select({ name:1, description:1, updatedAt:1, details:1 }) // details.services[] ต้องถูกดึงมาด้วย
    .lean();
  res.json(groups);
});

/* ชั้น 3: บริการของหมวด — รองรับทั้ง service ตรง ๆ และ services[] ย่อย */
router.get('/api/services', requireAuth, async (req, res) => {
  const { sub } = req.query;
  const docs = await Service.find({ subcategory: sub }).lean().sort({ 'name': 1 });

  const out = [];
  for (const d of docs) {
    // ถ้า document นี้มี services ย่อยใน details.services ให้แตกออก
    const children = Array.isArray(d?.details?.services) ? d.details.services : [];
    if (children.length) {
      for (const c of children) {
        const item = flattenOne(c, d);
        item.displayRate = await computePrice(item.rate, {
          categoryId: item.category, subcategoryId: item.subcategory, serviceId: d._id
        });
        out.push(item);
      }
    } else {
      const item = flattenOne(d, null);
      item.displayRate = await computePrice(item.rate, {
        categoryId: item.category, subcategoryId: item.subcategory, serviceId: d._id
      });
      out.push(item);
    }
  }

  // เรียงเหมือนตัวอย่าง: โชว์ ID/ชื่อ/ราคา/อัปเดต
  out.sort((a,b) => {
    // ลองเรียงโดยชื่อ แล้วตามด้วย rate
    const n = (a.name||'').localeCompare(b.name||'');
    if (n !== 0) return n;
    return (a.displayRate||0) - (b.displayRate||0);
  });

  res.json(out);
});

/* ถ้าจะดึงรายละเอียดบริการ “แบบ flatten แล้ว” ไม่ต้องยิงเพิ่ม — แต่ถ้าจะแยก route ก็ใช้ตัวนี้ */
router.get('/api/service/:providerId', requireAuth, async (req, res) => {
  const pid = Number(req.params.providerId);
  const d = await Service.findOne({ providerServiceId: pid }).lean();
  if (!d) return res.status(404).json({ error: 'not found' });

  const children = Array.isArray(d?.details?.services) ? d.details.services : [];
  let item;
  if (children.length) {
    const c = children.find(x => Number(x.id) === pid) || children[0];
    item = flattenOne(c, d);
  } else {
    item = flattenOne(d, null);
  }
  item.displayRate = await computePrice(item.rate, {
    categoryId: item.category, subcategoryId: item.subcategory, serviceId: d._id
  });
  res.json(item);
});

export default router;
