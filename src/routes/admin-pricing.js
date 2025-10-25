// routes/admin-pricing.js  (ESM/optimized, same behavior)
import express from 'express';
import { PriceRule } from '../models/PriceRule.js';
import { Category } from '../models/Category.js';
import { Subcategory } from '../models/Subcategory.js';
import { Service } from '../models/Service.js';
import { User } from '../models/User.js';
import { applyAllPricingRules } from '../lib/pricing.js';

const router = express.Router();

/* ──────────────────────────────────────────────────────────
   0) Tiny in-memory cache (TTL) สำหรับ lookup/รายการคงที่
   ────────────────────────────────────────────────────────── */
const cache = new Map();
/** get from cache by key; if miss, call fn() and cache for ttlMs */
async function withCache(key, ttlMs, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.val;
  const val = await fn();
  cache.set(key, { exp: now + ttlMs, val });
  return val;
}
// ป้องกัน cache พอง: เคลียร์คีย์หมดอายุเป็นครั้งคราว
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (v.exp <= now) cache.delete(k);
}, 60_000);

/* ──────────────────────────────────────────────────────────
   Helpers
   ────────────────────────────────────────────────────────── */
const splitIds = (s='') => String(s||'').split(',').map(x=>x.trim()).filter(Boolean);
function safeRegex(q=''){ const esc=String(q).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); return new RegExp(esc,'i'); }

/* ──────────────────────────────────────────────────────────
   Delete (reuse)
   ────────────────────────────────────────────────────────── */
async function deleteRuleHandler(req, res, next) {
  try {
    const { id } = req.params;
    await PriceRule.deleteOne({ _id: id });
    await applyAllPricingRules();
    req?.flash?.('success', 'ลบกฎแล้ว');
    return res.redirect('/admin/pricing');
  } catch (e) { return next(e); }
}
router.post('/pricing/:id/delete', deleteRuleHandler);
router.delete('/pricing/:id', deleteRuleHandler);

/* ──────────────────────────────────────────────────────────
   Page: GET /pricing  (optimized query plan)
   ────────────────────────────────────────────────────────── */
