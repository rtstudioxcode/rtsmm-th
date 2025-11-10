// src/lib/otp24BalanceUtil.js
import { getOtp24Balance } from '../lib/otp24Adapter.js';
import { Otp24Setting } from '../models/Otp24Setting.js';

async function writeFromResponse(r) {
  const rawTrim = typeof r?.raw === 'string' ? r.raw.slice(0, 2000) : r?.raw;

  if (!r?.ok) {
    await Otp24Setting.findOneAndUpdate(
      { name: 'otp24' },
      {
        $set: {
          lastSyncAt:    new Date(),
          lastSyncOk:    false,
          lastSyncVia:   r?.via || '',
          lastSyncError: String(r?.error || 'fetch failed'),
          lastSyncResult: rawTrim ?? null,
          currency: 'THB',
        },
      },
      { upsert: true }
    );
    return { ok:false, error:r?.error || 'fetch failed' };
  }

  await Otp24Setting.findOneAndUpdate(
    { name: 'otp24' },
    {
      $set: {
        lastBalance: Number(r.balance) || 0,
        currency:    r.currency || 'THB',
        lastSyncAt:  new Date(),
        lastSyncOk:  true,
        lastSyncVia: r?.via || '',
        lastSyncError: '',
        lastSyncResult: rawTrim ?? null,
      },
    },
    { upsert: true }
  );
  return { ok:true, balance:r.balance, via:r.via, currency:r.currency || 'THB' };
}

export async function refreshOtp24BalanceOnce() {
  const r = await getOtp24Balance();
  return writeFromResponse(r);
}

// fire-and-forget (ไม่บล็อก response ผู้ใช้)
export function refreshOtp24BalanceAsync() {
  setImmediate(() => {
    refreshOtp24BalanceOnce().catch(() => {});
  });
}
