// scripts/seed-otp24.js
import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI
  || 'mongodb://mongo:UExusYQYbMpqTLSRXPKAMfHyuVaRoVnK@ballast.proxy.rlwy.net:33636/rtsmm-th?replicaSet=rs0&authSource=admin&retryWrites=true&w=majority';

await mongoose.connect(MONGO_URI);
const col = mongoose.connection.db.collection('secure_config');

const baseapiotp = 'https://otp24hr.com/api/v1';
const keyapi = 'FYTFCNKB2848DVQYO8JYQ1KLWW4NM6EMIBI2DF';

// อัปเดตเอกสารตัวแรก (ไม่ใส่ filter เฉพาะ => เอกสารแรกของคอลเลกชัน)
const r = await col.updateOne(
  {}, // ถ้าคุณมีเอกสารตัวเดียว วิธีนี้จะโดนตัวนั้น
  { $set: { otp24: { apiBase: baseapiotp, apiKey: keyapi } } },
  { upsert: true }
);

const doc = await col.findOne({});
console.log('matched', r.matchedCount, 'modified', r.modifiedCount, 'upsertedId', r.upsertedId);
console.log('current secure_config snapshot:', { _id: doc?._id, otp24: doc?.otp24 });

await mongoose.disconnect();
