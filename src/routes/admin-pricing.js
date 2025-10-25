// routes/admin-pricing.js  (ESM)
import express from 'express';
import { PriceRule } from '../models/PriceRule.js';
import { Category } from '../models/Category.js';     // = แพลตฟอร์ม
import { Subcategory } from '../models/Subcategory.js';
import { Service } from '../models/Service.js';       // = กลุ่ม (providerServiceId group)
import { User } from '../models/User.js';
import { applyAllPricingRules } from '../lib/pricing.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const splitIds = (s='') => String(s||'').split(',').map(x=>x.trim()).filter(Boolean);
function safeRegex(q=''){ const esc=String(q).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); return new RegExp(esc,'i'); }

// ─────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────
router.get('/pricing', async (req, res, next) => {
  try {
    const [cats, rules, services] = await Promise.all([
      Category.find({}).lean(),
      PriceRule.find({}).sort({ priority: -1, createdAt: -1 }).lean(),
      Service.find({}).select('_id name details.services').lean(),
    ]);

    const users = await User.find({}, { _id:1, name:1, email:1, username:1 })
      .sort({ createdAt: -1 }).limit(20).lean();

    const catMap = Object.fromEntries((cats||[]).map(c => [String(c._id), c.name]));

    const svcMap = Object.create(null);
    const childMap = Object.create(null);
    for (const s of (services||[])) {
      svcMap[String(s._id)] = s.name || String(s._id);
      const arr = Array.isArray(s?.details?.services) ? s.details.services : [];
      for (const c of arr) childMap[String(c.id)] = (c.name || String(c.id)) + (s.name ? ` (${s.name})` : '');
    }

    const uids = [...new Set(
      (rules||[])
        .filter(r => (r.userScope === 'user') && (r.userId || (r.userIds && r.userIds.length)))
        .flatMap(r => r.userIds?.length ? r.userIds.map(String) : [String(r.userId)])
    )];

    let ruleUserMap = {};
    if (uids.length) {
      const ulist = await User.find({ _id: { $in: uids } }, { _id:1, name:1, username:1, email:1 }).lean();
      ruleUserMap = Object.fromEntries(ulist.map(u => [String(u._id), (u.name || u.username || u.email || String(u._id))]));
    }

    res.render('admin/pricing', {
      cats, rules, users, ruleUserMap,
      targetNameMaps: { catMap, svcMap, childMap }
    });
  } catch (e) { next(e); }
});

// routes/admin-pricing.js  (เฉพาะส่วน GET /pricing)
// router.get('/pricing', async (req, res, next) => {
//   try {
//     // โหลด cats (แพลตฟอร์ม), rules, และ services (ไว้ทำ map ชื่อ)
//     const [cats, rules, services] = await Promise.all([
//       Category.find({}).lean(),
//       PriceRule.find({}).sort({ priority: -1, createdAt: -1 }).lean(),
//       Service.find({}).select('_id name details.services').lean(),
//     ]);

//     // preload users สำหรับช่องค้นหา
//     const users = await User.find({}, { _id:1, name:1, email:1, username:1 })
//       .sort({ createdAt: -1 })
//       .limit(20)
//       .lean();

//     // ====== ทำแผนที่ id -> ชื่อ เพื่อแสดงในตาราง ======
//     const catMap = Object.fromEntries((cats||[]).map(c => [String(c._id), c.name]));

//     const svcMap = Object.create(null);      // Service document (กลุ่ม)
//     const childMap = Object.create(null);    // details.services[].id (บริการย่อย)
//     for (const s of (services||[])) {
//       svcMap[String(s._id)] = s.name || String(s._id);
//       const arr = Array.isArray(s?.details?.services) ? s.details.services : [];
//       for (const c of arr) {
//         // แสดงเป็น "ชื่อบริการย่อย (ชื่อกลุ่ม)"
//         childMap[String(c.id)] = (c.name || String(c.id)) + (s.name ? ` (${s.name})` : '');
//       }
//     }

//     // ✅ รวม userIds ใน rules เพื่อโชว์ชื่อ
//     const uids = [...new Set(
//       (rules || [])
//         .filter(r => (r.userScope === 'user') && (r.userId || (r.userIds && r.userIds.length)))
//         .flatMap(r => r.userIds?.length ? r.userIds.map(String) : [String(r.userId)])
//     )];

//     let ruleUserMap = {};
//     if (uids.length) {
//       const ulist = await User.find(
//         { _id: { $in: uids } },
//         { _id:1, name:1, username:1, email:1 }
//       ).lean();
//       ruleUserMap = Object.fromEntries(
//         ulist.map(u => [String(u._id), (u.name || u.username || u.email || String(u._id))])
//       );
//     }

