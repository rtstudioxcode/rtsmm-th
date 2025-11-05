// routes/otp24.js
import { Router } from 'express';
import { Otp24Item } from '../models/Otp24Item.js';
import { connectMongoIfNeeded } from '../config.js';
import { fetch as undiciFetch } from 'undici';            // ⬅️ เพิ่มบรรทัดนี้

const router = Router();
const _fetch = globalThis.fetch ?? undiciFetch;           // ⬅️ ใช้ตัวนี้แทน fetch ตรงๆ

function normalizeOtpResponse(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && typeof data === 'object') {
    const vals = Object.values(data);
    if (vals.length && vals.every(v => v && typeof v === 'object')) return vals;
  }
  return [];
}
const toNumber = (v, d=0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ─────────────────────────────────────────────────────────────
// Proxy OTP สด (ไม่เก็บ DB)
// ─────────────────────────────────────────────────────────────
router.get('/otp24/api/otp', async (req, res) => {
  const apiBase = 'https://otp24hr.com/api/v1?action=getotp';

  const per = req.query.per !== undefined ? toNumber(req.query.per, null) : null;
  const markup = req.query.markup !== undefined ? toNumber(req.query.markup, 30) : 30;

  try {
    const url = new URL(apiBase);
    if (per !== null) url.searchParams.set('per', String(per));

    // timeout 12s กันค้าง
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 12_000);

    const r = await _fetch(url.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'User-Agent': 'RTSMM-TH/otp24-proxy (+https://rtsmm-th.com)',
        'Accept': 'application/json, text/plain, */*',
      },
    }).finally(() => clearTimeout(t));

    if (!r.ok) {
      return res.status(r.status).json({ ok:false, error:`Upstream HTTP ${r.status}` });
    }

    const raw = await r.json();
    const list = normalizeOtpResponse(raw);

    const items = list.map(it => {
      const base = toNumber(it.price ?? it.amount ?? it.cost ?? it.rate ?? it.value, 0);
      const adjusted = (per !== null) ? (base + per) : (base * (1 + markup/100));
      return { ...it, priceBase: base, priceAdjusted: Number(adjusted.toFixed(2)) };
    });

    return res.json({ ok:true, count: items.length, per, markup, items });
  } catch (err) {
    // แสดงสาเหตุจริง ๆ เพื่อดีบักง่าย
    return res.status(500).json({ ok:false, error: err?.message || 'fetch failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// หน้าแสดงผลหลัก (DB)
// ─────────────────────────────────────────────────────────────
router.get('/otp24', async (req, res) => {
  await connectMongoIfNeeded();
  const [apppremiumItems, termgameItems] = await Promise.all([
    Otp24Item.find({ category: 'apppremium' }).sort({ name: 1 }).lean(),
    Otp24Item.find({ category: 'termgame' }).sort({ name: 1 }).lean(),
  ]);
  res.render('otp24/rtsmm24', {
    apppremiumItems: apppremiumItems || [],
    termgameItems: termgameItems || [],
  });
});

export default router;
