// routes/changes.js
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { ChangeLog } from '../models/ChangeLog.js';
import { CatalogSnapshot } from '../models/CatalogSnapshot.js';
import { Service } from '../models/Service.js';
import * as provider from '../lib/iplusviewAdapter.js';

const r = Router();

/* ---------------- UI ---------------- */
r.get('/update', requireAuth, async (req, res) => {
  const me = req.user || req.session?.user;
  const isAdmin = !!(me?.role === 'admin' || me?.isAdmin);
  // เรา “ซ่อนปุ่ม” ในหน้าอยู่แล้ว ดังนั้นไม่ต้องส่ง isAdmin ก็ได้
  res.render('update', { title: 'อัปเดตรายการบริการ' });
});

/* ---------------- API: เฉพาะวันล่าสุด ---------------- */
r.get('/api/changes', requireAuth, async (req, res) => {
  const latest = String(req.query.latest || '') === '1';
  const limit  = Math.min(1000, Math.max(10, Number(req.query.limit || 500)));

  if (latest) {
    // ดึง timestamp ล่าสุด 1 รายการ
    const head = await ChangeLog.findOne({}).sort({ ts: -1 }).lean();
    if (!head) return res.json({ ok: true, items: [], latestDay: null });

    // สร้างช่วงของ “วันเดียวกัน” (ใช้ UTC หรือ local ก็ได้ตามระบบที่เก็บ ts)
    const start = new Date(head.ts); start.setHours(0,0,0,0);
    const end   = new Date(head.ts); end.setHours(23,59,59,999);

    const items = await ChangeLog
      .find({ ts: { $gte: start, $lte: end } })
      .sort({ ts: -1 })
      .limit(limit)
      .lean();

    return res.json({
      ok: true,
      items,
      latestDay: start.toISOString().slice(0,10) // เผื่ออยากโชว์หัวข้อวัน
    });
  }

  // โหมดเดิม (ถ้าต้องใช้ paginate ทีหลัง)
  const cursor = req.query.cursor ? new Date(req.query.cursor) : null;
  const q = {};
  if (cursor && !isNaN(cursor)) q.ts = { $lt: cursor };
  const docs = await ChangeLog.find(q).sort({ ts: -1 }).limit(limit + 1).lean();
  const nextCursor = docs.length > limit ? docs[limit - 1].ts : null;
  return res.json({ ok: true, items: docs.slice(0, limit), nextCursor });
});

export default r;