//     // ส่ง maps ไปที่วิว
//     res.render('admin/pricing', {
//       cats, rules, users, ruleUserMap,
//       targetNameMaps: { catMap, svcMap, childMap }   // 👈 ใส่เพิ่ม
//     });
//   } catch (e) { next(e); }
// });

// ─────────────────────────────────────────────────────────────
// Create rules (single + multi)
// ─────────────────────────────────────────────────────────────
router.post('/pricing', async (req, res, next) => {
  try {
    let {
      scope, mode, value, priority = 0,
      targetId, targetIds,
      userScope, userId, userIds
    } = req.body;

    if (!scope || !mode || value === undefined) {
      req?.flash?.('error', 'ข้อมูลไม่ครบ: scope/mode/value');
      return res.redirect('/admin/pricing');
    }

    if (scope === 'service-c') scope = 'service'; // map UI → engine

    const splitIds = (s='') => String(s||'').split(',').map(x=>x.trim()).filter(Boolean);
    let targets = splitIds(targetIds);
    if (!targets.length && targetId) targets = [String(targetId).trim()];

    if (scope !== 'global' && !targets.length) {
      req?.flash?.('warn', 'กรุณาเลือก Target ให้ครบตามขอบเขต');
      return res.redirect('/admin/pricing');
    }

    const uScope = (userScope === 'user') ? 'user' : 'all';
    let usersPicked = splitIds(userIds);
    if (uScope === 'user' && !usersPicked.length && userId) usersPicked = [String(userId)];
    if (uScope === 'user' && !usersPicked.length) {
      req?.flash?.('warn', 'กรุณาเลือกยูสเซอร์');
      return res.redirect('/admin/pricing');
    }

    // 🔎 ถ้าเป็นกฎระดับ "แพลตฟอร์ม" ดึงชื่อแพลตฟอร์มล่วงหน้า
    let platformNameMap = {};
    if (scope === 'category' && targets.length) {
      const cats = await Category.find({ _id: { $in: targets } }).select('_id name').lean();
      platformNameMap = Object.fromEntries(cats.map(c => [String(c._id), c.name || String(c._id)]));
    }

    const docs = [];
    const baseDoc = {
      scope,
      mode,
      value: Number(value),
      priority: Number(priority) || 0,
      isActive: true
    };

    const userCombos  = (uScope === 'all') ? [null] : usersPicked;
    const targetCombos = (scope === 'global') ? [null] : targets;

    for (const t of targetCombos) {
      for (const u of userCombos) {
        const doc = {
          ...baseDoc,
          targetId: (scope === 'global') ? undefined : String(t),
          userScope: uScope,
          userId: (uScope === 'user') ? String(u) : undefined
        };

        // ✅ เก็บ "ชื่อแพลตฟอร์ม" ลง platformId (ตามที่ต้องการ)
        if (scope === 'category') {
          doc.platformId = platformNameMap[String(t)] || String(t); // เช่น "Facebook"
        }

        docs.push(doc);
      }
    }

    if (!docs.length) {
      req?.flash?.('warn', 'ไม่มีรายการที่ต้องบันทึก');
      return res.redirect('/admin/pricing');
    }

    await PriceRule.insertMany(docs);
    await applyAllPricingRules();

    req?.flash?.('success', `บันทึกกฎสำเร็จ ${docs.length} รายการ`);
    res.redirect('/admin/pricing');
  } catch (e) { next(e); }
});

// router.post('/pricing', async (req, res, next) => {
//   try {
//     let {
//       scope,                   // 'global' | 'category' | 'subcategory' | 'service' | 'service-c'(UI)
//       mode,                    // 'percent' | 'delta' | 'set'
//       value,
//       priority = 0,

//       // single (legacy)
//       targetId,

//       // multi (UI ใหม่)
//       targetIds,               // comma-separated: categories OR service._id OR child.id
//       userScope,               // 'all' | 'user'
//       userId,                  // single
//       userIds                  // comma-separated
//     } = req.body;

//     if (!scope || !mode || value === undefined) {
//       req?.flash?.('error', 'ข้อมูลไม่ครบ: scope/mode/value');
//       return res.redirect('/admin/pricing');
//     }

//     // map scope UI → engine
//     if (scope === 'service-c') scope = 'service';

//     // เตรียม target หลายค่า (รองรับ fallback single)
//     let targets = splitIds(targetIds);
//     if (!targets.length && targetId) targets = [String(targetId).trim()];

