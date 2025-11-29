// src/jobs/dailyChangeSync.js
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import { ChangeLog } from '../models/ChangeLog.js';
import { syncServicesFromProvider } from '../lib/syncServices.js';
import { connectMongoIfNeeded } from '../config.js';
import axios from 'axios';

dayjs.extend(utc); dayjs.extend(tz);
const TZ = 'Asia/Bangkok';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ✅ config Telegram + internal origin
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,
  BRAND_URL,                // แนะนำให้ตั้งเป็น https://rtsmm-th.com/update
  PORT = 3000,
  INTERNAL_API_ORIGIN,      // (ตอนนี้ยังไม่ได้ใช้ แต่เผื่อไว้)
} = process.env;

const TELEGRAM_API_BASE = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : null;

// ───────────────────────────────────────────────
//   แปล diff/newStatus เป็นภาษาไทยแบบหน้าเว็บ
// ───────────────────────────────────────────────
const DIFF_TH = {
  new: 'เพิ่มใหม่',
  open: 'เปิดใช้งาน',
  close: 'ปิดการใช้งาน',
  removed: 'ลบออก',
  delete: 'ลบออก',
  deleted: 'ลบออก',
  updated: 'อัปเดต',
  state: 'อัปเดตสถานะ',
};

const STATUS_TH = {
  new: 'เพิ่มใหม่',
  open: 'เปิดใช้งาน',
  active: 'เปิดใช้งาน',
  close: 'ปิดการใช้งาน',
  closed: 'ปิดการใช้งาน',
  removed: 'ลบออก',
  delete: 'ลบออก',
  deleted: 'ลบออก',
};

function tDiff(s) {
  const k = String(s || '').toLowerCase();
  return DIFF_TH[k] || s || 'อัปเดตข้อมูลบริการ';
}

function tStatus(s) {
  const k = String(s || '').toLowerCase();
  return STATUS_TH[k] || s || '';
}

// ── คำนวณรอบ 07:00 ของโซนเวลาไทย ─────────────────────────────
function next7amLocal(base = dayjs().tz(TZ)) {
  let target = base.hour(7).minute(0).second(0).millisecond(0);
  if (!target.isAfter(base)) target = target.add(1, 'day');
  return target;
}
function msUntilNext7am() {
  const now = dayjs();
  const target = next7amLocal(now.tz(TZ));
  return Math.max(0, target.valueOf() - now.valueOf());
}
function logNextRun(from = dayjs()) {
  const when = next7amLocal(from.tz(TZ));
  const gmt = when.format('Z').replace(/^([+-]\d{2})(\d{2})$/, '$1:$2'); //  +07:00
  console.log(
    `[services] next auto sync at ${when.format('YYYY-MM-DD HH:mm')} GMT${gmt} (${TZ})`
  );
}

// 🔥 ใหม่: ลบ ChangeLog ทั้ง collection ก่อน sync รอบใหม่ทุกครั้ง
async function clearAllChangeLogs() {
  const r = await ChangeLog.deleteMany({});
  console.log(
    `[changes] cleared ${r.deletedCount || 0} ChangeLog(s) before new sync`
  );
}

