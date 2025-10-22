// src/models/PriceRule.js
import mongoose from 'mongoose';

const PriceRuleSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ['global','category','subcategory','service'], required: true },
    targetId: { type: String, default: '' }, // ว่างได้เมื่อ scope = global
    mode:  { type: String, enum: ['percent','delta','set'], required: true, default: 'percent' },
    value: { type: Number, required: true, default: 0 },
    priority: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// ชื่อโมเดล = 'PriceRule' ให้ตรงกับชื่อไฟล์และสิ่งที่ import
export const PriceRule =
  mongoose.models.PriceRule || mongoose.model('PriceRule', PriceRuleSchema);
