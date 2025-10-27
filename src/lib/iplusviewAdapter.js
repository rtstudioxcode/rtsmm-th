// lib/iplusviewAdapter.js
import axios from 'axios';
import mongoose from 'mongoose';
import { config } from '../config.js';

/* ======================= Secure runtime config (from DB) ======================= */
const secureConfigSchema = new mongoose.Schema({
  ipv: { apiBase: String, apiKey: String },
  mail: { host: String, port: Number, user: String, pass: String, from: String },
  otp: { ttlSec: Number, resendCooldownSec: Number, maxAttempts: Number },
  port: Number,
  sessionSecret: String,
}, { collection: 'secure_config', minimize: true });

const SecureConfig =
  mongoose.models.SecureConfig || mongoose.model('SecureConfig', secureConfigSchema);

// โหลดค่าจาก DB (ครั้งเดียว/cache ไว้ในหน่วยความจำ)
let _secCache = null;
async function getSecureConfig() {
  if (_secCache) return _secCache;
  try {
    const doc = await SecureConfig.findOne().lean();
    _secCache = doc || null;
  } catch { _secCache = null; }
  return _secCache;
}

function trimBase(u='') {
  return String(u).replace(/\/+$/, '');
}

/* ======================= Axios client factory with cache ======================= */
let _clientKey = null;
let _clientInst = null;

async function getProviderRuntime() {
  // 1) DB -> 2) env -> 3) config.js (legacy)
  const sec = await getSecureConfig();
  const baseFromDB = sec?.ipv?.apiBase;
  const keyFromDB  = sec?.ipv?.apiKey;

  const baseFromEnv = process.env.IPV_API_BASE;
  const keyFromEnv  = process.env.IPV_API_KEY;

  const baseFromCfg = config?.provider?.baseURL || config?.provider?.baseUrl;
  const keyFromCfg  = config?.provider?.apiKey;

  const baseURL = trimBase(baseFromDB || baseFromEnv || baseFromCfg || '');
  const apiKey  = (keyFromDB || keyFromEnv || keyFromCfg || '').trim();

  return { baseURL, apiKey };
}

async function getClient() {
  const { baseURL, apiKey } = await getProviderRuntime();
  if (!baseURL || !apiKey) {
    throw new Error('Provider credentials are not configured (baseURL/apiKey missing).');
  }
  const key = `${baseURL}|${apiKey}`;
  if (_clientInst && _clientKey === key) return _clientInst;

  _clientKey = key;
  _clientInst = axios.create({
    baseURL,
    timeout: 20000,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
  });
  return _clientInst;
}

/* ======================= helpers ======================= */
const pick = (...vals) => vals.find(v => v !== undefined && v !== null);

function normalizeOrderId(data) {
  return pick(
    data?.order,
    data?.order_id,
    data?.orderId,
    data?.id,
    data?.data?.order_id,
    data?.data?.id
  );
}

function normalizeStatus(data) {
  const raw = (data?.status || data?.order_status || '').toString().toLowerCase().trim();
  if (!raw) return { status: 'processing', rawStatus: raw };

  if (/(processing|pending|queue|queued|created|received|awaiting|waiting)/.test(raw))
    return { status: 'processing', rawStatus: raw };

  if (/(in\s*progress|running|doing|start|started|working)/.test(raw))
    return { status: 'inprogress', rawStatus: raw };

  if (/(completed|success|done|finished)/.test(raw))
    return { status: 'completed', rawStatus: raw };

  if (/(partial|partially)/.test(raw))
    return { status: 'partial', rawStatus: raw };

  if (/(canceled|cancelled|fail|failed|refunded|refund)/.test(raw))
    return { status: 'canceled', rawStatus: raw };

  return { status: raw, rawStatus: raw };
}

function normCancelCreateResp(data) {
  const first = data?.data?.[0] || data?.data || data;
  return {
    cancelId: first?.id ?? first?.cancel_id ?? data?.id ?? data?.cancel_id ?? null,
    status: (first?.status ?? data?.status ?? '').toString().toLowerCase(),
    raw: data,
  };
}

/* ======================= provider catalog ======================= */
export async function getProviderCatalog() {
  const client = await getClient();
  const { data } = await client.get('/services');

  const services = Array.isArray(data?.data) ? data.data
                   : (Array.isArray(data) ? data : []);

  return services.map(s => ({
    id:               s.id ?? s.service_id ?? s.serviceId,
    name:             s.name ?? s.service ?? '',
    platform:         s.platform ?? s.category ?? '',
    categoryName:     s.category_name ?? s.categoryName ?? s.subcategory ?? '',
    subcategoryName:  s.subcategory_name ?? s.subcategoryName ?? '',
    enabled:          s.enabled ?? (s.status ? String(s.status).toLowerCase() === 'active' : true),
    rate:             Number(s.rate ?? 0),
    currency:         s.currency ?? 'THB',
    min:              Number(s.min ?? s.minimum ?? 0),
    max:              Number(s.max ?? s.maximum ?? 0),
    dripfeed:         !!(s.dripfeed ?? s.drip ?? false),
    refill:           !!(s.refill ?? false),
    cancel:           !!(s.cancel ?? false),
    description:      s.description ?? s.desc ?? '',
    average_delivery: s.average_delivery ?? s.avg_delivery ?? ''
  }));
}

