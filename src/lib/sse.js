// src/lib/sse.js
const channels = new Map(); // orderId -> Set(res)

export function attach(orderId, res) {
  if (!channels.has(orderId)) channels.set(orderId, new Set());
  channels.get(orderId).add(res);
  res.on('close', () => {
    channels.get(orderId)?.delete(res);
    if (channels.get(orderId)?.size === 0) channels.delete(orderId);
  });
}

export function publish(orderId, event) {
  const subs = channels.get(orderId);
  if (!subs || subs.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subs) res.write(payload);
}

// optional: ส่ง heartbeat กัน proxy ปิด
export function heartbeat(orderId) {
  publish(orderId, { type: 'ping', t: Date.now() });
}
