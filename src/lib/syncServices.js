// lib/syncProvider.js
import { getServices } from './iplusviewAdapter.js';
import { Category } from '../models/Category.js';
import { Subcategory } from '../models/Subcategory.js';
import { Service } from '../models/Service.js';
import { ProviderSettings } from '../models/ProviderSettings.js';
import { splitPlatformAndType } from './categorize.js';
import { applyRulesToOneService, applyAllPricingRules } from './pricing.js';
import { ChangeLog } from '../models/ChangeLog.js';
import { CatalogSnapshot } from '../models/CatalogSnapshot.js';

/* ---------------- helpers ---------------- */
const pick  = (o, ks, d) => { for (const k of ks) if (o?.[k] !== undefined) return o[k]; return d; };
const toNum = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const toBool = v => {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  const s = String(v ?? '').toLowerCase();
  if (['1','true','yes','on','open','opened','enabled','active'].includes(s)) return true;
  if (['0','false','no','off','close','closed','disabled','inactive'].includes(s)) return false;
  return undefined;
};

// ===== helper ตรวจสถานะเปิด/ปิดจากข้อมูล provider (ถ้ามีฟิลด์บอกชัด)
// ตีความสถานะเปิด/ปิดแบบอ่อนโยน (ถ้าไม่มีฟิลด์ชัดเจน)
// - ถ้ามี raw.status: ใช้เลย (closed/disabled => ปิด, อย่างอื่น => เปิด)
// - ไม่งั้น: ถ้ามี rate > 0 และไม่ได้ถูก mark disabled => เปิด
function inferStatus({ raw, mapped, prev }) {
  // 1) จาก provider ถ้ามี field บ่งชี้
  const maybe =
    toBool(raw?.status) ?? toBool(raw?.state) ?? toBool(raw?.enabled) ??
    toBool(raw?.is_active) ?? toBool(raw?.available);
  if (maybe !== undefined) return maybe ? 'open' : 'close';

  // 2) จากราคาปัจจุบัน (ถ้า rate 0 มักจะถือว่าใช้ไม่ได้)
  if (Number.isFinite(mapped?.rate) && mapped.rate <= 0) return 'close';

  // 3) จากของเดิมใน DB (disabled/hidden)
  if (prev && (prev.disabled || prev.hidden)) return 'close';

  // 4) fallback: ถือว่าเปิดถ้าไม่มีหลักฐานว่าปิด
  return 'open';
}

function hasMeaningfulChange(prev, mapped) {
  if (!prev) return true;
  // เช็คคีย์หลักๆ พอประมาณ (เพิ่มได้ตามต้องการ)
  const keys = ['name','description','rate','min','max','step','type','dripfeed','refill','cancel','average_delivery','currency'];
  return keys.some(k => {
    const a = prev[k];
    const b = mapped[k];
    // boolean เทียบตรงๆ, ตัวเลขเทียบแบบ Number
    if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) !== Boolean(b);
    if (typeof a === 'number'  || typeof b === 'number')  return Number(a ?? NaN) !== Number(b ?? NaN);
    return String(a ?? '') !== String(b ?? '');
  });
}