router.get('/pricing', async (req, res, next) => {
  try {
    // 1) ดึงกฎด้วยฟิลด์เท่าที่ต้องใช้เท่านั้น (ลด payload/deserialize)
    const rules = await PriceRule.find({}, {
      scope: 1, mode: 1, value: 1, priority: 1,
      targetId: 1, targetIds: 1,
      userScope: 1, userId: 1, userIds: 1,
      createdAt: 1,
    }).sort({ priority: -1, createdAt: -1 }).lean();

    // 2) รวบรวม target IDs ที่ “จำเป็น” จาก rules เพื่อ query แบบเจาะจง
    const catIdSet   = new Set();
    const svcIdSet   = new Set();   // Service document ids (กลุ่ม)
    const childIdSet = new Set();   // children ids ภายใน details.services

    for (const r of (rules||[])) {
      const ids = Array.isArray(r.targetIds) && r.targetIds.length
        ? r.targetIds.map(String)
        : (r.targetId ? [String(r.targetId)] : []);
      if (!ids.length) continue;
      if (r.scope === 'category')      ids.forEach(id => catIdSet.add(id));
      else if (r.scope === 'service')  ids.forEach(id => svcIdSet.add(id));
      else if (r.scope === 'serviceChild') ids.forEach(id => childIdSet.add(id));
    }

    // 3) โหลด Category “ทั้งหมด” แคชระยะสั้น (ใช้กับ legacy UI) + map เร็ว ๆ
    //    TTL 60s พอให้หน้าอื่นแชร์ผลได้ แต่ยังสดพอ
    const cats = await withCache('cats:all', 60_000, async () => {
      return Category.find({}).select('_id name').lean();
    });
    const catMap = Object.fromEntries((cats||[]).map(c => [String(c._id), c.name]));

    // 4) โหลด Service เฉพาะที่อ้างถึงใน rules เท่านั้น
    //    - ถ้ามีกฎ children ให้หาเฉพาะเอกสารที่มี children.id อยู่ในชุดนั้น
    //    - ใช้ projection เฉพาะฟิลด์ที่ต้องใช้สำหรับ map ชื่อ
    const serviceQuery = [];
    if (svcIdSet.size)   serviceQuery.push({ _id: { $in: [...svcIdSet] } });
    if (childIdSet.size) serviceQuery.push({ 'details.services.id': { $in: [...childIdSet] } });

    let services = [];
    if (serviceQuery.length) {
      services = await Service.find({ $or: serviceQuery })
        .select('_id name details.services.id details.services.name')
        .lean();
    } else {
      // ถ้าไม่มี reference ใด ๆ เลย ไม่ต้องโหลดทั้งคอลเลกชัน
      services = [];
    }

    // 5) สร้าง map ชื่ออย่างมีเป้าหมาย (O(n) กับผลลัพธ์ที่คัดมาแล้ว)
    const svcMap   = Object.create(null);
    const childMap = Object.create(null);
    for (const s of (services||[])) {
      svcMap[String(s._id)] = s.name || String(s._id);
      const arr = Array.isArray(s?.details?.services) ? s.details.services : [];
      for (const c of arr) {
        const id = String(c.id);
        // ทำ map เฉพาะ child ที่เกี่ยวจริง ๆ (ถ้ามี childIdSet ให้กรอง)
        if (childIdSet.size && !childIdSet.has(id)) continue;
        childMap[id] = (c.name || id) + (s.name ? ` (${s.name})` : '');
      }
    }

    // 6) รวม user ids ที่จำเป็นจาก rules → ยิง query เดียว (projection เล็ก)
    const uids = [...new Set(
      (rules||[])
        .filter(r => (r.userScope === 'user') && (r.userId || (r.userIds && r.userIds.length)))
        .flatMap(r => r.userIds?.length ? r.userIds.map(String) : [String(r.userId)])
    )];

    let ruleUserMap = {};
    if (uids.length) {
      const ulist = await User.find(
        { _id: { $in: uids } },
        { _id: 1, name: 1, username: 1, email: 1 }
      ).lean();
      ruleUserMap = Object.fromEntries(
        ulist.map(u => [String(u._id), (u.name || u.username || u.email || String(u._id))])
      );
    }

    // 7) preload users สำหรับช่องค้นหา – แคชสั้น ๆ ลด cold start (TTL 30s)
    const users = await withCache('users:preload:20', 30_000, async () => {
      return User.find({}, { _id:1, name:1, email:1, username:1 })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();
    });

    // 8) ส่งไป view (สัญญา: shape เท่าเดิม)
    res.render('admin/pricing', {
      cats, rules, users, ruleUserMap,
      targetNameMaps: { catMap, svcMap, childMap }
    });
  } catch (e) { next(e); }
});

