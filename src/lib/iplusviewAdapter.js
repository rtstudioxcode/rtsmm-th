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

function normCancelCreateResp(data) {
  // บางเจ้าให้ { id, status }, บางเจ้าให้ { data: { id, status } }
  // บางเจ้าให้ array ของ cancels
  const first = data?.data?.[0] || data?.data || data;
  return {
    cancelId: first?.id ?? first?.cancel_id ?? data?.id ?? data?.cancel_id ?? null,
    status: (first?.status ?? data?.status ?? '').toString().toLowerCase(),
    raw: data,
  };
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

export async function createCancel(orderId) {
  const oid = Number(orderId);
  if (!Number.isFinite(oid)) throw new Error('createCancel: invalid orderId');

  // iPlusView: ใช้ /cancels เป็นหลัก
  // รองรับทั้ง { order_id } และ { order_ids: [oid] }
  try {
    const { data } = await client.post('/cancels', { order_ids: [oid] });
    const { cancelId, status, raw } = normCancelCreateResp(data);
    const ok = !!cancelId || /^(ok|success|accepted)$/i.test(status);
    return { ok, cancelId, status, raw };
  } catch (e1) {
    // fallback: รูปแบบ single
    const { data } = await client.post('/cancels', { order_id: oid });
    const { cancelId, status, raw } = normCancelCreateResp(data);
    const ok = !!cancelId || /^(ok|success|accepted)$/i.test(status);
    return { ok, cancelId, status, raw };
  }
}

export async function getCancelById(cancelId) {
  if (!cancelId) throw new Error('getCancelById: cancelId is required');
  const { data } = await client.get(`/cancels/${cancelId}`);
  // คาดหวังว่ามีฟิลด์ status
  const status = (data?.status || data?.data?.status || '').toString().toLowerCase();
  return { status, raw: data };
}

export async function findCancelsByIds(ids = []) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('findCancelsByIds: ids required');
  // บาง API เป็น POST /cancels/find
  const { data } = await client.post('/cancels/find', { ids });
  // ให้เป็น map id -> status
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  const map = {};
  list.forEach(x => {
    const id = x?.id ?? x?.cancel_id;
    const st = (x?.status || '').toString().toLowerCase();
    if (id != null) map[String(id)] = st;
  });
  return { map, raw: data };
}

// แก้ของเดิมให้เรียก createCancel() แทน
export async function cancelOrder(orderId) {
  return createCancel(orderId);
}

// export async function startCancel(providerOrderId) {
//   // พยายามทั้ง 2 รูปแบบที่เจ้า iPlusView รองรับ
//   try {
//     const r = await client.post(`/orders/${Number(providerOrderId)}/cancel`, {});
//     return { ok:true, raw:r.data, cancelId: (r.data?.cancel_id ?? r.data?.id ?? r.data?.data?.id) ?? null };
//   } catch (e1) {
//     try {
//       const r2 = await client.post('/cancels', { order_id: Number(providerOrderId) });
//       return { ok:true, raw:r2.data, cancelId: (r2.data?.cancel_id ?? r2.data?.id ?? r2.data?.data?.id) ?? null };
//     } catch (e2) {
//       const msg = e2?.response?.data?.error || e1?.response?.data?.error || e2?.message || e1?.message || 'cancel failed';
//       throw new Error(msg);
//     }
//   }
// }

// export async function getCancelById(cancelId) {
//   const { data } = await client.get(`/cancels/${cancelId}`);
//   const st = String(data?.status || data?.data?.status || '').toLowerCase();
//   return { raw:data, status:st };
// }

// export async function findCancelsByIds(ids=[]) {
//   const { data } = await client.post('/cancels/by-ids', { ids });
//   // ปรับให้อ่านง่าย: คืน object ตาม id
//   const map = {};
//   (data?.data || data || []).forEach(item=>{
//     const id = item?.id ?? item?.cancel_id;
//     const st = String(item?.status || '').toLowerCase();
//     if (id!=null) map[String(id)] = { raw:item, status:st };
//   });
//   return map;
// }

// export async function cancelOrder(orderId) {
//   if (!orderId) throw new Error('cancelOrder: orderId is required');

//   const oid = Number(orderId);
//   if (!Number.isFinite(oid)) throw new Error('cancelOrder: invalid orderId');

//   let data;
//   // ผู้ให้บริการบางเจ้ารับรูปแบบ /orders/:id/cancel (ไม่มี body)
//   // บางเจ้ารับ /cancels { order_id }
//   try {
//     const r = await client.post(`/orders/${oid}/cancel`, {});
//     data = r.data;
//   } catch (e1) {
//     try {
//       const r2 = await client.post('/cancels', { order_id: oid });
//       data = r2.data;
//     } catch (e2) {
//       // ส่งข้อความจาก provider กลับไปเพื่อโชว์ใน alert
//       const msg = (e2?.response?.data?.error) || (e1?.response?.data?.error) || e2?.message || e1?.message || 'cancel failed';
//       throw new Error(msg);
//     }
//   }

//   const cancelId = (data?.cancel_id ?? data?.id ?? data?.data?.id) ?? null;
//   const statusRaw = String(data?.status ?? data?.data?.status ?? '').toLowerCase();
//   const ok =
//     /^(ok|success|accepted|canceled|cancelled)$/i.test(statusRaw) ||
//     cancelId != null;

//   return { ok, cancelId, status: statusRaw, raw: data };
// }

// export async function cancelOrder(orderId) {
//   if (!orderId) throw new Error('cancelOrder: orderId is required');
//   const { data } = await client.post('/cancels', {
//     order_id: Number(orderId),
//   });

//   const cancelId = data?.id || data?.data?.id;
//   const status   = (data?.status || data?.data?.status || '').toLowerCase();

//   return { ok: true, cancelId, status, raw: data };
// }