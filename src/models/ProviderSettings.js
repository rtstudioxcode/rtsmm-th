// models/ProviderSettings.js
import mongoose from 'mongoose';

const LastSyncResultSchema = new mongoose.Schema({
  count:      { type: Number, default: 0 },  // จำนวน service ที่เพิ่ม/อัปเดต
  skipped:    { type: Number, default: 0 },  // ข้ามเพราะไม่มี id ฯลฯ
  logs:       { type: Number, default: 0 },  // จำนวน ChangeLog ที่บันทึก
  durationMs: { type: Number, default: 0 },  // เวลาที่ใช้ซิงก์ (ms)
}, { _id: false });

const ProviderSettingsSchema = new mongoose.Schema({
  name:        { type: String, default: 'iplusview', index: true },
  lastBalance: { type: Number, default: 0 },

  // เวลา sync ล่าสุด (เราอัปเดตให้ทุกครั้ง)
  lastSyncAt:  { type: Date, default: null, index: true },

  // ผลลัพธ์สรุปรอบล่าสุด (ไว้โชว์ UI)
  lastSyncResult: { type: LastSyncResultSchema, default: () => ({}) },

  // (เผื่ออนาคต) เก็บข้อความ error รอบล่าสุด
  lastSyncError:  { type: String, default: '' },
}, { timestamps: true });

export const ProviderSettings = mongoose.model('ProviderSettings', ProviderSettingsSchema);