// ✅ ใช้ข้อมูลใน ChangeLog รอบล่าสุด ส่งไป Telegram
async function sendTelegramDailySummary() {
  if (!TELEGRAM_API_BASE || !TELEGRAM_CHANNEL_ID) {
    console.log('[telegram] skip: TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID not set');
    return;
  }

  // 1) หา log ล่าสุด 1 อัน เพื่อรู้ว่า "วันล่าสุดที่มีการเปลี่ยนแปลง" คือวันไหน
  const latest = await ChangeLog.findOne().sort({ ts: -1 }).lean();
  if (!latest) {
    console.log('[telegram] no ChangeLog to send');
    return;
  }

  const baseDay = dayjs(latest.ts).tz(TZ);
  const dayStart = baseDay.startOf('day').toDate();
  const dayEnd   = baseDay.add(1, 'day').startOf('day').toDate();

  // 2) เอาเฉพาะ log ของวันนั้น
  const rawLogs = await ChangeLog.find({
    ts: { $gte: dayStart, $lt: dayEnd },
  })
    .sort({ ts: -1 })   // ใหม่ → เก่า
    .lean();

  if (!rawLogs.length) {
    console.log('[telegram] no logs for latest day');
    return;
  }

  // 3) รวม log ต่อ service เอาอันล่าสุดสุดของแต่ละ service
  const perService = new Map(); // key = serviceId/providerServiceId
  for (const lg of rawLogs) {
    const key = String(lg.providerServiceId || lg.serviceId || lg._id);
    if (!perService.has(key)) {
      perService.set(key, lg); // เพราะ sort ใหม่→เก่าแล้ว อันแรกคือล่าสุด
    }
  }

  const logs = Array.from(perService.values());
  const totalCount = logs.length;

  const d = dayjs().tz(TZ);
  const dateStr = d.format('DD/MM/YYYY');
  const timeStr = d.format('HH:mm');

  const lines = [];
  lines.push('📢 รายการอัปเดตบริการ RTSMM-TH');
  lines.push(`🕖 อัปเดตอัตโนมัติประจำวันที่ ${dateStr} เวลา ${timeStr} น.\n`);

  if (!totalCount) {
    lines.push('วันนี้ยังไม่มีการเปลี่ยนแปลงบริการ');
  } else {
    const MAX_ENTRIES = 20; // ▲ ปรับจำนวนตัวอย่างตรงนี้ได้
    const displayLogs = logs
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, MAX_ENTRIES);

    lines.push(`รายการอัปเดตทั้งหมด ${totalCount} รายการ:`);
    if (totalCount > MAX_ENTRIES) {
      lines.push(`(แสดงตัวอย่าง ${MAX_ENTRIES} รายการแรก ดูทั้งหมดได้ในหน้าเว็บ)\n`);
    } else {
      lines.push(''); // เว้นบรรทัด
    }

    displayLogs.forEach((lg) => {
      const id =
        lg.providerServiceId || lg.serviceId || lg._id || '-';
      const name =
        lg.serviceName || lg.name || '(ไม่มีชื่อ)';
      const tsStr = dayjs(lg.ts).tz(TZ).format('DD/MM/YYYY HH:mm');

      const diffLabel = tDiff(lg.diff);
      const statusLabel = lg.newStatus ? tStatus(lg.newStatus) : '';

      const detailParts = [];

      if (diffLabel) {
        detailParts.push(diffLabel); // เช่น "เปิดใช้งาน", "ปิดการใช้งาน", "เพิ่มใหม่"
      }
      if (statusLabel) {
        detailParts.push(`สถานะใหม่: ${statusLabel}`);
      }

      if (lg.platform || lg.categoryName) {
        detailParts.push(
          [lg.platform, lg.categoryName].filter(Boolean).join(' • ')
        );
      }

      // หัวข้อ: #id • ชื่อบริการ
      lines.push(`#${id} • ${name}`);

      if (detailParts.length) {
        lines.push('• ' + detailParts.join(' • '));
      }

      lines.push(`• UPDATED ${tsStr}`);
      lines.push(''); // เว้นบรรทัด
    });
  }

  const link = BRAND_URL || 'https://rtsmm-th.com/update';
  lines.push(`🔗 ดูรายละเอียดทั้งหมดในหน้าอัปเดต:\n${link}`);

  let text = lines.join('\n');

  // safety เผื่อยังยาวไปอีก (ลดเหลือ 10 รายการ)
  if (text.length > 3800) {
    console.warn('[telegram] message too long, trimming entries further');
    const MAX_ENTRIES_SAFE = 10;
    const displayLogs = logs
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, MAX_ENTRIES_SAFE);

    const shortLines = [];
    shortLines.push('📢 รายการอัปเดตบริการ RTSMM-TH');
    shortLines.push(`🕖 อัปเดตอัตโนมัติประจำวันที่ ${dateStr} เวลา ${timeStr} น.\n`);
    shortLines.push(`รายการอัปเดตทั้งหมด ${totalCount} รายการ:`);
    shortLines.push(`(แสดงตัวอย่าง ${MAX_ENTRIES_SAFE} รายการแรก ดูทั้งหมดได้ในหน้าเว็บ)\n`);

    displayLogs.forEach((lg) => {
      const id =
        lg.providerServiceId || lg.serviceId || lg._id || '-';
      const name =
        lg.serviceName || lg.name || '(ไม่มีชื่อ)';
      const tsStr = dayjs(lg.ts).tz(TZ).format('DD/MM/YYYY HH:mm');

      const diffLabel = tDiff(lg.diff);
      const statusLabel = lg.newStatus ? tStatus(lg.newStatus) : '';

      const detailParts = [];
      if (diffLabel) detailParts.push(diffLabel);
      if (statusLabel) detailParts.push(`สถานะใหม่: ${statusLabel}`);

      if (lg.platform || lg.categoryName) {
        detailParts.push(
          [lg.platform, lg.categoryName].filter(Boolean).join(' • ')
        );
      }

      shortLines.push(`#${id} • ${name}`);
      if (detailParts.length) {
        shortLines.push('• ' + detailParts.join(' • '));
      }
      shortLines.push(`• UPDATED ${tsStr}`);
      shortLines.push('');
    });

    shortLines.push(`🔗 ดูรายละเอียดทั้งหมดในหน้าอัปเดต:\n${link}`);
    text = shortLines.join('\n');
  }

  try {
    await axios.post(`${TELEGRAM_API_BASE}/sendMessage`, {
      chat_id: TELEGRAM_CHANNEL_ID,
      text,
      disable_web_page_preview: true,
    });
    console.log('[telegram] detailed daily summary sent (from ChangeLog)');
  } catch (err) {
    console.error(
      '[telegram] failed to send daily summary:',
      err?.response?.data || err.message
    );
  }
}

