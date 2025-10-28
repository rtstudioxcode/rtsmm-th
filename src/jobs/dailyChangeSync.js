// jobs/dailyChangeSync.js
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import { syncServicesFromProvider } from '../lib/syncServices.js';
import { ChangeLog } from '../models/ChangeLog.js';

dayjs.extend(utc); dayjs.extend(tz);

const TZ = 'Asia/Bangkok';

/** เวลาถึง 07:00 น. ครั้งถัดไป (ms) */
function msUntilNext7am() {
  const now = dayjs();
  const localNow = now.tz(TZ);
  let target = localNow.hour(7).minute(0).second(0).millisecond(0);
  if (!target.isAfter(localNow)) target = target.add(1, 'day');
  // แปลงกลับเป็น epoch ของเครื่องเพื่อ setTimeout ให้ตรง absolute instant
  return target.toDate().getTime() - now.toDate().getTime();
}

/** ลบ ChangeLog ที่ “เก่ากว่า” 3 วันล่าสุด (เหลือวันนี้/เมื่อวาน/มะรืน) */
async function pruneOldChangeLogs() {
  // ตัดที่ต้นวันของ (วันนี้ - 2 วัน) ในเขตเวลาไทย
  const cutoff = dayjs().tz(TZ).startOf('day').subtract(2, 'day').toDate();
  const r = await ChangeLog.deleteMany({ ts: { $lt: cutoff } });
  console.log(`[changes] pruned ${r.deletedCount || 0} old ChangeLog(s) before`, cutoff);
}

/** งานหลัก: ซิงก์ + prune */
async function runDaily() {
  try {
    console.log('[services] 07:00 sync starting…');
    const r = await syncServicesFromProvider();
    console.log('[services] sync done:', {
      count: r?.count ?? 0,
      skipped: r?.skipped ?? 0,
      logs: r?.logs ?? 0
    });

    await pruneOldChangeLogs();
    console.log('[services] daily maintenance completed.');
  } catch (e) {
    console.error('[services] daily sync error:', e?.response?.data || e);
  }
}

export function initDailyChangeSync() {
  const firstDelay = Math.max(1000, msUntilNext7am());
  setTimeout(() => {
    runDaily();
    // รันซ้ำทุก 24 ชม.
    setInterval(runDaily, 24 * 60 * 60 * 1000);
  }, firstDelay);
}

// เผื่ออยากเรียกด้วยมือจากที่อื่น
export const _runDailyNow = runDaily;
