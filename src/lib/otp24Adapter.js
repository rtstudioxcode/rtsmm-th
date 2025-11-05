// src/lib/otp24Adapter.js
import { getOtp24Config } from '../config.js';

function buildUrl(action, extraQuery = {}) {
  const { baseUrl, apiKey } = getOtp24Config();
  if (!baseUrl) throw new Error('otp24.baseUrl is not configured');
  const u = new URL(baseUrl);
  u.searchParams.set('action', action);
  // ส่ง keyapi เสมอ (บางเอนด์พอยต์เงียบ ๆ แต่ต้องใช้)
  if (apiKey) u.searchParams.set('keyapi', apiKey);
  for (const [k, v] of Object.entries(extraQuery || {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function getJson(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json, */*' }, signal: ctrl.signal });
    const raw = await res.text();
    let data; try { data = JSON.parse(raw); } catch { data = raw; }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  } finally { clearTimeout(t); }
}

const unwrap = (payload) => {
  // กรณี array อยู่แล้ว
  if (Array.isArray(payload)) return payload;

  // กรณี payload มีฟิลด์ data/result/items เป็น array
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.result)) return payload.result;
    if (Array.isArray(payload.items)) return payload.items;

    // >>> กรณีแบบ getgames: เป็น object ที่ key = code ของเกม
    //    { "FREEFIRE": {...}, "ROV-M": {...}, ... }
    const vals = Object.values(payload);
    // ให้ผ่านเฉพาะที่หน้าตาเป็น object จริง ๆ
    if (vals.length && vals.every(v => v && typeof v === 'object')) return vals;
  }

  return [];
};

/** ── BALANCE (คงเดิม) ───────────────────────────────────── */
export async function getOtp24Balance() {
  const { apiKey } = getOtp24Config();
  if (!apiKey) throw new Error('otp24.apiKey is not configured');

  const u = new URL(buildUrl('balance'));
  const form = new URLSearchParams();
  form.set('keyapi', apiKey);

  const res = await fetch(u.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json, */*' },
    body: form.toString(),
  });
  const raw = await res.text();
  let data; try { data = JSON.parse(raw); } catch { data = raw; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const toNumber = v => {
    const n = Number(String(v).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  if (typeof data === 'object' && data) {
    if (data.balance != null) return toNumber(data.balance);
    if (data.credit  != null) return toNumber(data.credit);
    if (data.data?.balance != null) return toNumber(data.data.balance);
  }
  return toNumber(data);
}

/** ── PRODUCTS ───────────────────────────────────────────── */
export async function getPack() {
  const data = await getJson(buildUrl('getpack'));
  return unwrap(data);
}

export async function getGames() {
  const data = await getJson(buildUrl('getgames'));
  return unwrap(data);
}

export async function getOtpLiveList(params = {}) {
  const data = await getJson(buildUrl('getotp', params));
  return unwrap(data);
}
