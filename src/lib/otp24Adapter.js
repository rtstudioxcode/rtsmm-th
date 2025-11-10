// src/lib/otp24Adapter.js
import { config, refreshConfigFromDB } from '../config.js';

/* ---------- helpers ---------- */
function cleanBase(v) {
  const s = String(v || '');
  return s.replace(/\?.*$/, '').replace(/\/+$/, ''); // ตัด query และ / ท้าย
}

function assertConfigured() {
  const baseRaw = (config?.otp24hr?.apiBase || '');
  const key  = (config?.otp24hr?.apiKey || '').trim();
  if (!baseRaw) throw new Error('otp24hr.apiBase is not configured');
  if (!key)     throw new Error('otp24hr.apiKey is not configured');
  let base = cleanBase(baseRaw);
  return { base, key };
}

function parseMaybeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function parseLoose(text) {
  const t = (text || '').trim();
  const j = parseMaybeJson(t);
  if (j) return j;
  try { return Object.fromEntries(new URLSearchParams(t)); } catch { return null; }
}

function pickNumber(str) {
  // ดึงเลขทศนิยมแรกที่ดู “เหมือนจำนวนเงิน”
  const m = String(str).match(/([\d]{1,3}(?:[.,]\d{3})*[.,]\d+|\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function extractBalance(obj, text = '') {
  // 1) JSON shapes ยอดฮิต
  if (obj && typeof obj === 'object') {
    const keys = [
      'balance','credit','credits','amount','wallet','result','data'
    ];
    // ตรงตัวก่อน
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        const v = obj[k];
        if (v != null && typeof v !== 'object') {
          const n = Number(String(v).replace(/,/g, ''));
          if (Number.isFinite(n)) return n;
        }
      }
    }
    // ซ้อนชั้น
    for (const k of keys) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        const n = extractBalance(v, text);
        if (Number.isFinite(n)) return n;
      }
    }
    // วนทุกคีย์หา *balance* แบบหลวม
    for (const k of Object.keys(obj)) {
      if (/balance|credit/i.test(k)) {
        const n = Number(String(obj[k]).replace(/,/g, ''));
        if (Number.isFinite(n)) return n;
      }
    }
  }

  // 2) ข้อความล้วน (อังกฤษ/ไทย)
  // ตัวอย่างที่เจอบ่อย: 'balance: 763.41', 'คงเหลือ : 763.41 บาท'
  const rxes = [
    /balance[^0-9]*([\d.,]+)/i,
    /credit[^0-9]*([\d.,]+)/i,
    /คงเหลือ[^0-9]*([\d.,]+)/i,
    /ยอดคงเหลือ[^0-9]*([\d.,]+)/i
  ];
  for (const rx of rxes) {
    const m = String(text).match(rx);
    if (m) {
      const n = Number(String(m[1]).replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  // 3) สุดท้ายหยิบเลขแรกที่ดูเหมือนจำนวนเงิน
  return pickNumber(text);
}

async function fetchWithTimeout(resource, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('Fetch timeout')), timeoutMs);
  try {
    return await fetch(resource, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function tryPostUrlEncoded(base, key) {
  const url = `${base}?action=balance`;
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams({ keyapi: key }).toString();
  const res = await fetchWithTimeout(url, { method: 'POST', headers, body }, 15000);
  const text = await res.text();
  const json = parseMaybeJson(text);
  const bal  = extractBalance(json, text);
  return { ok: res.ok && Number.isFinite(bal), bal, text, json, via: 'POST' };
}

async function tryPostMultipart(base, key) {
  const url = `${base}?action=balance`;
  const fd = new FormData();
  fd.append('keyapi', key);
  const res = await fetchWithTimeout(url, { method: 'POST', body: fd }, 15000);
  const text = await res.text();
  const json = parseMaybeJson(text);
  const bal  = extractBalance(json, text);
  return { ok: res.ok && Number.isFinite(bal), bal, text, json, via: 'FORM' };
}

async function tryGet(base, key) {
  const url = `${base}?action=balance&keyapi=${encodeURIComponent(key)}`;
  const res = await fetchWithTimeout(url, { method: 'GET' }, 15000);
  const text = await res.text();
  const json = parseMaybeJson(text);
  const bal  = extractBalance(json, text);
  return { ok: res.ok && Number.isFinite(bal), bal, text, json, via: 'GET' };
}

// ─────────────────────────────────────────────────────────
// OTP24: Buy & Status
// ─────────────────────────────────────────────────────────
export const OTP24_COUNTRIES = Object.freeze({
  52:'Thailand',187:'USA',16:'United Kingdom',6:'Indonesia',10:'Vietnam',5:'Myanmar',
  1:'Ukraine',19:'Nigeria',62:'Turkey',3:'China',4:'Philippines',24:'Cambodia',
  25:'Laos',7:'Malaysia',21:'Egypt'
});

/* ---------- Public ---------- */
/**
 * ดึงยอดคงเหลือจาก OTP24hr
 * คืน: { ok:true, balance, currency:'THB', raw, via } | { ok:false, error, raw, via }
 */
export async function getOtp24Balance() {
  await refreshConfigFromDB();
  const { base, key } = assertConfigured();

  const attempts = [];
  try {
    attempts.push(await tryPostUrlEncoded(base, key));
  } catch (e) {
    attempts.push({ ok: false, error: e?.message || String(e), via: 'POST' });
  }

  if (!attempts.at(-1).ok) {
    try { attempts.push(await tryPostMultipart(base, key)); }
    catch (e) { attempts.push({ ok: false, error: e?.message || String(e), via: 'FORM' }); }
  }

  if (!attempts.at(-1).ok) {
    try { attempts.push(await tryGet(base, key)); }
    catch (e) { attempts.push({ ok: false, error: e?.message || String(e), via: 'GET' }); }
  }

  const success = attempts.find(a => a.ok);
  if (success) {
    return {
      ok: true,
      balance: Number(success.bal),
      currency: 'THB',
      raw: success.json ?? success.text,
      via: success.via
    };
  }

  // รวมข้อความ error สั้นๆ + แนบ raw ของครั้งล่าสุด
  const last = attempts.at(-1);
  const msg = attempts.map(a => a.ok ? null : a.via).filter(Boolean).length
    ? `Unable to parse balance (${attempts.map(a => a.via).join('→')})`
    : 'Unable to parse balance';

  return {
    ok: false,
    error: msg,
    raw: (last?.text || last?.json || null)
  };
}

// ============ Public: getOtp24Products ============
// ─────────────────────────────────────────────────────────────
// Public: getOtp24Products(per=40)
// ดึงรายการสินค้า/บริการจาก OTP24HR (แถม per = 40%)
// คืนค่า: { ok:true, items:[{name, basePrice, price, ...}], raw }
// ─────────────────────────────────────────────────────────────
export async function getOtp24Products(opts) {
  await refreshConfigFromDB();
  const { base } = assertConfigured();

  // รองรับ backward-compat: getOtp24Products(40)
  let apiPerc = 0;   // ให้ API บวกเท่าไหร่ (ควร 0)
  let addPerc = 50;  // เราจะบวกขายเท่าไหร่ (ดีฟอลต์ 50%)
  if (typeof opts === 'number') {
    apiPerc = Number.isFinite(opts) ? Number(opts) : 0;
  } else if (opts && typeof opts === 'object') {
    apiPerc = Number.isFinite(Number(opts.apiPerc)) ? Number(opts.apiPerc) : 0;
    addPerc = Number.isFinite(Number(opts.addPerc)) ? Number(opts.addPerc) : 50;
  }

  const url = `${base}?action=getotp&per=${encodeURIComponent(Math.max(0, apiPerc))}`;

  try {
    const res  = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }, 20000);

    const text = await res.text();
    const json = parseMaybeJson(text);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, raw: json ?? text };

    // normalize list
    let list = [];
    if (Array.isArray(json)) list = json;
    else if (Array.isArray(json?.data)) list = json.data;
    else if (Array.isArray(json?.result)) list = json.result;
    else if (json && typeof json === 'object') {
      const vals = Object.values(json);
      if (vals.length && vals.every(v => typeof v === 'object')) list = vals;
    }
    if (!Array.isArray(list) || !list.length) {
      return { ok: false, error: 'Unable to parse products', raw: text };
    }

    const round2 = n => Math.round(Number(n || 0) * 100) / 100;
    const apiFactor = 1 + (apiPerc / 100);
    const addFactor = 1 + (addPerc / 100);

    const items = list.map(it => {
      const name  = String(it.name || it.app || it.title || it.service || it.plan || it.product || 'Unknown').trim();
      const id    = it.id ?? it.itemId ?? it.code ?? it.service_id ?? null;

      // ถ้า API ถูกสั่งให้บวกมาแล้ว (apiPerc>0) ให้ถอดกลับเป็น base ด้วยการหาร apiFactor
      const rawPriceFromApi = Number(it.price ?? it.cost ?? it.rate ?? it.amount ?? 0);
      const inferredBase    = apiPerc > 0 ? (rawPriceFromApi / apiFactor) : rawPriceFromApi;

      const basePrice  = round2(inferredBase);
      const finalPrice = round2(basePrice * addFactor);

      return {
        // อย่าใส่คีย์ที่เป็น null ลง unique index -> แปลงเป็น undefined
        itemId: (id != null) ? String(id) : undefined,
        code:   (it.code != null) ? String(it.code) : undefined,
        type:   (it.type != null) ? String(it.type) : undefined,
        name,
        basePrice,
        price: finalPrice,
        currency:  String(it.currency || 'THB'),
        country:   it.country || it.cc || it.iso || undefined,
        category:  (it.category || it.type || 'otp').toString().toLowerCase(),
        raw:       it,
        syncedAt:  new Date(),
      };
    }).filter(x => x.name && Number.isFinite(x.price));

    return { ok: true, items, raw: json ?? text, addPerc, apiPerc };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), raw: null };
  }
}

