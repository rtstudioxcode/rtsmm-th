// src/lib/pricing.js
import { PriceRule } from '../models/PriceRule.js';
import { Service } from '../models/Service.js';

// ─────────────────────────────────────────────────────────────
// Numeric utils
// ─────────────────────────────────────────────────────────────
const round4 = n => Number((+n || 0).toFixed(4));     // สำหรับเรตต่อ 1k
const round2 = n => Number((+n || 0).toFixed(2));     // สำหรับจำนวนเงิน
const nn = n => Math.max(0, Number.isFinite(+n) ? +n : 0);
const S  = v => (v == null ? '' : String(v));

// ─────────────────────────────────────────────────────────────
// Match helpers (รองรับ targetIds, scopes, และ child services)
// ─────────────────────────────────────────────────────────────

function anyMatchTargetIds(rule, valStr) {
  if (!valStr) return false;
  const one  = (rule?.targetId ?? '').toString();
  const many = Array.isArray(rule?.targetIds) ? rule.targetIds.map(String) : [];
  return (one && one === valStr) || (many.length && many.includes(valStr));
}

function matchRule(rule, s, childId = null) {
  const scope = rule?.scope;

  if (scope === 'global') return true;

  if (scope === 'category') {
    const v = String(s?.category ?? s?.cat?._id ?? s?.categoryId ?? '');
    return anyMatchTargetIds(rule, v);
  }

  if (scope === 'subcategory') {
    const v = String(s?.subcategory ?? s?.sub?._id ?? s?.subcategoryId ?? '');
    return anyMatchTargetIds(rule, v);
  }

  if (scope === 'service') {
    // จับที่ระดับเอกสาร Service (_id)
    const vDoc = String(s?._id ?? '');
    if (anyMatchTargetIds(rule, vDoc)) return true;

    // back-compat: dev บางรายเคยใส่ child.id ใน scope=service
    const cid = childId != null ? String(childId) : null;
    if (cid && anyMatchTargetIds(rule, cid)) return true;

    // ไล่ใน children
    if (Array.isArray(s?.details?.services)) {
      return s.details.services.some(c => anyMatchTargetIds(rule, String(c?.id)));
    }
    return false;
  }

  if (scope === 'serviceChild') {
    const cid = childId != null ? String(childId) : null;
    return !!(cid && anyMatchTargetIds(rule, cid));
  }

  return false;
}

function applyMode(oldRate, rule) {
  let r = Number(oldRate || 0);
  const v = Number(rule?.value || 0);

  if (rule?.mode === 'percent') r = r * (1 + v / 100);
  else if (rule?.mode === 'delta') r = r + v;      // (ถ้าจะส่งเป็นต่อ 1k ก็ส่งตรงนี้มาเลย)
  else if (rule?.mode === 'set') r = v;

  r = nn(round4(r));
  return r < 0 ? 0 : r;
}

// ─────────────────────────────────────────────────────────────
// NO-OP writers (แนวทางใหม่: ไม่เขียนทับ Service ใน DB)
// ─────────────────────────────────────────────────────────────
export async function applyAllPricingRules() {
  return { updatedDocs: 0, updatedChildren: 0, noop: true };
}
export async function applyRulesToOneService() {
  return { updated: false, noop: true };
}

// คงไว้เพื่อความเข้ากันได้กับโค้ดเก่า
export function computePrice(oldRate, rule) {
  return applyMode(oldRate, rule);
}

// ─────────────────────────────────────────────────────────────
// Core runtime pricing (ไม่แตะ DB) — ต่อผู้ใช้ / ต่อ child
// ─────────────────────────────────────────────────────────────

/**
 * คำนวณ "เรตฐาน" ก่อนใช้กฎ
 * - ถ้ามี childId: ใช้ rate ของ child (details.services[].rate) ถ้ามี, ไม่งั้นใช้ s.rate
 * - ถ้าไม่มี childId: ใช้ baseRate ที่ส่งมา (ถ้ามี) ไม่งั้นใช้ s.rate
 */
function pickBaseRate(serviceDoc, childId, baseRate) {
  if (typeof baseRate === 'number') return Number(baseRate || 0);
  const s = serviceDoc || {};
  if (childId != null && Array.isArray(s?.details?.services)) {
    const child = s.details.services.find(c => S(c?.id) === S(childId));
    return Number(child?.rate ?? s.rate ?? 0);
  }
  return Number(s.rate || 0);
}

/** ดึงกฎ (active) ทั้งหมด เรียงตาม priority สูง→ต่ำ แล้วตาม createdAt ใหม่→เก่า */
async function fetchActiveRules() {
  return PriceRule.find({ isActive: true })
    .sort({ priority: -1, createdAt: -1 })
    .lean();
}

