// src/lib/iplusviewAdapter.js
import axios from 'axios';
import { config, refreshConfigFromDB } from '../config.js';

/* ======================= utils ======================= */
const trimBase = (u = '') => String(u).replace(/\/+$/, '');
const pick = (...vals) => vals.find(v => v !== undefined && v !== null);

/* ======================= Axios client (cached) ======================= */
let _clientKey = null;
let _clientInst = null;
let _triedRefreshOnce = false;

async function getProviderRuntime() {
  // 1) live config (DB-merged) -> 2) ENV fallback
  let baseURL = trimBase(config?.provider?.baseUrl || config?.provider?.baseURL || '');
  let apiKey  = (config?.provider?.apiKey || '').trim();

  // ถ้ายังว่าง ลอง refresh จาก DB หนึ่งครั้ง
  if ((!baseURL || !apiKey) && !_triedRefreshOnce) {
    _triedRefreshOnce = true;
    try {
      await refreshConfigFromDB();
      baseURL = trimBase(config?.provider?.baseUrl || config?.provider?.baseURL || '');
      apiKey  = (config?.provider?.apiKey || '').trim();
    } catch {/* noop */}
  }

  // ENV สำรอง
  if (!baseURL) baseURL = trimBase(process.env.IPV_API_BASE || '');
  if (!apiKey)  apiKey  = (process.env.IPV_API_KEY || '').trim();

  return { baseURL, apiKey };
}

export function resetProviderClientCache() {
  _clientKey = null;
  _clientInst = null;
  _triedRefreshOnce = false;
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
    timeout: 30000,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      // รองรับทั้ง 2 แบบ
      Authorization: apiKey,
      'X-API-Key': apiKey,
    },
    // อนุญาต HTTPS ที่บางที cert แปลก (ถ้าเจอค่อยเปิด)
    // httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  });
  return _clientInst;
}

/* ======================= normalizers ======================= */
function normalizeOrderId(data) {
  return pick(
    data?.order, data?.order_id, data?.orderId, data?.id, data?.data?.order_id, data?.data?.id
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
/** รุ่นแปลงแล้ว (normalize โครง basic) */
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

/** รุ่นดิบจากผู้ให้บริการ (บางรายส่งเป็น array ตรง ๆ) */
export async function getServices() {
  const client = await getClient();
  const { data } = await client.get('/services');

  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;

  throw new Error('Invalid /services response: expected array or {data: array}');
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

  const serviceIdNum = Number(payload?.service_id ?? payload?.serviceId ?? payload?.providerServiceId);
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
    charge:   pick(data?.charge, data?.amount, data?.price),
    currency: pick(data?.currency, 'THB'),
    start_count: pick(data?.start_count, data?.startCount, data?.start),
    remains:     pick(data?.remains, data?.remain, data?.left),
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
  } catch {/* fallthrough */}
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

// alias
export async function cancelOrder(orderId) {
  return createCancel(orderId);
}