/** ซื้อ OTP (action=buyotp) 
 *  payload: { type: <รหัสบริการ>, ct: <รหัสประเทศ> }
 *  คืน: { ok, orderId, phone, raw }
 */
// พยายามยิงแบบ multipart/form-data
async function tryBuy_PostUrlEncoded(base, key, { type, ct }) {
  const url  = `${base}?action=buyotp`;
  const body = new URLSearchParams({
    action: 'buyotp',
    keyapi: key,
    key:    key,           // กันบางระบบที่ตรวจชื่อ 'key'
    type:   String(type),
    ct:     String(ct),
  }).toString();

  const res  = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
    20000
  );
  const text = await res.text();
  const json = parseLoose(text) ?? undefined;
  return { ok: res.ok, text, json, via: 'POST-urlencoded' };
}

// พยายามยิงแบบ multipart/form-data
async function tryBuy_PostMultipart(base, key, { type, ct }) {
  const url = `${base}?action=buyotp`;
  const fd  = new FormData();
  fd.set('action', 'buyotp');
  fd.set('keyapi', key);
  fd.set('key', key);      // บางระบบดูตัวนี้
  fd.set('type', String(type));
  fd.set('ct',   String(ct));

  const res  = await fetchWithTimeout(url, { method: 'POST', body: fd }, 20000);
  const text = await res.text();
  const json = parseLoose(text) ?? undefined;
  return { ok: res.ok, text, json, via: 'POST-multipart' };
}