/**
 * คัดกฎที่เข้าเงื่อนไข scope + user
 * userScope: 'all' | 'user'
 */
function filterRulesForContext(rules, serviceDoc, childId, userId) {
  return rules.filter(r => {
    if (!matchRule(r, serviceDoc, childId)) return false;

    const scope = r?.userScope ?? 'all';
    if (scope === 'all') return true;

    if (scope === 'user' && userId) {
      if (r.userId && String(r.userId) === String(userId)) return true;
      if (Array.isArray(r.userIds) && r.userIds.some(uid => String(uid) === String(userId))) return true;
    }
    return false;
  });
}

/** คำนวณเรตสุดท้ายจากเรตฐาน + กฎที่เข้าเงื่อนไข */
async function _computeEffectiveRateCore({ service, serviceId, childId = null, userId = null, baseRate }) {
  let s = service;
  if (!s) {
    if (!serviceId) throw new Error('computeEffectiveRate: require service or serviceId');
    s = await Service.findById(serviceId).lean();
    if (!s) throw new Error('computeEffectiveRate: service not found');
  }

  const base = pickBaseRate(s, childId, baseRate);

  const rules = await fetchActiveRules();
  const matched = filterRulesForContext(rules, s, childId, userId);

  // apply ตาม priority (สูงก่อน) และ createdAt (ใหม่ก่อน) — เผื่อมีการ sort ซ้ำ
  matched.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));

  let rate = base;
  for (const r of matched) {
    rate = applyMode(rate, r);
  }

  // safety
  if (!Number.isFinite(rate) || isNaN(rate)) rate = Number(s.rate || 0);
  if (rate < 0) rate = 0;

  return { baseRate: round4(base), finalRate: round4(rate) };
}

/**
 * (เดิม) คืนค่าคือ "finalRate" เป็นตัวเลขเดียว — คงความเข้ากันได้
 * opts: { service, serviceId, childId?, userId?, baseRate? }
 */
export async function computeEffectiveRate(opts = {}) {
  const { finalRate } = await _computeEffectiveRateCore(opts);
  return finalRate;
}

/**
 * (ใหม่) เวอร์ชันขยาย — อยากได้ทั้ง baseRate/finalRate และ lineCost ในการยิงออเดอร์
 * opts: { service, serviceId, childId?, userId?, baseRate?, quantity? }
 * returns: { baseRate, finalRate, lineCost? }
 */
export async function computeEffectiveRateEx(opts = {}) {
  const { quantity } = opts;
  const { baseRate, finalRate } = await _computeEffectiveRateCore(opts);

  let lineCost = undefined;
  if (quantity != null) {
    // lineCost = qty * (rate per 1k) / 1000
    lineCost = round2((Number(quantity) || 0) * finalRate / 1000);
  }
  return { baseRate, finalRate, lineCost };
}

/**
 * ดึงราคาที่คำนวณแล้วทั้ง “หัวเอกสาร” และ “children” สำหรับผู้ใช้รายหนึ่ง
 * (ยังคงซิกเนเจอร์เดิมเพื่อ back-compat)
 * ใช้แบบใหม่: computeEffectiveServiceBundle(serviceId, userId, { quantityTop, childQuantities: { [childId]: qty } })
 */
export async function computeEffectiveServiceBundle(serviceId, userId, opts = {}) {
  // รองรับซิกเนเจอร์เดิม (2 พารามิเตอร์)
  let options = {};
  if (opts && typeof opts === 'object') {
    options = opts;
  }

  const s = await Service.findById(serviceId).lean();
  if (!s) throw new Error('service not found');

  const top = await computeEffectiveRateEx({
    service: s,
    userId,
    quantity: options.quantityTop, // อาจไม่ใส่ก็ได้
  });

  let children = [];
  if (Array.isArray(s?.details?.services)) {
    const childQuantities = options.childQuantities || {}; // { [childId]: qty }
    children = await Promise.all(
      s.details.services.map(async (c) => {
        const ex = await computeEffectiveRateEx({
          service: s,
          childId: c.id,
          userId,
          baseRate: c.rate,                         // ยึดต้นทุน child ตาม provider
          quantity: childQuantities[String(c.id)],  // ถ้าอยากได้ lineCost ของแต่ละ child
        });
        return { ...c, effectiveRate: ex.finalRate, effectiveLineCost: ex.lineCost };
      })
    );
  }

  return {
    service: s,
    effectiveRate: top.finalRate,
    effectiveLineCost: top.lineCost,
    children,
  };
}