/** upsert Category ตาม slug (platform.key) */
async function upsertCategory(platform) {
  const slug = platform.key;
  return Category.findOneAndUpdate(
    { slug },
    { $set: { name: platform.name, slug } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/** upsert Subcategory ตาม (categoryId + slug) */
async function upsertSubcategory(categoryId, type) {
  const slug = type.key;
  return Subcategory.findOneAndUpdate(
    { category: categoryId, slug },
    { $set: { category: categoryId, name: type.name, slug } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/** upsert Service ตาม providerServiceId  (เก็บ raw ลง details) */
async function upsertService({ providerServiceId, categoryId, subcategoryId, mapped, raw }) {
  return Service.findOneAndUpdate(
    { providerServiceId },
    {
      $set: {
        category: categoryId,
        subcategory: subcategoryId,
        name: mapped.name,
        description: mapped.description,
        currency: mapped.currency,
        rate: mapped.rate,
        min: mapped.min,
        max: mapped.max,
        step: mapped.step,
        type: mapped.type,
        dripfeed: mapped.dripfeed,
        refill: mapped.refill,
        cancel: mapped.cancel,
        average_delivery: mapped.average_delivery,
        details: raw
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/* ---------------- main sync ---------------- */
export async function syncServicesFromProvider() {
  const rawList = await getServices();
  if (!Array.isArray(rawList)) throw new Error('Provider returned non-array for services');

  // เตรียมรายการเดิมทั้งหมด เพื่อเทียบ removed/สถานะเดิม
  const existingServices = await Service.find(
    {},
    { providerServiceId: 1, name: 1, disabled: 1, hidden: 1, rate: 1, min:1, max:1, step:1, type:1, dripfeed:1, refill:1, cancel:1, average_delivery:1, currency:1, description:1 }
  ).lean();
  const existByPid = new Map(existingServices.map(s => [String(s.providerServiceId), s]));

  // แคชเพื่อลดคิวรีซ้ำ
  const platformCache = new Map();   // key: platform.name -> Category doc
  const typeCache     = new Map();   // key: `${catId}::${type.name}` -> Subcategory doc

  let createdOrUpdated = 0;
  let skipped = 0;
  const affectedServiceIds = [];
  const seenPids = new Set();
  const changeLogs = [];

  for (const s of rawList) {
    const providerId = String(pick(s, ['id','service_id','sid','service'], '')).trim();
    if (!providerId) { skipped++; continue; }
    seenPids.add(providerId);

    // แยกแพลตฟอร์ม/ประเภท
    const { platform, type } = splitPlatformAndType(s);

    // Category (Platform)
    const platKey = platform.name;
    let plat = platformCache.get(platKey);
    if (!plat) {
      plat = await upsertCategory(platform);
      platformCache.set(platKey, plat);
    }

    // Subcategory (ServiceType)
    const typeKey = `${plat._id.toString()}::${type.name}`;
    let sub = typeCache.get(typeKey);
    if (!sub) {
      sub = await upsertSubcategory(plat._id, type);
      typeCache.set(typeKey, sub);
    }

    // map ฟิลด์มาตรฐาน
    const mapped = {
      name:        pick(s, ['name','title','service_name'], `Service #${providerId}`),
      description: pick(s, ['description','desc','details','note','notes','instruction','instructions'], ''),
      currency:    pick(s, ['currency','curr'], 'THB'),
      rate:        toNum(pick(s, ['rate','price','cost','price_per_1000','price_per_k','pricePerK','per1000','per_1k'], 0)),
      min:         toNum(pick(s, ['min','min_qty','min_qnt','minimum'], 0)),
      max:         toNum(pick(s, ['max','max_qty','max_qnt','maximum'], 0)),
      step:        toNum(pick(s, ['step','step_size','step_qty'], 1)),
      type:        pick(s, ['type','mode','kind'], 'default'),
      dripfeed:    !!pick(s, ['dripfeed','drip','drip_feed'], false),
      refill:      !!pick(s, ['refill'], false),
      cancel:      !!pick(s, ['cancel','cancellable'], false),
      average_delivery: pick(s, ['average_delivery','avg_delivery','delivery_time'], '')
    };

    const prev = existByPid.get(providerId) || null;
    const prevStatus = prev ? inferStatus({ raw: {}, mapped: { rate: prev.rate }, prev }) : undefined;

    // upsert service
    const service = await upsertService({
      providerServiceId: providerId,
      categoryId: plat._id,
      subcategoryId: sub._id,
      mapped,
      raw: s
    });

    createdOrUpdated++;
    affectedServiceIds.push(service._id);

    // ตีความสถานะใหม่ (หลัง upsert)
    const newStatus = inferStatus({ raw: s, mapped, prev: service });

    // ---- ตัดสินใจเขียน ChangeLog ----
    const baseLog = {
      ts: new Date(),
      target: 'service',
      providerServiceId: providerId,
      platform: platform.name,
      categoryName: type.name,
      serviceName: mapped.name,
      oldStatus: prevStatus,
      newStatus,
      isBootstrap: false
    };

    if (!prev) {
      changeLogs.push({ ...baseLog, diff: 'new' });
    } else if (prevStatus !== newStatus) {
      changeLogs.push({ ...baseLog, diff: (newStatus === 'open' ? 'open' : 'close') });
    } else if (hasMeaningfulChange(prev, mapped)) {
      // มีการเปลี่ยนแปลงเนื้อหา (เช่น rate/min/max/desc) แต่สถานะยังเดิม
      changeLogs.push({ ...baseLog, diff: 'updated' });
    }
  }

  // หา “ถูกนำออก” (เคยมี แต่รอบนี้ provider ไม่ส่งมาแล้ว)
  for (const prev of existingServices) {
    const pid = String(prev.providerServiceId);
    if (!seenPids.has(pid)) {
      changeLogs.push({
        ts: new Date(),
        target: 'service',
        diff: 'removed',
        providerServiceId: pid,
        platform: undefined,
        categoryName: undefined,
        serviceName: prev.name || `Service #${pid}`,
        oldStatus: inferStatus({ raw: {}, mapped: { rate: prev.rate }, prev }),
        newStatus: 'close',
        isBootstrap: false
      });
    }
  }

  // อัปเดตเวลา sync
  let ps = await ProviderSettings.findOne();
  if (!ps) ps = new ProviderSettings();
  ps.lastSyncAt = new Date();
  await ps.save();

  // ✅ คำนวนราคา/กฎหลังซิงก์
  if (affectedServiceIds.length <= 500) {
    for (const id of affectedServiceIds) await applyRulesToOneService(id);
  } else {
    await applyAllPricingRules();
  }

  // ✅ เขียน ChangeLog ทีเดียว
  if (changeLogs.length) {
    try {
      await ChangeLog.insertMany(changeLogs, { ordered: false });
    } catch (e) {
      console.warn('changeLogs insert warning:', e?.writeErrors?.length || e?.message || e);
    }
  }

  console.log(`✅ synced services by Platform/Type: ${createdOrUpdated} items; skipped: ${skipped}; logs: ${changeLogs.length}`);
  return { count: createdOrUpdated, skipped, logs: changeLogs.length };
}