// พยายามยิงแบบ GET query ล้วน (บาง API ยอม)
async function tryBuy_Get(base, key, { type, ct }) {
  const qs  = new URLSearchParams({
    action: 'buyotp',
    keyapi: key,
    key:    key,
    type:   String(type),
    ct:     String(ct),
  }).toString();

  const url  = `${base}?${qs}`;
  const res  = await fetchWithTimeout(url, { method: 'GET' }, 20000);
  const text = await res.text();
  const json = parseLoose(text) ?? undefined;
  return { ok: res.ok, text, json, via: 'GET' };
}

// ----------------------------------------------
// ใช้ฟังก์ชันใหม่แทนตัวเก่า
export async function buyOtp({ type, ct }) {
  await refreshConfigFromDB();
  const { base: rawBase, key } = assertConfigured();
  const base = rawBase.replace(/\?.*$/, '').replace(/\/+$/, ''); // clean

  const attempts = [];
  try {
    attempts.push(await tryBuy_PostUrlEncoded(base, key, { type, ct }));
  } catch (e) {
    attempts.push({ ok:false, text:String(e?.message||e), json:undefined, via:'POST-urlencoded' });
  }

  if (!attempts.at(-1).ok) {
    try { attempts.push(await tryBuy_PostMultipart(base, key, { type, ct })); }
    catch (e) { attempts.push({ ok:false, text:String(e?.message||e), json:undefined, via:'POST-multipart' }); }
  }

  if (!attempts.at(-1).ok) {
    try { attempts.push(await tryBuy_Get(base, key, { type, ct })); }
    catch (e) { attempts.push({ ok:false, text:String(e?.message||e), json:undefined, via:'GET' }); }
  }

  // ใช้ผลลัพธ์ล่าสุดที่ ok (หรืออันสุดท้ายถ้าไม่มี ok)
  const best = attempts.slice().reverse().find(a => a.ok) ?? attempts.at(-1);

  // helper หยิบค่าแรกที่มี
  const pick = (...vals) => vals.find(v => v != null && String(v).trim() !== '');

  const src = best?.json ?? {};
  // normalise key-name เผื่อมีเว้นวรรค/ตัวพิมพ์ใหญ่
  const normalise = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [k,v] of Object.entries(obj)) {
      out[String(k).trim().toLowerCase()] = v;
    }
    return out;
  };
  const nx = normalise(src);
  const nxData = normalise(src?.data);
  const nxPayload = normalise(src?.payload);

  let orderId = pick(
    nx?.order_id, nx?.orderid, nx?.id, nx?.order,
    nxData?.order_id, nxData?.id,
    nxPayload?.order_id, nxPayload?.id
  );
  let phone = pick(
    nx?.number, nx?.phone, nx?.msisdn, nx?.mobile,
    nxData?.number, nxData?.phone,
    nxPayload?.number
  );

  // สำรอง: regex จากข้อความล้วน
  if (!orderId) {
    const m = String(best?.text || '').match(/(?:order[_\s-]*id|["']id["'])\s*[:=]\s*["']?([\w-]+)/i);
    if (m) orderId = m[1];
  }
  if (!phone) {
    const n = String(best?.text || '').match(/(?:number|phone|msisdn)\s*[:=]\s*["']?([\d+ -]+)/i);
    if (n) phone = n[1]?.replace(/\s+/g,'');
  }

  if (best?.ok && orderId) {
    return { ok:true, orderId:String(orderId), phone: phone || null, rawText: best.text, raw: best.json, attempts };
  }

  // ล้มเหลว: ส่งรายละเอียดความพยายามให้ route แสดง
  const compact = attempts.map(a => ({
    via: a.via,
    ok: !!a.ok,
    textSample: (a.text || '').slice(0, 220)
  }));
  return { ok:false, error:'No order_id in response', rawText: best?.text, raw: best?.json, attempts: compact };
}

/* ------------------------------------------------------------------
 * ซื้อ OTP โดยใช้ "เบอร์เดิม" (action=buyotpagain)
 * payload: { orderId }
 * คืน: { ok, status, msg, id, order_id, number, price_ori, app, credit_total, rawText, raw }
 * ------------------------------------------------------------------ */
export async function buyOtpAgain({ orderId }) {
  await refreshConfigFromDB();
  const { base: rawBase, key } = assertConfigured();
  const base = rawBase.replace(/\?.*$/, '').replace(/\/+$/, '');

  if (!orderId) return { ok:false, status:'error', msg:'missing orderId' };

  // ---- helpers (3 ทางเหมือน buyOtp) ----
  const tryUrlEncoded = async () => {
    const url  = `${base}?action=buyotpagain`;
    const body = new URLSearchParams({
      action:   'buyotpagain',
      keyapi:   key,
      key:      key,           // กันบางระบบที่ตรวจ 'key'
      order_id: String(orderId),
    }).toString();

    const res  = await fetchWithTimeout(
      url,
      { method:'POST', headers:{ 'content-type':'application/x-www-form-urlencoded' }, body },
      20000
    );
    const text = await res.text();
    const json = parseLoose(text) ?? undefined;
    return { ok: res.ok, text, json, via:'POST-urlencoded' };
  };

  const tryMultipart = async () => {
    const url = `${base}?action=buyotpagain`;
    const fd  = new FormData();
    fd.set('action',   'buyotpagain');
    fd.set('keyapi',   key);
    fd.set('key',      key);
    fd.set('order_id', String(orderId));

    const res  = await fetchWithTimeout(url, { method:'POST', body:fd }, 20000);
    const text = await res.text();
    const json = parseLoose(text) ?? undefined;
    return { ok: res.ok, text, json, via:'POST-multipart' };
  };

  const tryGet = async () => {
    const qs  = new URLSearchParams({
      action:   'buyotpagain',
      keyapi:   key,
      key:      key,
      order_id: String(orderId),
    }).toString();
    const url  = `${base}?${qs}`;
    const res  = await fetchWithTimeout(url, { method:'GET' }, 20000);
    const text = await res.text();
    const json = parseLoose(text) ?? undefined;
    return { ok: res.ok, text, json, via:'GET' };
  };

  // ---- พยายามตามลำดับ ----
  const attempts = [];
  try { attempts.push(await tryUrlEncoded()); }
  catch (e) { attempts.push({ ok:false, text:String(e?.message||e), json:undefined, via:'POST-urlencoded' }); }

  if (!attempts.at(-1).ok) {
    try { attempts.push(await tryMultipart()); }
    catch (e) { attempts.push({ ok:false, text:String(e?.message||e), json:undefined, via:'POST-multipart' }); }
  }

  if (!attempts.at(-1).ok) {
    try { attempts.push(await tryGet()); }
    catch (e) { attempts.push({ ok:false, text:String(e?.message||e), json:undefined, via:'GET' }); }
  }

  const best = attempts.slice().reverse().find(a => a.ok) ?? attempts.at(-1);

  // normalize keys (รองรับตัวพิมพ์/ช่องว่างต่างกัน)
  const norm = (obj) => {
    if (!obj || typeof obj !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[String(k).trim().toLowerCase()] = v;
    return out;
  };
  const j  = norm(best?.json ?? {});
  const jd = norm((best?.json && best.json.data) || {});
  const jp = norm((best?.json && best.json.payload) || {});

  const pick = (...vals) => vals.find(v => v != null && String(v).trim() !== '');

  const status  = String(pick(j.status, jd.status, jp.status, '') || '').toLowerCase();
  const msg     = pick(j.msg, j.message, jd.msg, jp.msg) || '';
  const id      = pick(j.id, jd.id, jp.id);
  const order_id= pick(j.order_id, j.orderid, jd.order_id, jp.order_id, id);
  const number  = pick(j.number, j.phone, jd.number, jp.number);
  const price   = pick(j.price_ori, j.price, jd.price_ori);
  const app     = pick(j.app, jd.app, j.name, jd.name);
  const credit  = pick(j.credit_total, j.credit_toltal, j.balance, jd.credit_total);

  const ok = !!best?.ok && !!order_id && (status === 'success' || status === 'ok' || status === 'successfully');

  if (ok) {
    return {
      ok: true,
      status: 'success',
      msg: msg || 'buyotpagain success',
      id: id ?? order_id,
      order_id: String(order_id),
      number: number || null,
      price_ori: price != null ? Number(String(price).replace(/,/g,'')) : null,
      app: app || null,
      credit_total: credit != null ? Number(String(credit).replace(/,/g,'')) : null,
      rawText: best.text,
      raw: best.json
    };
  }

  // กรณี error
  return {
    ok: false,
    status: status || 'error',
    msg: msg || 'buyotpagain failed',
    id: id ?? null,
    order_id: order_id ?? null,
    number: number ?? null,
    price_ori: price ?? null,
    app: app ?? null,
    credit_total: credit ?? null,
    rawText: best?.text,
    raw: best?.json
  };
}

/** เช็คสถานะ OTP 
 *  GET /api/v1/otp_status?order_id=XXX
 *  คืน: { ok, status, otp, msg, raw }
 */
export async function getOtpStatus(orderId) {
  await refreshConfigFromDB();
  const { base, key } = assertConfigured(); // key มาจาก config ใน DB
  const endpoint = base.replace(/\?.*$/,'').replace(/\/+$/,'');
  const q = new URLSearchParams({ order_id: String(orderId) });
  if (key) q.set('keyapi', key);

  // ตัวช่วยแปลง text -> object เผื่อบางรอบส่ง urlencoded กลับมา
  const parseLoose = (text) => {
    const t = (text || '').trim();
    const j = parseMaybeJson(t);
    if (j) return j;
    try { return Object.fromEntries(new URLSearchParams(t)); } catch { return null; }
  };

  // --- ทางหลัก: GET ---
  try {
    const url = `${endpoint}/otp_status?${q.toString()}`;
    const res = await fetchWithTimeout(url, { method:'GET', headers:{ accept:'application/json' } }, 15000);
    const text = await res.text();
    const json = parseLoose(text) ?? {};
    if (!res.ok) return { ok:false, error:`HTTP ${res.status}`, raw:text };

    const rawStatus = (json.status ?? json.Status ?? json.STATUS ?? '').toString();
    const otpRaw    = (json.otp ?? json.OTP ?? json.code ?? '').toString().trim();
    const msg       = (json.msg ?? json.message ?? '').toString();

    return { ok:true, status: rawStatus, otp: otpRaw || null, msg, raw: json ?? text };
  } catch (e) {
    // ตกไปลอง POST form ต่อ
  }

  // --- Fallback: POST form ---
  try {
    const form = new URLSearchParams();
    if (key) form.set('keyapi', key);
    form.set('order_id', String(orderId));

    const res2  = await fetchWithTimeout(`${endpoint}/otp_status`, {
      method: 'POST',
      headers: { 'content-type':'application/x-www-form-urlencoded', accept:'application/json' },
      body: form.toString()
    }, 15000);

    const text2 = await res2.text();
    const json2 = parseLoose(text2) ?? {};
    if (!res2.ok) return { ok:false, error:`HTTP ${res2.status}`, raw:text2 };

    const rawStatus = (json2.status ?? json2.Status ?? json2.STATUS ?? '').toString();
    const otpRaw    = (json2.otp ?? json2.OTP ?? json2.code ?? '').toString().trim();
    const msg       = (json2.msg ?? json2.message ?? '').toString();

    return { ok:true, status: rawStatus, otp: otpRaw || null, msg, raw: json2 ?? text2 };
  } catch (e) {
    return { ok:false, error:String(e?.message || e) };
  }
}

export function isOtp24Configured() {
  try { assertConfigured(); return true; } catch { return false; }
}
