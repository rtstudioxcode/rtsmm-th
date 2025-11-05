// src/models/Otp24Item.js
import mongoose from 'mongoose';

const Otp24ItemSchema = new mongoose.Schema({
  // หมวดเรา: apppremium | termgame
  category: { type: String, enum: ['apppremium', 'termgame'], required: true },

  // คีย์อ้างอิงหลัก (unique ต่อ category)
  key: { type: String, required: true, index: true }, // เช่น type_code หรือ <type_game>:<type_code>

  // ฟิลด์ร่วม
  name: String,     // ชื่อสินค้า/เกม/แพค
  price: Number,    // ราคาหลัก (ต่อหน่วยสินค้า)
  img: String,      // URL รูปหลัก
  desc: String,     // รายละเอียด/คำอธิบาย
  meta: Object,     // เก็บโครงสร้างดิบบางส่วนไว้ตรวจสอบย้อนกลับ

  // สถานะ/สต็อก (ถ้ามี)
  amount: Number,   // คงเหลือ (เฉพาะ getpack)

  // ตราประทับเวลา sync
  syncedAt: { type: Date, default: Date.now },
}, { collection: 'otp24' });

Otp24ItemSchema.index({ category: 1, key: 1 }, { unique: true });

export const Otp24Item = mongoose.models.Otp24Item || mongoose.model('Otp24Item', Otp24ItemSchema);
