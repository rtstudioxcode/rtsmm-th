// src/jobs/dailyChangeSync.js
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import { ChangeLog } from '../models/ChangeLog.js';
import { syncServicesFromProvider } from '../lib/syncServices.js';
import { connectMongoIfNeeded } from '../config.js';

dayjs.extend(utc); dayjs.extend(tz);
const TZ = 'Asia/Bangkok';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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
  console.log(`[services] next auto sync at ${when.format('YYYY-MM-DD HH:mm')} GMT${gmt} (${TZ})`);
}

// ── ล้าง ChangeLog เก่ากว่า 3 วัน (เก็บ “วันนี้, เมื่อวาน, เมื่อวานซืน”) ──
async function pruneOldChangeLogs() {
  const cutoff = dayjs().tz(TZ).startOf('day').subtract(2, 'day').toDate();
  const r = await ChangeLog.deleteMany({ ts: { $lt: cutoff } });
  console.log(`[changes] pruned ${r.deletedCount || 0} ChangeLog(s) before ${cutoff.toISOString()}`);
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
    const r = await syncServicesFromProvider();
    console.log('[services] sync done:', {
      ok: r?.ok, mode: r?.mode,
      count: r?.count ?? 0,
      skipped: r?.skipped ?? 0,
      logs: r?.logs ?? 0,
      durationMs: Date.now() - startTs,
    });

    await pruneOldChangeLogs();
    console.log('[services] daily maintenance completed.');
  } catch (e) {
    console.error('[services] daily sync error:', e?.response?.data || e);
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
