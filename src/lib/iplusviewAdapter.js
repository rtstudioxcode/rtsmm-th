// lib/iplusviewAdapter.js
import axios from 'axios';
import { config } from '../config.js';

const client = axios.create({
  baseURL: (config?.provider?.baseURL || config?.provider?.baseUrl || '').replace(/\/+$/, ''),
  timeout: 20000,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-API-Key': config?.provider?.apiKey || '',
  },
});

export async function getProviderCatalog() {
  // เรียกด้วย axios client ที่ตั้ง baseURL/headers ไว้แล้ว
  const { data } = await client.get('/services');

  // ผู้ให้บริการบางเจ้าใส่รายการไว้ใน data.data บางเจ้าส่งเป็น array ตรง ๆ
  const services = Array.isArray(data?.data) ? data.data
                   : (Array.isArray(data) ? data : []);

  return services.map(s => ({
    // normalize ฟิลด์
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

/* -------- helpers -------- */
const pick = (...vals) => vals.find(v => v !== undefined && v !== null);

function normalizeOrderId(data) {
  // รองรับหลายแบบ
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

  // + เพิ่มคำพ้องจากผู้ให้บริการ
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

/* -------- services -------- */
export async function getServices() {
  const res = await client.get('/services');
  if (!Array.isArray(res.data)) throw new Error('Invalid /services response');
  return res.data;
}

export async function getBalance() {
  try {
    const r1 = await client.get('/balance'); return r1.data;
  } catch {
    const r2 = await client.get('/credit');  return r2.data;
  }
}

/* -------- orders -------- */
export async function createOrder(payload) {
  // --- บังคับ service_id เป็นตัวเลข และ whitelist field ---
  const serviceIdNum = Number(
    payload?.service_id ?? payload?.serviceId ?? payload?.providerServiceId
  );

  if (!Number.isFinite(serviceIdNum) || serviceIdNum <= 0) {
    throw new Error('createOrder: invalid service_id');
  }

  const quantityNum = Number(payload?.quantity || 0);
  if (!quantityNum) throw new Error('createOrder: quantity is required');

  // 👇 ส่งเฉพาะคีย์ที่ผู้ให้บริการรองรับจริง ๆ
  const body = {
    service_id: serviceIdNum,     // ✅ ใช้อันนี้อันเดียว พอ
    link: String(payload?.link || ''),
    quantity: quantityNum,
  };

  // ส่ง option เสริมเท่าที่เจ้านั้น ๆ รองรับ
  if (payload?.dripfeed !== undefined) body.dripfeed = !!payload.dripfeed;
  if (payload?.runs !== undefined)     body.runs     = Number(payload.runs);
  if (payload?.interval !== undefined) body.interval = String(payload.interval);
  if (payload?.comments !== undefined) body.comments = String(payload.comments);

  // (อย่าใส่ groupId / providerServiceId / serviceId อื่น ๆ ลงไป)
  console.log('DEBUG provider body =>', body);

  const { data } = await client.post('/orders', body);
  const providerOrderId = normalizeOrderId(data);
  if (!providerOrderId) throw new Error('createOrder: provider did not return order id');

  return { providerOrderId, raw: data };
}

export async function getOrderStatus(orderId) {
  if (!orderId) throw new Error('getOrderStatus: orderId is required');
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
  const { data } = await client.post(`/orders/${orderId}/refill`, {});
  const refillId = pick(data?.refill_id, data?.id, data?.data?.id);
  return { ok: true, refillId, raw: data };
}

export async function getRefillStatus(refillIdOrOrderId) {
  if (!refillIdOrOrderId) throw new Error('getRefillStatus: id is required');
  try {
    const { data } = await client.get(`/refills/${refillIdOrOrderId}`);
    return { raw: data, status: (data?.status || '').toLowerCase() };
  } catch {}
  const { data } = await client.get(`/orders/${refillIdOrOrderId}/refill-status`);
  return { raw: data, status: (data?.status || '').toLowerCase() };
}

export async function cancelOrder(orderId) {
  if (!orderId) throw new Error('cancelOrder: orderId is required');
  const { data } = await client.post('/cancels', {
    order_id: Number(orderId),
  });

  const cancelId = data?.id || data?.data?.id;
  const status   = (data?.status || data?.data?.status || '').toLowerCase();

  return { ok: true, cancelId, status, raw: data };
}