import mongoose from 'mongoose';

const Otp24ProductSchema = new mongoose.Schema({
  provider:  { type: String, default: 'otp24', index: true },

  // extId = id/code จากผู้ให้บริการ (อย่าเซ็ตเป็น null/'' เด็ดขาด)
  extId:     { type: String },            // <- สำคัญ
  itemId:    { type: String },            // เผื่อเก็บเพิ่ม
  code:      { type: String },

  name:      { type: String, required: true, index: true },
  basePrice: { type: Number, default: 0 },
  price:     { type: Number, default: 0 },
  currency:  { type: String, default: 'THB' },
  country:   { type: String },
  category:  { type: String },
  raw:       { type: mongoose.Schema.Types.Mixed },
  syncedAt:  { type: Date, default: Date.now },
}, { timestamps: true });

// unique เฉพาะเมื่อมี extId
Otp24ProductSchema.index({ provider: 1, extId: 1 }, { unique: true, sparse: true, name:'extId_1' });
// ตัวกันซ้ำสำรอง (กรณีไม่มี extId) = provider+name
Otp24ProductSchema.index({ provider: 1, name: 1 });

export const Otp24Product = mongoose.model('Otp24Product', Otp24ProductSchema);
