// src/models/PriceRule.js
import mongoose from 'mongoose';

const { Schema, Types } = mongoose;

/**
 * - scope:
 *   - 'global'        : ทั้งร้าน
 *   - 'category'      : Category._id (แพลตฟอร์ม เช่น Facebook, YouTube)
 *   - 'subcategory'   : Subcategory._id  (เผื่อของเก่า)
 *   - 'service'       : Service._id      (กลุ่ม/หมวด providerServiceId เดียวกัน)
 *   - 'serviceChild'  : details.services[].id (child id จากผู้ให้บริการ)
 *
 * - targetIds / targetId: เก็บไอดีเป้าหมาย (string)
 * - userScope: 'all' | 'user' (+ userId/userIds)
 * - platformId: เก็บเฉพาะเมื่อ scope='category' (เพิ่มเพื่ออ้างอิงแพลตฟอร์มโดยตรง)
 */

const PriceRuleSchema = new Schema(
  {
    scope: {
      type: String,
      enum: ['global', 'category', 'subcategory', 'service', 'serviceChild'],
      required: true,
    },

    // กลุ่มเป้าหมาย (หลายค่า)
    targetIds: { type: [String], default: undefined },

    // กลุ่มเป้าหมาย (เดี่ยว) – คงไว้เพื่อรองรับของเก่า
    targetId: { type: String, default: undefined },

    // เก็บ id แพลตฟอร์ม เมื่อ scope === 'category'
    platformId: { type: String, default: undefined },

    // โหมด/ค่า
    mode: { type: String, enum: ['percent', 'delta', 'set'], required: true },
    value: { type: Number, required: true },

    // ความสำคัญ/สถานะ
    priority: { type: Number, default: 100 },
    isActive: { type: Boolean, default: true },

    // ขอบเขตผู้ใช้
    userScope: { type: String, enum: ['all', 'user'], default: 'all' },
    userId: { type: Types.ObjectId, ref: 'User', default: undefined },
    userIds: { type: [Types.ObjectId], ref: 'User', default: undefined }
  },
  { minimize: true, timestamps: true }
);

/* ---------- Validators ---------- */
PriceRuleSchema.path('scope').validate(function () {
  if (this.scope === 'global') return true;
  const hasArray = Array.isArray(this.targetIds) && this.targetIds.length > 0;
  const hasSingle = typeof this.targetId === 'string' && this.targetId.trim() !== '';
  return hasArray || hasSingle;
}, 'targetIds/targetId ต้องมีอย่างน้อยหนึ่งค่าเมื่อ scope ไม่ใช่ global');

PriceRuleSchema.path('userScope').validate(function () {
  if (this.userScope !== 'user') return true;
  const many = Array.isArray(this.userIds) && this.userIds.length > 0;
  const single = !!this.userId;
  return many || single;
}, 'เมื่อ userScope = user ต้องระบุ userIds หรือ userId อย่างน้อยหนึ่งค่า');

/* ---------- Indexes ---------- */
PriceRuleSchema.index({ isActive: 1, priority: -1 });
PriceRuleSchema.index({ scope: 1, isActive: 1 });
PriceRuleSchema.index({ scope: 1, targetIds: 1, isActive: 1 });
PriceRuleSchema.index({ scope: 1, targetId: 1, isActive: 1 });
PriceRuleSchema.index({ userScope: 1, userId: 1, isActive: 1 });
PriceRuleSchema.index({ userScope: 1, userIds: 1, isActive: 1 });

// ช่วยให้ย้อนดู/กรองกฎตามแพลตฟอร์มได้ไวขึ้น (เวลา scope='category')
PriceRuleSchema.index({ platformId: 1, isActive: 1 });

export const PriceRule = mongoose.model('PriceRule', PriceRuleSchema);