export async function getServices() {
  const client = await getClient();
  const res = await client.get('/services');
  if (!Array.isArray(res.data)) throw new Error('Invalid /services response');
  return res.data;
}

export async function getBalance() {
  const client = await getClient();
  try {
    const r1 = await client.get('/balance'); return r1.data;
  } catch {
    const r2 = await client.get('/credit');  return r2.data;
  }
}

/* ======================= orders ======================= */
export async function createOrder(payload) {
  const client = await getClient();

  const serviceIdNum = Number(
    payload?.service_id ?? payload?.serviceId ?? payload?.providerServiceId
  );
  if (!Number.isFinite(serviceIdNum) || serviceIdNum <= 0) {
    throw new Error('createOrder: invalid service_id');
  }

  const quantityNum = Number(payload?.quantity || 0);
  if (!quantityNum) throw new Error('createOrder: quantity is required');

  const body = {
    service_id: serviceIdNum,
    link: String(payload?.link || ''),
    quantity: quantityNum,
  };

  if (payload?.dripfeed !== undefined) body.dripfeed = !!payload.dripfeed;
  if (payload?.runs !== undefined)     body.runs     = Number(payload.runs);
  if (payload?.interval !== undefined) body.interval = String(payload.interval);
  if (payload?.comments !== undefined) body.comments = String(payload.comments);

  const { data } = await client.post('/orders', body);
  const providerOrderId = normalizeOrderId(data);
  if (!providerOrderId) throw new Error('createOrder: provider did not return order id');

  return { providerOrderId, raw: data };
}

export async function getOrderStatus(orderId) {
  if (!orderId) throw new Error('getOrderStatus: orderId is required');
  const client = await getClient();
  const { data } = await client.get(`/orders/${orderId}`);
  const { status, rawStatus } = normalizeStatus(data);
  return {
    status, rawStatus,
    charge: pick(data?.charge, data?.amount, data?.price),
    currency: pick(data?.currency, 'THB'),
    start_count: pick(data?.start_count, data?.startCount, data?.start),
    remains: pick(data?.remains, data?.remain, data?.left),
    raw: data,
  };
}

export async function requestRefill(orderId) {
  if (!orderId) throw new Error('requestRefill: orderId is required');
  const client = await getClient();
  const { data } = await client.post(`/orders/${orderId}/refill`, {});
  const refillId = pick(data?.refill_id, data?.id, data?.data?.id);
  return { ok: true, refillId, raw: data };
}

export async function getRefillStatus(refillIdOrOrderId) {
  if (!refillIdOrOrderId) throw new Error('getRefillStatus: id is required');
  const client = await getClient();
  try {
    const { data } = await client.get(`/refills/${refillIdOrOrderId}`);
    return { raw: data, status: (data?.status || '').toLowerCase() };
  } catch {}
  const { data } = await client.get(`/orders/${refillIdOrOrderId}/refill-status`);
  return { raw: data, status: (data?.status || '').toLowerCase() };
}

export async function createCancel(orderId) {
  const client = await getClient();
  const oid = Number(orderId);
  if (!Number.isFinite(oid)) throw new Error('createCancel: invalid orderId');

  try {
    const { data } = await client.post('/cancels', { order_ids: [oid] });
    const { cancelId, status, raw } = normCancelCreateResp(data);
    const ok = !!cancelId || /^(ok|success|accepted)$/i.test(status);
    return { ok, cancelId, status, raw };
  } catch (e1) {
    const { data } = await client.post('/cancels', { order_id: oid });
    const { cancelId, status, raw } = normCancelCreateResp(data);
    const ok = !!cancelId || /^(ok|success|accepted)$/i.test(status);
    return { ok, cancelId, status, raw };
  }
}

export async function getCancelById(cancelId) {
  if (!cancelId) throw new Error('getCancelById: cancelId is required');
  const client = await getClient();
  const { data } = await client.get(`/cancels/${cancelId}`);
  const status = (data?.status || data?.data?.status || '').toString().toLowerCase();
  return { status, raw: data };
}

export async function findCancelsByIds(ids = []) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('findCancelsByIds: ids required');
  const client = await getClient();
  const { data } = await client.post('/cancels/find', { ids });
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  const map = {};
  list.forEach(x => {
    const id = x?.id ?? x?.cancel_id;
    const st = (x?.status || '').toString().toLowerCase();
    if (id != null) map[String(id)] = st;
  });
  return { map, raw: data };
}

// alias ให้เดิม
export async function cancelOrder(orderId) {
  return createCancel(orderId);
}
