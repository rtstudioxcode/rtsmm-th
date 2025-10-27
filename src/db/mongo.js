// src/db/mongo.js
import mongoose from 'mongoose';
import { config } from '../config.js';

function redact(uri = '') {
  return uri.replace(/:\/\/([^:@/]+):([^@/]+)@/, '://***:***@');
}

export async function connectMongo({
  retries = 5,
  baseDelayMs = 500,
} = {}) {
  mongoose.set('strictQuery', true);

  const uri = config.mongoUri || process.env.MONGO_URI;
  if (!uri) {
    throw new Error('Mongo URI not configured (config.mongoUri)');
  }

  const opts = {
    autoIndex: true,                // ปิดถ้าต้องการ
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 12_000,
    heartbeatFrequencyMS: 10_000,
    // family: 4,                   // บังคับ IPv4 (เปิดถ้า DNS งอแง)
  };

  let attempt = 0;
  while (true) {
    try {
      await mongoose.connect(uri, opts);
      console.log('✅ Mongo connected:', redact(uri));
      break;
    } catch (err) {
      attempt += 1;
      const isLast = attempt >= retries;
      console.warn(`⚠️ Mongo connect failed (attempt ${attempt}/${retries}): ${err?.message || err}`);
      if (isLast) throw err;
      const wait = baseDelayMs * Math.pow(2, attempt - 1); // 500, 1000, 2000...
      await new Promise(r => setTimeout(r, wait));
    }
  }

  // บาง event เอาไว้ช่วย debug เวลาเน็ตสะดุด
  const conn = mongoose.connection;
  conn.on('disconnected', () => console.warn('ℹ️ Mongo disconnected'));
  conn.on('reconnected', () => console.log('ℹ️ Mongo reconnected'));
  conn.on('error', (e) => console.error('❌ Mongo error:', e?.message || e));
}
