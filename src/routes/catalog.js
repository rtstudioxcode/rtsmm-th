import { Router } from 'express';
import { Category } from '../models/Category.js';
import { Subcategory } from '../models/Subcategory.js';
import { Service } from '../models/Service.js';
import { syncServicesFromProvider } from '../lib/syncServices.js';
import { computePrice } from '../lib/pricing.js';

const router = Router();

/**
 * GET /
 * หน้าแรก: แสดงหมวดหลักทั้งหมด
 */
router.get('/', async (req, res) => {
  try {
    let cats = await Category.find().sort({ name: 1 }).lean();

    // ถ้ายังว่าง → ลองซิงก์อัตโนมัติ
    if (!cats.length) {
      try {
        const r = await syncServicesFromProvider();
        console.log(`✅ Auto-sync services on first visit: ${r.count} items`);
        cats = await Category.find().sort({ name: 1 }).lean();
      } catch (e) {
        console.error('❌ Auto-sync failed:', e?.response?.data || e.message || e);
        return res.render('catalog/index', {
          cats: [],
          title: 'RTSMM-TH | Home',
          bodyClass: 'catalog',
          syncError:
            'ยังไม่มีรายการบริการ และการดึงจากผู้ให้บริการล้มเหลว',
        });
      }
    }

    return res.render('catalog/index', {
      cats,
      title: 'RTSMM-TH | Home',
      bodyClass: 'catalog',
      syncError: null,
    });
  } catch (err) {
    console.error('GET / error:', err);
    return res.status(500).send('internal error');
  }
});

/**
 * GET /c/:cat
 * หน้าหมวดย่อยของหมวดหลัก (ตาม slug)
 */
router.get('/c/:cat', async (req, res) => {
  try {
    const cat = await Category.findOne({ slug: req.params.cat }).lean();
    if (!cat) return res.status(404).send('not found');

    const subs = await Subcategory.find({ category: cat._id })
      .sort({ name: 1 })
      .lean();

    return res.render('catalog/subcategory', {
      cat,
      subs,
      title: `${cat.name} — หมวดย่อย`,
      bodyClass: 'catalog',
    });
  } catch (err) {
    console.error('GET /c/:cat error:', err);
    return res.status(500).send('internal error');
  }
});

/**
 * GET /c/:cat/:sub
 * รายการบริการของหมวดย่อย (ตาม slug)
 */
router.get('/c/:cat/:sub', async (req, res) => {
  try {
    const cat = await Category.findOne({ slug: req.params.cat }).lean();
    if (!cat) return res.status(404).send('not found');

    const sub = await Subcategory.findOne({ category: cat._id, slug: req.params.sub }).lean();
    if (!sub) return res.status(404).send('not found');

    const services = await Service.find({ subcategory: sub._id })
      .sort({ rate: 1 })
      .lean();

    // คำนวณราคาโชว์แบบขนาน + กันล้มรายตัว
    await Promise.all(
      services.map(async (s) => {
        try {
          s.displayRate = await computePrice(s.rate, {
            categoryId: cat._id,
            subcategoryId: sub._id,
            serviceId: s._id,
          });
        } catch (e) {
          console.warn(`computePrice failed for service ${s._id}:`, e?.message || e);
          s.displayRate = s.rate; // fallback
        }
      }),
    );

    return res.render('catalog/services', {
      cat,
      sub,
      services,
      title: `${cat.name} › ${sub.name}`,
      bodyClass: 'catalog',
    });
  } catch (err) {
    console.error('GET /c/:cat/:sub error:', err);
    return res.status(500).send('internal error');
  }
});

/**
 * GET /service/:id
 * หน้ารายละเอียดบริการ + ฟอร์มสั่งซื้อ
 */
router.get('/service/:id', async (req, res) => {
  try {
    const svc = await Service.findById(req.params.id)
      .populate('category subcategory')
      .lean();

    if (!svc) return res.status(404).send('not found');

    try {
      svc.displayRate = await computePrice(svc.rate, {
        categoryId: svc.category?._id,
        subcategoryId: svc.subcategory?._id,
        serviceId: svc._id,
      });
    } catch (e) {
      console.warn(`computePrice failed for service ${svc._id}:`, e?.message || e);
      svc.displayRate = svc.rate; // fallback
    }

    return res.render('catalog/service_detail', {
      svc,
      title: svc.name,
      bodyClass: 'catalog',
    });
  } catch (err) {
    console.error('GET /service/:id error:', err);
    return res.status(500).send('internal error');
  }
});

export default router;