//     if (scope !== 'global' && !targets.length) {
//       req?.flash?.('warn', 'กรุณาเลือก Target ให้ครบตามขอบเขต');
//       return res.redirect('/admin/pricing');
//     }

//     // ผู้ใช้: ทุกคน หรือหลายคน
//     const uScope = (userScope === 'user') ? 'user' : 'all';
//     let usersPicked = splitIds(userIds);
//     if (uScope === 'user' && !usersPicked.length && userId) usersPicked = [String(userId)];

//     if (uScope === 'user' && !usersPicked.length) {
//       req?.flash?.('warn', 'กรุณาเลือกยูสเซอร์');
//       return res.redirect('/admin/pricing');
//     }

//     // สร้างเอกสารหลายตัวตาม combination (targets × usersPicked|all)
//     const docs = [];
//     const base = {
//       scope,
//       mode,
//       value: Number(value),
//       priority: Number(priority) || 0,
//       isActive: true
//     };

//     const userCombos = (uScope === 'all') ? [null] : usersPicked;
//     const targetCombos = (scope === 'global') ? [null] : targets;

//     for (const t of targetCombos) {
//       for (const u of userCombos) {
//         docs.push({
//           ...base,
//           targetId: (scope === 'global') ? undefined : String(t),
//           userScope: uScope,
//           userId: (uScope === 'user') ? String(u) : undefined
//         });
//       }
//     }

//     if (!docs.length) {
//       req?.flash?.('warn', 'ไม่มีรายการที่ต้องบันทึก');
//       return res.redirect('/admin/pricing');
//     }

//     await PriceRule.insertMany(docs);

//     // apply เฉพาะ “ราคากลาง” ใน DB (กฎ user จะถูกคำนวณฝั่งแสดงผล/สั่งซื้อ)
//     await applyAllPricingRules();

//     req?.flash?.('success', `บันทึกกฎสำเร็จ ${docs.length} รายการ`);
//     res.redirect('/admin/pricing');
//   } catch (e) { next(e); }
// });

// // ลบกฎ
// router.post('/pricing/:id/delete', async (req, res, next) => {
//   try {
//     await PriceRule.deleteOne({ _id: req.params.id });
//     await applyAllPricingRules();
//     req?.flash?.('success', 'ลบกฎแล้ว');
//     res.redirect('/admin/pricing');
//   } catch (e) { next(e); }
// });

// ─────────────────────────────────────────────────────────────
// Legacy lookups (ยังคงไว้เพื่อรองรับโหมดเดิม)
// ─────────────────────────────────────────────────────────────
router.get('/pricing/lookup/subs/:catId', async (req, res, next) => {
  try {
    const subs = await Subcategory.find({ category: req.params.catId }).lean();
    res.json(subs.map(s => ({ _id: String(s._id), name: s.name })));
  } catch (e) { next(e); }
});

router.get('/pricing/lookup/services/:subId', async (req, res, next) => {
  try {
    const docs = await Service.find({ subcategory: req.params.subId }).lean();
    const children = [];
    for (const d of docs) {
      const list = Array.isArray(d?.details?.services) ? d.details.services : [];
      for (const c of list) children.push({ _id: String(c.id), name: c.name });
    }
    res.json(children);
  } catch (e) { next(e); }
});

// router.get('/pricing/lookup/subs/:catId', async (req, res, next) => {
//   try {
//     const subs = await Subcategory.find({ category: req.params.catId }).lean();
//     res.json(subs.map(s => ({ _id: String(s._id), name: s.name })));
//   } catch (e) { next(e); }
// });

// router.get('/pricing/lookup/services/:subId', async (req, res, next) => {
//   try {
//     const docs = await Service.find({ subcategory: req.params.subId }).lean();
//     const children = [];
//     for (const d of docs) {
//       const list = Array.isArray(d?.details?.services) ? d.details.services : [];
//       for (const c of list) children.push({ _id: String(c.id), name: c.name });
//     }
//     res.json(children);
//   } catch (e) { next(e); }
// });

// ─────────────────────────────────────────────────────────────
// New lookups for multi-select UI
// ─────────────────────────────────────────────────────────────
router.get('/pricing/lookup/platforms', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const cond = q ? { name: safeRegex(q) } : {};
    const list = await Category.find(cond).select('_id name').sort({ name: 1 }).limit(100).lean();
    res.json(list.map(c => ({ _id: String(c._id), name: c.name })));
  } catch (e) { next(e); }
});

