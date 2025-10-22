// models/ChangeLog.js
import mongoose from 'mongoose';

const ChangeLogSchema = new mongoose.Schema({
  ts: { type: Date, default: Date.now, index: true },

  // target = service | category
  target: { type: String, enum: ['service', 'category'], required: true },

  // diff = new | open | close | removed | updated | state (ใช้ตอน bootstrap)
  diff: { type: String, required: true },

  // identifiers
  providerServiceId: String,     // สำหรับ service
  serviceGroupId: String,        // สำหรับหมวด/กลุ่ม (id เอกสาร Service ที่เป็นกลุ่ม)
  platform: String,              // ชื่อแพลตฟอร์ม (optional)
  categoryName: String,          // ชื่อหมวด
  serviceName: String,           // ชื่อบริการ

  // สถานะก่อน/หลัง (เผื่อโชว์)
  oldStatus: String,             // 'open' | 'close' | undefined
  newStatus: String,

  isBootstrap: { type: Boolean, default: false }, // ระบุว่าเป็น snapshot แรก
}, { timestamps: true });

ChangeLogSchema.index({ ts: -1 });
export const ChangeLog = mongoose.model('ChangeLog', ChangeLogSchema);