// ── งานหลัก: ซิงก์บริการ + ล้าง log เก่า ─────────────────────────────
let _running = false;
async function runDaily() {
  await connectMongoIfNeeded();

  if (_running) {
    console.log('[services] skip: daily sync already running');
    return;
  }
  _running = true;
  const startTs = Date.now();
  try {
    console.log('[services] 07:00 sync starting…');

    // 🔥 เคลียร์ ChangeLog เดิมทั้งหมดทุกครั้งก่อน sync
    await clearAllChangeLogs();

    const r = await syncServicesFromProvider();
    console.log('[services] sync done:', {
      ok: r?.ok,
      mode: r?.mode,
      count: r?.count ?? 0,
      skipped: r?.skipped ?? 0,
      logs: r?.logs ?? 0,
      durationMs: Date.now() - startTs,
    });

    console.log('[services] daily maintenance completed.');

    // ใช้ข้อมูลจาก ChangeLog รอบล่าสุดส่งไป Telegram
    await sendTelegramDailySummary();
  } catch (e) {
    console.error(
      '[services] daily sync error:',
      e?.response?.data || e
    );
  } finally {
    _running = false;
    // แจ้งรอบถัดไปหลังจบงาน
    logNextRun(dayjs());
  }
}

// ── เริ่มตั้งเวลาออโต้ ─────────────────────────────────────────
export function initDailyChangeSync() {
  const firstDelay = Math.max(1000, msUntilNext7am());
  // แจ้งตั้งแต่ตอนบูต
  logNextRun(dayjs());
  setTimeout(() => {
    // ยิงรอบตามเวลา 07:00
    runDaily();
    // หลังจากนั้นคงรอบทุก 24 ชม. (ล็อกกับรอบแรก)
    setInterval(runDaily, ONE_DAY_MS);
  }, firstDelay);
}

// สำหรับสั่งรันทันทีจากสคริปต์ภายนอก
export const _runDailyNow = runDaily;