router.get('/pricing/lookup/groups', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const platformIds = splitIds(req.query.platformIds);
    const cond = {};
    if (platformIds.length) cond.category = { $in: platformIds };
    if (q) {
      const rx = safeRegex(q);
      cond.$or = [{ name: rx }, { providerServiceId: rx }];
    }
    const list = await Service
      .find(cond)
      .select('_id name providerServiceId')
      .sort({ updatedAt: -1 })
      .limit(300)
      .lean();

    res.json(list.map(s => ({
      _id: String(s._id),
      name: s.name,
      providerServiceId: s.providerServiceId || s.details?.id || null
    })));
  } catch (e) { next(e); }
});

router.get('/pricing/lookup/group-services', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const groupIds = splitIds(req.query.groupIds);
    if (!groupIds.length) return res.json([]);

    const docs = await Service.find({ _id: { $in: groupIds } })
      .select('details.services')
      .lean();

    const rx = q ? safeRegex(q) : null;
    const out = [];
    for (const d of docs) {
      const children = Array.isArray(d?.details?.services) ? d.details.services : [];
      for (const c of children) {
        if (rx && !rx.test(c?.name || '')) continue;
        out.push({ id: String(c.id), name: c.name, groupId: String(d._id) });
      }
    }
    res.json(out.slice(0, 1000));
  } catch (e) { next(e); }
});

router.get('/pricing/lookup/users', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    let cond = {};
    if (q) {
      const rx = safeRegex(q);
      cond = { $or: [{ name: rx }, { email: rx }, { username: rx }] };
    }
    const list = await User.find(cond, { _id:1, name:1, email:1, username:1 }).limit(50).lean();
    res.json(list);
  } catch (e) { next(e); }
});

export default router;

// แพลตฟอร์ม = Category
// router.get('/pricing/lookup/platforms', async (req, res, next) => {
//   try {
//     const q = String(req.query.q || '').trim();
//     const cond = q ? { name: safeRegex(q) } : {};
//     const list = await Category.find(cond).select('_id name').sort({ name: 1 }).limit(100).lean();
//     res.json(list.map(c => ({ _id: String(c._id), name: c.name })));
//   } catch (e) { next(e); }
// });

// // กลุ่ม (Service document) ด้วย platformIds (category) และค้นชื่อ/psid
// router.get('/pricing/lookup/groups', async (req, res, next) => {
//   try {
//     const q = String(req.query.q || '').trim();
//     const platformIds = splitIds(req.query.platformIds);
//     const cond = {};
//     if (platformIds.length) cond.category = { $in: platformIds };
//     if (q) {
//       const rx = safeRegex(q);
//       cond.$or = [{ name: rx }, { providerServiceId: rx }];
//     }
//     const list = await Service
//       .find(cond)
//       .select('_id name providerServiceId details.id')
//       .sort({ updatedAt: -1 })
//       .limit(300)
//       .lean();

//     res.json(list.map(s => ({
//       _id: String(s._id),
//       name: s.name,
//       providerServiceId: s.providerServiceId || s.details?.id || null
//     })));
//   } catch (e) { next(e); }
// });

// // บริการย่อยภายใต้หลายกลุ่ม (children)
// router.get('/pricing/lookup/group-services', async (req, res, next) => {
//   try {
//     const q = String(req.query.q || '').trim();
//     const groupIds = splitIds(req.query.groupIds);
//     if (!groupIds.length) return res.json([]);

//     const docs = await Service.find({ _id: { $in: groupIds } })
//       .select('details.services')
//       .lean();

//     const rx = q ? safeRegex(q) : null;
//     const out = [];
//     for (const d of docs) {
//       const children = Array.isArray(d?.details?.services) ? d.details.services : [];
//       for (const c of children) {
//         if (rx && !rx.test(c?.name || '')) continue;
//         out.push({
//           id: String(c.id),
//           name: c.name,
//           groupId: String(d._id)
//         });
//       }
//     }
//     res.json(out.slice(0, 1000));
//   } catch (e) { next(e); }
// });

// // ค้นหายูสเซอร์ (พิมพ์หา / preload)
// router.get('/pricing/lookup/users', async (req, res, next) => {
//   try {
//     const q = (req.query.q || '').trim();
//     let cond = {};
//     if (q) {
//       const rx = safeRegex(q);
//       cond = { $or: [{ name: rx }, { email: rx }, { username: rx }] };
//     }
//     const list = await User.find(cond, { _id:1, name:1, email:1, username:1 })
//       .limit(50).lean();
//     res.json(list);
//   } catch (e) { next(e); }
// });

// export default router;
