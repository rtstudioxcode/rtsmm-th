// models/CatalogSnapshot.js
import mongoose from 'mongoose';

const CatalogSnapshotSchema = new mongoose.Schema({
  // เวลา snapshot (ใช้เรียง “ล่าสุด”)
  createdAt: { type: Date, default: Date.now, index: true },

  // ขอบเขต/แหล่งข้อมูล (เช่น 'iplusview' หรือ 'provider-X')
  scope: { type: String, default: 'iplusview', index: true },

  // กุญแจวัน (ช่วย group ภายในวันเดียวกันตาม TZ แอป)
  // เช่น '2025-10-29' (แนะนำ set จากโค้ด sync โดยใช้ dayjs.tz().format('YYYY-MM-DD'))
  dayKey: { type: String, index: true },

  // แผนที่สถานะเบาๆ: key -> 'open' | 'close'
  // key รูปแบบ:
  //   - service:<providerServiceId>
  //   - cat:<serviceGroupId>
  map: { type: Map, of: String, default: () => new Map() },

  // ตัวนับเพื่อสรุปเร็ว (ไม่ต้องวน map ทุกครั้ง)
  counts: {
    open:  { type: Number, default: 0 },
    close: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  }
}, { timestamps: true });

// คิวรี่ชุดยอดนิยม: ดู snapshot ล่าสุดของวัน/สโคป
CatalogSnapshotSchema.index({ scope: 1, dayKey: 1, createdAt: -1 });

export const CatalogSnapshot = mongoose.model('CatalogSnapshot', CatalogSnapshotSchema);
