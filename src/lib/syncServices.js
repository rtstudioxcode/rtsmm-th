// lib/syncServices.js
import { getServices } from './iplusviewAdapter.js';
import { Category } from '../models/Category.js';
import { Subcategory } from '../models/Subcategory.js';
import { Service } from '../models/Service.js';
import { ProviderSettings } from '../models/ProviderSettings.js';
import { splitPlatformAndType } from './categorize.js';
import { applyRulesToOneService, applyAllPricingRules } from './pricing.js';
import { ChangeLog } from '../models/ChangeLog.js';

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

// =========================
//  PLATFORM MAP ใหม่
// =========================
const PLATFORM_MAP = [
  // ✅ กลุ่มพิเศษ
  {
    key: 'premium',
    name: 'บัญชีพรีเมียม | คีย์',
    match: [
      'canva pro',
      'chatgpt business',
      'youtube premium',
      'license key',
      'ดาวน์โหลด ไฟล์ลิขสิทธิ์',
      'shutterstock',
      'envato',
      'adobestock',
      'istockphoto',
      'motion array',
    ],
  },
  {
    key: 'thailand',
    name: 'ประเทศไทย',
    match: [
      '🇹🇭',                        // มีธงไทย
      ' ประเทศไทย',                 // คำว่าประเทศไทย
      ' บัญชีไทย',                 // บัญชีไทย
      'thailand services',
      'tiktok 🎯 thailand',
      'youtube ► thailand',
      'รวมบริการยูทูป ประเทศไทย',
      'instagram ► รวมบริการไอจี ประเทศไทย',
      'facebook ► รวมบริการไทย',
      'facebook ► ถูกใจเพจ | ผู้ติดตาม [ เพจ/โปรไฟล์ ] 💎 [ บัญชีไทย ]',
      'facebook ► ไลค์โพส reactions',
      'facebook ► แชร์โพส 🔗 บัญชีไทย',
      'facebook ► คอมเม้นท์ 💬 บัญชีไทย',
      'facebook 📝 รีวิวแฟนเพจ,แนะนำเพจ บัญชีไทย',
      'x.com | twitter services ► รวมบริการประเทศไทย',
      'shopee / lazada services ► บัญชีไทย',
      'ส่วนเสริม ไลฟ์สด shopee.co.th',
      'spotify ► thailand',
    ],
  },

  // ✅ Traffic แยกออกมาต่างหาก และอยู่ก่อน SEO
  {
    key: 'traffic',
    name: 'เพิ่มคนเข้าเว็บ',
    match: [
      // ทราฟฟิก / เข้าเว็บ
      'เพิ่มทราฟฟิคเข้าเว็บไซต์',
      'website traffic',
      'mobile traffic',
      'premium traffic',
      'pop-under traffic',
      'worldwide',
      'exchange platforms (ptc)',
      'แหล่งอ้างอิง เลือกประเทศ',
      'choose geo',
      'website 💎 premium traffic packages',
      'website traffic 🇹🇭 ประเทศไทย',

      // รวมฝั่ง SEO มาด้วย
      'backlinks & website seo',
      'seo package ranking',
      'social signals',
      'best google ranking',
      'search console',
      ' seo',
    ],
  },

  // แพลตฟอร์มหลัก
  { key: 'tiktok',    name: 'TikTok',          match: ['tiktok'] },
  { key: 'facebook',  name: 'Facebook',       match: ['facebook'] },
  { key: 'instagram', name: 'Instagram',      match: ['instagram'] },
  { key: 'youtube',   name: 'YouTube',        match: ['youtube', 'yt '] },
  { key: 'threads',   name: 'Threads',        match: ['threads'] },
  { key: 'twitter',   name: 'X (Twitter)',    match: ['x (twitter)', ' twitter', ' tw '] },
  { key: 'line',      name: 'LINE',           match: [' line ', ' line official', 'ไลน์ '] },
  { key: 'telegram',  name: 'Telegram',       match: ['telegram'] },
  { key: 'discord',   name: 'Discord',        match: ['discord'] },
  { key: 'twitch',    name: 'Twitch',         match: ['twitch'] },
  { key: 'spotify',   name: 'Spotify',        match: ['spotify'] },
  { key: 'kick',      name: 'Kick',           match: [' kick '] },

  { key: 'shopee', name: 'ไลฟ์สด Shopee', match: ['shopee', 'shp '] },

  // fallback
  { key: 'other',  name: 'อื่นๆ', match: [] },
];

// ===== ระบบหา Platform และ Subcategory =====
function detectPlatformAndType(service) {
  const name = (service?.name || '');
  const desc = service?.description || service?.details || '';
  const raw  = (name + ' ' + desc).toLowerCase();

  // --- หา platform: ไล่ตาม PLATFORM_MAP (ตอนนี้ premium/thailand มาก่อนแล้ว) ---
  let platform = PLATFORM_MAP.find(p =>
    p.match.some((m) => raw.includes(m.toLowerCase()))
  );
  if (!platform) {
    platform = PLATFORM_MAP.find(p => p.key === 'other');
  }

  // --- หา subcategory แบบง่าย ๆ ตาม keyword ---
  let typeName = 'อื่นๆ';

  if (raw.includes('follow'))       typeName = 'Followers';
  else if (raw.includes('subscr'))  typeName = 'Subscribers';
  else if (raw.includes('like'))    typeName = 'Likes';
  else if (raw.includes('view'))    typeName = 'Views';
  else if (raw.includes('comment')) typeName = 'Comments';
  else if (raw.includes('share'))   typeName = 'Shares';
  else if (raw.includes('member'))  typeName = 'Members';
  else if (raw.includes('traffic')) typeName = 'Website Traffic';
  else if (raw.includes('vote'))    typeName = 'Votes';

  // คืนเป็น object ให้ใช้กับ upsertSubcategory ได้ถูก
  const type = {
    key: typeName.toLowerCase().replace(/\s+/g, '-'),
    name: typeName,
  };

  return { platform, type };
}

