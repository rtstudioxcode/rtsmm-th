// services/configService.js
import { AppConfig } from '../models/AppConfig.js';

let _cache = null;
let _loadedAt = 0;
const TTL_MS = 30 * 1000; // รีเฟรชทุก 30 วิ (พอดีกับงานแอดมินแก้สด)

async function _loadAll() {
  const docs = await AppConfig.find({}).lean();
  const map = {};
  for (const d of docs) map[d.key] = d.value;
  _cache = map;
  _loadedAt = Date.now();
  return _cache;
}

async function ensureCache() {
  if (!_cache || (Date.now() - _loadedAt) > TTL_MS) {
    await _loadAll();
  }
}

export async function get(key, fallback = undefined) {
  await ensureCache();
  const segs = String(key).split('.');
  let cur = _cache;
  for (const s of segs) {
    if (cur == null) break;
    cur = cur[s];
  }
  return (cur === undefined) ? fallback : cur;
}

export async function requireKey(key) {
  const v = await get(key);
  if (v === undefined) throw new Error(`Missing config: ${key}`);
  return v;
}

export async function set(key, value, { secret = false, updatedBy = '' } = {}) {
  // บันทึกเป็นทั้งชุด เช่น set('smtp', {...})
  const doc = await AppConfig.findOneAndUpdate(
    { key },
    { $set: { key, value, secret, updatedBy } },
    { upsert: true, new: true }
  ).lean();
  // อัปเดตแคชในหน่วยความจำ
  if (!_cache) _cache = {};
  _cache[key] = doc.value;
  return doc.value;
}