/* ──────────────────────────────────────────────────────────
   Create rules (single + multi)  — unchanged behavior
   ────────────────────────────────────────────────────────── */
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

    const _split = (s='') => String(s||'').split(',').map(x=>x.trim()).filter(Boolean);
    let targets = _split(targetIds);
    if (!targets.length && targetId) targets = [String(targetId).trim()];

    if (scope !== 'global' && !targets.length) {
      req?.flash?.('warn', 'กรุณาเลือก Target ให้ครบตามขอบเขต');
      return res.redirect('/admin/pricing');
    }

    const uScope = (userScope === 'user') ? 'user' : 'all';
    let usersPicked = _split(userIds);
    if (uScope === 'user' && !usersPicked.length && userId) usersPicked = [String(userId)];
    if (uScope === 'user' && !usersPicked.length) {
      req?.flash?.('warn', 'กรุณาเลือกยูสเซอร์');
      return res.redirect('/admin/pricing');
    }

    // ดึงชื่อแพลตฟอร์มล่วงหน้า (คิวรีเฉพาะที่ใช้)
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

    const userCombos   = (uScope === 'all') ? [null] : usersPicked;
    const targetCombos = (scope === 'global') ? [null] : targets;

    for (const t of targetCombos) {
      for (const u of userCombos) {
        const doc = {
          ...baseDoc,
          targetId: (scope === 'global') ? undefined : String(t),
          userScope: uScope,
          userId: (uScope === 'user') ? String(u) : undefined
        };
        if (scope === 'category') {
          doc.platformId = platformNameMap[String(t)] || String(t);
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

/* ──────────────────────────────────────────────────────────
   Legacy lookups
   ────────────────────────────────────────────────────────── */
router.get('/pricing/lookup/subs/:catId', async (req, res, next) => {
  try {
    const subs = await Subcategory.find({ category: req.params.catId })
      .select('_id name')
      .lean();
    res.json(subs.map(s => ({ _id: String(s._id), name: s.name })));
  } catch (e) { next(e); }
});

router.get('/pricing/lookup/services/:subId', async (req, res, next) => {
  try {
    const docs = await Service.find({ subcategory: req.params.subId })
      .select('details.services.id details.services.name')
      .lean();
    const children = [];
    for (const d of docs) {
      const list = Array.isArray(d?.details?.services) ? d.details.services : [];
      for (const c of list) children.push({ _id: String(c.id), name: c.name });
    }
    res.json(children);
  } catch (e) { next(e); }
});

/* ──────────────────────────────────────────────────────────
   New lookups (add short TTL cache per-query)
   ────────────────────────────────────────────────────────── */
router.get('/pricing/lookup/platforms', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const key = `plat:${q}`;
    const list = await withCache(key, 30_000, async () => {
      const cond = q ? { name: safeRegex(q) } : {};
      return Category.find(cond).select('_id name').sort({ name: 1 }).limit(100).lean();
    });
    res.set('Cache-Control', 'public, max-age=15'); // hint ให้ browser
    res.json(list.map(c => ({ _id: String(c._id), name: c.name })));
  } catch (e) { next(e); }
});

router.get('/pricing/lookup/groups', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const platformIds = splitIds(req.query.platformIds);
    const key = `groups:${platformIds.join(',')}:${q}`;
    const list = await withCache(key, 20_000, async () => {
      const cond = {};
      if (platformIds.length) cond.category = { $in: platformIds };
      if (q) {
        const rx = safeRegex(q);
        cond.$or = [{ name: rx }, { providerServiceId: rx }];
      }
      return Service.find(cond)
        .select('_id name providerServiceId')
        .sort({ updatedAt: -1 })
        .limit(300)
        .lean();
    });
    res.set('Cache-Control', 'public, max-age=10');
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
    const key = `g-s:${groupIds.join(',')}:${q}`;
    const out = await withCache(key, 20_000, async () => {
      const docs = await Service.find({ _id: { $in: groupIds } })
        .select('details.services.id details.services.name')
        .lean();

      const rx = q ? safeRegex(q) : null;
      const arr = [];
      for (const d of docs) {
        const children = Array.isArray(d?.details?.services) ? d.details.services : [];
        for (const c of children) {
          if (rx && !rx.test(c?.name || '')) continue;
          arr.push({ id: String(c.id), name: c.name, groupId: String(d._id) });
        }
      }
      return arr.slice(0, 1000);
    });
    res.set('Cache-Control', 'public, max-age=10');
    res.json(out);
  } catch (e) { next(e); }
});

router.get('/pricing/lookup/users', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const key = `users:${q}`;
    const list = await withCache(key, 15_000, async () => {
      let cond = {};
      if (q) {
        const rx = safeRegex(q);
        cond = { $or: [{ name: rx }, { email: rx }, { username: rx }] };
      }
      return User.find(cond, { _id:1, name:1, email:1, username:1 }).limit(50).lean();
    });
    res.set('Cache-Control', 'public, max-age=8');
    res.json(list);
  } catch (e) { next(e); }
});

export default router;
