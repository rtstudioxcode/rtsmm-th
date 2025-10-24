// src/models/Order.js
import mongoose from 'mongoose';
const { Schema, model, models } = mongoose;

const OrderSchema = new Schema({
  // ผู้สั่ง
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  // เผื่อโค้ดเก่าอ้าง 'user'
  user:   { type: Schema.Types.ObjectId, ref: 'User', index: true },

  // อ้างอิง service
  service: { type: Schema.Types.ObjectId, ref: 'Service', index: true },
  groupId: { type: Schema.Types.ObjectId },

  // ข้อมูลบริการ/ลิงก์/จำนวน
  providerServiceId: { type: Schema.Types.Mixed, required: true }, // ← รองรับทั้ง Number/String
  link:              { type: String, required: true },
  quantity:          { type: Number, required: true },

  // ราคา
  estCost:     { type: Number, required: true },
  cost:        { type: Number },
  currency:    { type: String, default: 'THB' },
  rateAtOrder: { type: Number },

  // ออเดอร์ของผู้ให้บริการ
  providerOrderId:  { type: String, index: true },
  providerResponse: { type: Schema.Types.Mixed },

  // สถานะ
  status: { type: String, default: 'processing', index: true },

  // ความคืบหน้า
  progress:     { type: Number, min: 0, max: 100 },
  remains:      { type: Number, min: 0 },
  startCount:   { type: Number, min: 0 },
  currentCount: { type: Number, min: 0 },
}, {
  versionKey: false,
  timestamps: true,             // ← ให้ Mongooseจัดการ createdAt/updatedAt
});

// Indexes
OrderSchema.index({ user: 1, status: 1 });
OrderSchema.index({ userId: 1, status: 1 });
OrderSchema.index({ user: 1, createdAt: -1 });
OrderSchema.index({ userId: 1, createdAt: -1 });

// sync user <-> userId (กันโค้ดเก่า/ใหม่ใช้คนละคีย์)
OrderSchema.pre('save', function(next){
  if (this.userId && !this.user)   this.user   = this.userId;
  if (this.user   && !this.userId) this.userId = this.user;
  next();
});

export const Order = models.Order || model('Order', OrderSchema);
export default Order;