function inferStatus({ raw, mapped, prev }) {
  const maybe =
    toBool(raw?.status) ?? toBool(raw?.state) ?? toBool(raw?.enabled) ??
    toBool(raw?.is_active) ?? toBool(raw?.available);
  if (maybe !== undefined) return maybe ? 'open' : 'close';
  if (Number.isFinite(mapped?.rate) && mapped.rate <= 0) return 'close';
  if (prev && (prev.disabled || prev.hidden)) return 'close';
  return 'open';
}

async function upsertCategory(platform) {
  const slug = platform.key;
  return Category.findOneAndUpdate(
    { slug },
    { $set: { name: platform.name, slug } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}
async function upsertSubcategory(categoryId, type) {
  const slug = type.key;
  return Subcategory.findOneAndUpdate(
    { category: categoryId, slug },
    { $set: { category: categoryId, name: type.name, slug } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

export async function syncServicesFromProvider() {
  // กันกดซ้ำ: ตั้งธง (option เสริม แต่ไม่บังคับ)
  const ps0 = await ProviderSettings.findOne() || new ProviderSettings();
  if (ps0.syncInProgress) {
    return { ok:false, message: 'sync is running, try again later' };
  }
  ps0.syncInProgress = true;
  await ps0.save();

  try {
    const rawList = await getServices();
    if (!Array.isArray(rawList)) throw new Error('Provider returned non-array for services');

    // เก็บของเก่าไว้ทำ changeLogs: removed
    const prevList = await Service.find(
      {},
      { providerServiceId:1, name:1, rate:1, disabled:1, hidden:1 }
    ).lean();

    // 1) ล้างทั้งหมดก่อน (FULL REPLACE) — ไม่มี transaction
    await Service.deleteMany({});

    // 2) อัปเดตหมวดหมู่และเตรียมรายการใหม่
    const platformCache = new Map();
    const typeCache = new Map();

    const docs = [];
    const changeLogs = [];
    let created = 0, skipped = 0;

    for (const s of rawList) {
      const providerId = String(pick(s, ['id','service_id','sid','service'], '')).trim();
      if (!providerId) { skipped++; continue; }

      const { platform, type } = detectPlatformAndType(s);

      let plat = platformCache.get(platform.name);
      if (!plat) {
        plat = await upsertCategory(platform);
        platformCache.set(platform.name, plat);
      }

      const typeKey = `${plat._id.toString()}::${type.name}`;
      let sub = typeCache.get(typeKey);
      if (!sub) {
        sub = await upsertSubcategory(plat._id, type);
        typeCache.set(typeKey, sub);
      }

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

      const status = inferStatus({ raw: s, mapped, prev: null });

      docs.push({
        providerServiceId: providerId,
        category: plat._id,
        subcategory: sub._id,
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
        details: s,
        disabled: status === 'close',
        hidden: status === 'close',
      });

      changeLogs.push({
        ts: new Date(),
        target: 'service',
        diff: 'new',
        providerServiceId: providerId,
        platform: platform.name,
        categoryName: type.name,
        serviceName: mapped.name,
        oldStatus: undefined,
        newStatus: status,
        isBootstrap: true,
      });

      created++;
    }

    if (docs.length) await Service.insertMany(docs, { ordered: false });

    // removed logs
    const newPidSet = new Set(docs.map(d => String(d.providerServiceId)));
    for (const prev of prevList) {
      const pid = String(prev.providerServiceId);
      if (!newPidSet.has(pid)) {
        changeLogs.push({
          ts: new Date(),
          target: 'service',
          diff: 'removed',
          providerServiceId: pid,
          platform: undefined,
          categoryName: undefined,
          serviceName: prev.name || `Service #${pid}`,
          oldStatus: inferStatus({ raw:{}, mapped:{ rate: prev.rate }, prev }),
          newStatus: 'close',
          isBootstrap: false,
        });
      }
    }

    // save provider settings + logs
    const ps = await ProviderSettings.findOne() || new ProviderSettings();
    ps.lastSyncAt = new Date();
    await ps.save();

    if (changeLogs.length) {
      try {
        await ChangeLog.insertMany(changeLogs, { ordered: false });
      } catch (e) {
        console.warn('changeLogs insert warning:', e?.writeErrors?.length || e?.message || e);
      }
    }

    // 3) apply pricing rules (นอก “ล้าง–ใส่ใหม่” เพื่อเบา DB)
    const totalInserted = await Service.countDocuments();
    if (totalInserted <= 500) {
      const ids = (await Service.find({}, { _id: 1 }).lean()).map(d => d._id);
      for (const id of ids) await applyRulesToOneService(id);
    } else {
      await applyAllPricingRules();
    }

    console.log(`✅ FULL REPLACE (no transaction): synced ${created} items; skipped: ${skipped}; total: ${await Service.countDocuments()}; logs: ${changeLogs.length}`);
    return { ok:true, count: created, skipped, logs: changeLogs.length, mode: 'full-replace' };

  } finally {
    // ปลดธงกันซ้ำ
    const ps1 = await ProviderSettings.findOne() || new ProviderSettings();
    ps1.syncInProgress = false;
    await ps1.save();
  }
}