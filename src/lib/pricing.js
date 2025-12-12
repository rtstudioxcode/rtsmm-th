// src/lib/pricing.js
import { PriceRule } from '../models/PriceRule.js';
import { Service } from '../models/Service.js';

// ─────────────────────────────────────────────────────────────
// Numeric utils
// ─────────────────────────────────────────────────────────────
const round4 = n => Number((+n || 0).toFixed(4));     // สำหรับเรต (เก็บเป็นเลขย่อย ๆ ได้)
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
    const vDoc = String(s?._id ?? '');
    if (anyMatchTargetIds(rule, vDoc)) return true;

    const cid = childId != null ? String(childId) : null;
    if (cid && anyMatchTargetIds(rule, cid)) return true;

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
  else if (rule?.mode === 'delta') r = r + v;
  else if (rule?.mode === 'set') r = v;

  r = nn(round4(r));
  return r < 0 ? 0 : r;
}

// ─────────────────────────────────────────────────────────────
// Unit/step helpers (ชี้ว่าขายต่อ 1 หรือ ต่อ 1000/step อื่น)
// ─────────────────────────────────────────────────────────────
function _isPerPiece(obj = {}) {
  const type = String(obj.type || '').toLowerCase();
  const step = Number(obj.step ?? NaN);
  const min  = Number(obj.min  ?? NaN);
  const max  = Number(obj.max  ?? NaN);
  return (
    type === 'package' ||
    step === 1 ||
    (min === 1 && max === 1)
  );
}

function pickUnitStep(serviceDoc, childId = null) {
  const s = serviceDoc || {};
  if (childId != null && Array.isArray(s?.details?.services)) {
    const c = s.details.services.find(cc => S(cc?.id) === S(childId)) || {};
    if (_isPerPiece(c)) return 1;
    if (Number.isFinite(+c.step) && +c.step > 0) return +c.step;
  }
  if (_isPerPiece(s)) return 1;
  if (Number.isFinite(+s.step) && +s.step > 0) return +s.step;
  return 1000; // fallback เดิม
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

function pickBaseRate(serviceDoc, childId, baseRate) {
  if (typeof baseRate === 'number') return Number(baseRate || 0);
  const s = serviceDoc || {};
  if (childId != null && Array.isArray(s?.details?.services)) {
    const child = s.details.services.find(c => S(c?.id) === S(childId));
    return Number(child?.rate ?? s.rate ?? 0);
  }
  return Number(s.rate || 0);
}

async function fetchActiveRules() {
  return PriceRule.find({ isActive: true })
    .sort({ priority: -1, createdAt: -1 })
    .lean();
}

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

async function _computeEffectiveRateCore({ service, serviceId, childId = null, userId = null, baseRate, ignoreRules = false }) {
  let s = service;
  if (!s) {
    if (!serviceId) throw new Error('computeEffectiveRate: require service or serviceId');
    s = await Service.findById(serviceId).lean();
    if (!s) throw new Error('computeEffectiveRate: service not found');
  }

  const base = pickBaseRate(s, childId, baseRate);

  const matched = ignoreRules
    ? []
    : filterRulesForContext(await fetchActiveRules(), s, childId, userId);
  matched.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));

  let rate = base;
  for (const r of matched) rate = applyMode(rate, r);

  if (!Number.isFinite(rate) || isNaN(rate)) rate = Number(s.rate || 0);
  if (rate < 0) rate = 0;

  return { serviceDoc: s, baseRate: round4(base), finalRate: round4(rate) };
}

export async function computeEffectiveRate(opts = {}) {
  const { finalRate } =
  await _computeEffectiveRateCore(opts);
  return finalRate;
}

/**
 * เวอร์ชันขยาย — คืน { baseRate, finalRate, lineCost, step }
 * - lineCost จะคำนวณตาม step:
 *    - ถ้า step = 1 (หรือ type=Package/min-max=1)  → lineCost = qty * finalRate
 *    - ถ้า step > 1 → lineCost = (qty / step) * finalRate
 */
export async function computeEffectiveRateEx(opts = {}) {
  const { quantity, childId } = opts;
  const { serviceDoc, baseRate, finalRate } = await _computeEffectiveRateCore(opts);

  const step = pickUnitStep(serviceDoc, childId);
  let lineCost = undefined;

  if (quantity != null) {
    const qty = Number(quantity) || 0;
    lineCost = step <= 1
      ? round2(qty * finalRate)
      : round2((qty / step) * finalRate);
  }
  return { baseRate, finalRate, lineCost, step };
}

/**
 * ดึงราคาที่คำนวณแล้วทั้ง “หัวเอกสาร” และ “children” สำหรับผู้ใช้รายหนึ่ง
 */
export async function computeEffectiveServiceBundle(serviceId, userId, opts = {}) {
  let options = {};
  if (opts && typeof opts === 'object') options = opts;

  const s = await Service.findById(serviceId).lean();
  if (!s) throw new Error('service not found');

  const top = await computeEffectiveRateEx({
    service: s,
    userId,
    quantity: options.quantityTop,
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
          baseRate: c.rate,
          quantity: childQuantities[String(c.id)],
        });
        return {
          ...c,
          step: ex.step,
          effectiveRate: ex.finalRate,
          effectiveLineCost: ex.lineCost,
        };
      })
    );
  }

  return {
    service: s,
    step: pickUnitStep(s, null),
    effectiveRate: top.finalRate,
    effectiveLineCost: top.lineCost,
    children,
  };
}
