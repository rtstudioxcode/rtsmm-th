import mongoose from 'mongoose';

const JobLockSchema = new mongoose.Schema({
  key:        { type: String, unique: true, index: true },
  owner:      { type: String },               // hostname/pid
  lockedAt:   { type: Date,   default: Date.now },
  expiresAt:  { type: Date,   index: true },  // TTL-like
}, { versionKey: false });

export const JobLock = mongoose.models.JobLock || mongoose.model('JobLock', JobLockSchema);

/** จองล็อก ถ้าซ้ำ/หมดอายุจะยกให้ตัวใหม่ */
export async function acquireLock(key, ttlMs = 60_000, owner = process.env.INSTANCE_ID || process.pid.toString()){
  const now = new Date();
  const exp = new Date(now.getTime() + ttlMs);
  const res = await JobLock.findOneAndUpdate(
    {
      key,
      $or: [
        { expiresAt: { $lte: now } },
        { expiresAt: { $exists: false } },
      ],
    },
    { key, owner, lockedAt: now, expiresAt: exp },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  // ถ้าเราได้เอกสารมา แต่มี owner ไม่ใช่เรา และยังไม่หมดอายุ แปลว่าไม่ได้ล็อก
  if (res.owner !== owner && res.expiresAt > now) return null;
  return res;
}

export async function prolongLock(key, ttlMs = 60_000, owner = process.env.INSTANCE_ID || process.pid.toString()){
  const now = new Date();
  const exp = new Date(now.getTime() + ttlMs);
  const res = await JobLock.findOneAndUpdate(
    { key, owner },
    { expiresAt: exp },
    { new: true }
  ).lean();
  return !!res;
}

export async function releaseLock(key, owner = process.env.INSTANCE_ID || process.pid.toString()){
  await JobLock.deleteOne({ key, owner });
}
