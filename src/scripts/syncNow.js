// src/scripts/syncNow.js
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectMongoIfNeeded, refreshConfigFromDB, config } from '../config.js';
import { _runDailyNow } from '../jobs/dailyChangeSync.js';

(async () => {
  try {
    // 1) ต่อ Mongo (ถ้ายังไม่ต่อ)
    await connectMongoIfNeeded();

    // 2) โหลดคอนฟิกจาก DB → อัปเดต config สด
    await refreshConfigFromDB();

    // 3) Log ให้รู้ว่าคีย์/provider ถูกตั้งแล้วจริง
    console.log('[config] provider.baseUrl =', config.provider.baseUrl || '(empty)');
    console.log('[config] provider.apiKey  =', config.provider.apiKey ? '(set)' : '(empty)');

    // 4) รันทันที (จะซิงก์บริการ + prune changelog เก่า 3 วัน)
    await _runDailyNow();
  } catch (e) {
    console.error('syncNow error:', e?.response?.data || e);
    process.exitCode = 1;
  } finally {
    // ปิดการเชื่อมต่อให้เรียบร้อย (ให้ Node จบโปรเซสเองอย่างปลอดภัย)
    try { await mongoose.connection.close(); } catch {}
  }
})();
