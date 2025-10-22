// src/lib/pricing.js
import { PriceRule } from '../models/PriceRule.js';
import { Service } from '../models/Service.js';

const round4 = n => Number((+n).toFixed(4));
const nn = n => Math.max(0, n);

// คืน true ถ้ากฎใช้กับ service/child นี้
function matchRule(rule, s, childId = null) {
  if (rule.scope === 'global') return true;
  if (rule.scope === 'category') return String(s.category) === String(rule.targetId);
  if (rule.scope === 'subcategory') return String(s.subcategory) === String(rule.targetId);

  // scope === 'service'
  // อนุญาต 2 แบบ:
  // - targetId เป็น _id ของ Service document
  // - targetId เป็น id ของบริการย่อย (details.services[].id)
  const tid = String(rule.targetId);
  if (String(s._id) === tid) return true;
  if (childId != null && String(childId) === tid) return true;
  // เผื่อผู้ใช้เลือก child ผ่านกฎ แต่ไม่ได้ส่ง childId: ลองไล่หาในเอกสาร
  if (Array.isArray(s?.details?.services)) {
    return s.details.services.some(c => String(c?.id) === tid);
  }
  return false;
}

function applyMode(oldRate, rule) {
  let r = Number(oldRate || 0);
  if (rule.mode === 'percent') r = r * (1 + Number(rule.value) / 100);
  else if (rule.mode === 'delta') r = r + Number(rule.value);
  else if (rule.mode === 'set') r = Number(rule.value);
  return nn(round4(r));
}

/** Apply ทุกกฎให้กับทั้งระบบ (อัปเดตทั้ง rate และ details.services[].rate) */
export async function applyAllPricingRules() {
  const rules = await PriceRule.find({ isActive: true })
    .sort({ priority: -1, createdAt: -1 })
    .lean();

  if (!rules.length) return { updatedDocs: 0, updatedChildren: 0 };

  const services = await Service.find({});
  let docsTouched = 0;
  let childrenTouched = 0;

  for (const s of services) {
    let topRate = Number(s.rate || 0);
    let topChanged = false;

    // 1) คำนวณให้ rate ด้านบนของเอกสาร
    const matchedForTop = rules.filter(r => matchRule(r, s, null));
    if (matchedForTop.length) {
      for (const r of matchedForTop) topRate = applyMode(topRate, r);
      if (topRate !== s.rate) {
        s.rate = topRate;
        topChanged = true;
      }
    }

    // 2) คำนวณให้บริการย่อยใน details.services[]
    if (Array.isArray(s?.details?.services) && s.details.services.length) {
      let changed = false;

      s.details.services = s.details.services.map(child => {
        let rate = Number(child?.rate || 0);
        const matched = rules.filter(r => matchRule(r, s, child?.id));
        if (matched.length) {
          for (const r of matched) rate = applyMode(rate, r);
          if (rate !== child.rate) {
            changed = true;
            childrenTouched++;
            return { ...child, rate };
          }
        }
        return child;
      });

      if (changed) {
        s.markModified('details');
        docsTouched++;
      }
    }

    if (topChanged) docsTouched++;
    if (topChanged || docsTouched) await s.save();
  }

  return { updatedDocs: docsTouched, updatedChildren: childrenTouched };
}

/** Apply เฉพาะ 1 เอกสาร (ใช้ตอน sync แทรกใหม่) */
export async function applyRulesToOneService(serviceId) {
  const s = await Service.findById(serviceId);
  if (!s) return;

  const rules = await PriceRule.find({ isActive: true })
    .sort({ priority: -1, createdAt: -1 })
    .lean();

  // บนเอกสาร
  let topRate = Number(s.rate || 0);
  for (const r of rules) if (matchRule(r, s, null)) topRate = applyMode(topRate, r);
  if (topRate !== s.rate) s.rate = topRate;

  // บริการย่อย
  if (Array.isArray(s?.details?.services) && s.details.services.length) {
    let changed = false;
    s.details.services = s.details.services.map(child => {
      let rate = Number(child?.rate || 0);
      const matched = rules.filter(r => matchRule(r, s, child?.id));
      if (matched.length) {
        for (const r of matched) rate = applyMode(rate, r);
        if (rate !== child.rate) {
          changed = true;
          return { ...child, rate };
        }
      }
      return child;
    });
    if (changed) s.markModified('details');
  }

  await s.save();
}

// (ใช้งานในบางหน้าเพื่อโชว์ราคาอย่างเดียว)
export function computePrice(oldRate, rule) {
  return applyMode(oldRate, rule);
}
