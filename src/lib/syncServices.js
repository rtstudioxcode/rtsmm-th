// services/syncProvider.js  (หรือไฟล์เดิมของคุณที่มี syncServicesFromProvider)
import { getServices } from './iplusviewAdapter.js';
import { Category } from '../models/Category.js';
import { Subcategory } from '../models/Subcategory.js';
import { Service } from '../models/Service.js';
import { ProviderSettings } from '../models/ProviderSettings.js';
import { splitPlatformAndType } from './categorize.js';
import { applyRulesToOneService, applyAllPricingRules } from './pricing.js';

/* ---------------- helpers ---------------- */
const pick  = (o, ks, d) => { for (const k of ks) if (o?.[k] !== undefined) return o[k]; return d; };
const toNum = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** upsert Category ตาม slug (platform.key) */
async function upsertCategory(platform) {
  const slug = platform.key;
  // คง _id เดิมไว้ด้วย upsert
  const doc = await Category.findOneAndUpdate(
    { slug },
    { $set: { name: platform.name, slug } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc;
}

/** upsert Subcategory ตาม (categoryId + slug) */
async function upsertSubcategory(categoryId, type) {
  const slug = type.key;
  const doc = await Subcategory.findOneAndUpdate(
    { category: categoryId, slug },
    { $set: { category: categoryId, name: type.name, slug } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc;
}

/** upsert Service ตาม providerServiceId  (เก็บ raw ลง details) */
async function upsertService({ providerServiceId, categoryId, subcategoryId, mapped, raw }) {
  const doc = await Service.findOneAndUpdate(
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
  return doc;
}

/* ---------------- main sync ---------------- */
export async function syncServicesFromProvider() {
  const raw = await getServices();
  if (!Array.isArray(raw)) throw new Error('Provider returned non-array for services');

  // แคชเพื่อลดคิวรีซ้ำ
  const platformCache = new Map();   // key: platform.name -> Category doc
  const typeCache     = new Map();   // key: `${catId}::${type.name}` -> Subcategory doc

  let createdOrUpdated = 0;
  let skipped = 0;
  const affectedServiceIds = [];

  for (const s of raw) {
    const providerId = String(pick(s, ['id','service_id','sid','service'], '')).trim();
    if (!providerId) { skipped++; continue; }

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
  }

  // อัปเดตเวลา sync
  let ps = await ProviderSettings.findOne();
  if (!ps) ps = new ProviderSettings();
  ps.lastSyncAt = new Date();
  await ps.save();

  // ✅ สำคัญ: คำนวนราคาตามกฎทุกครั้งหลังซิงก์
  // ถ้าซิงก์รายการไม่มากจะทำทีละ service (ให้แน่ใจว่ารัน rule เฉพาะที่แตะ)
  if (affectedServiceIds.length <= 500) {
    for (const id of affectedServiceIds) {
      await applyRulesToOneService(id);
    }
  } else {
    // ถ้าซิงก์เยอะมาก ใช้แบบรวมครั้งเดียว
    await applyAllPricingRules();
  }

  console.log(`✅ synced services by Platform/Type: ${createdOrUpdated} items; skipped: ${skipped}`);
  return { count: createdOrUpdated, skipped };
}
