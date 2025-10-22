// jobs/dailyChangeSync.js
import { runBootstrapIfNeeded, runSync } from '../services/changeSync.js';

function millisUntilNext7am(tz = 'Asia/Bangkok') {
  const now = new Date();
  // 7 โมงวันนี้/พรุ่งนี้ในเขตเวลาไทย
  const fmt = (y,m,d,h) => new Date(
    new Date().toLocaleString('en-US', { timeZone: tz })
      .replace(/(\d{1,2})\/(\d{1,2})\/(\d{4}), (.*)/, (_,mm,dd,yyyy,rest) => `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}T${rest}`)
  );
  const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const target = new Date(localNow);
  target.setHours(7,0,0,0);     // 07:00

  let nextLocal = target <= localNow ? new Date(target.getTime()+24*60*60*1000) : target;

  // แปลงกลับเป็นเวลาเครื่อง
  const nextUTC = new Date(
    Date.parse(nextLocal.toLocaleString('en-US', { timeZone: 'UTC' })) // keep absolute instant
  );
  return nextUTC - now;
}

export function initDailyChangeSync() {
  async function trigger() {
    try {
      console.log('[changes] daily 07:00 — bootstrap-if-needed + sync starting…');
      await runBootstrapIfNeeded();
      const r = await runSync();
      console.log('[changes] done:', r);
    } catch (e) {
      console.error('[changes] daily sync error:', e);
    }
  }

  const firstDelay = Math.max(1000, millisUntilNext7am('Asia/Bangkok'));
  setTimeout(() => {
    trigger();
    setInterval(trigger, 24*60*60*1000);  // ทุก 24 ชม.
  }, firstDelay);
}
