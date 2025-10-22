// src/models/order.js
import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

const OrderSchema = new Schema(
  {
    // ผู้สั่ง
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true, required: true },
    // เผื่อโค้ดเก่าบางส่วนอ้าง 'user'
    user:   { type: Schema.Types.ObjectId, ref: 'User', index: true },

    // อ้างอิง service (ตัวแม่) เพื่อ join ชื่อ/เรตภายหลัง
    service: { type: Schema.Types.ObjectId, ref: 'Service', index: true },
    groupId: { type: Schema.Types.ObjectId }, // ใช้ตอนเลือกจากกลุ่ม

    // ข้อมูลบริการ/ลิงก์/จำนวน
    providerServiceId: { type: String, required: true },
    link:              { type: String, required: true },
    quantity:          { type: Number, required: true },

    // ราคา
    estCost:     { type: Number, required: true }, // เข้ากันกับโค้ดเดิม
    cost:        { type: Number },                 // ชื่อใหม่ (สำรองไว้ด้วย)
    currency:    { type: String, default: 'THB' },
    rateAtOrder: { type: Number },                 // อัตราตอนสั่ง (อ้างอิงทีหลัง)

    // ออเดอร์ของผู้ให้บริการ
    providerOrderId:  { type: String, index: true },
    providerResponse: { type: Schema.Types.Mixed }, // เก็บ payload/lastStatus

    // สถานะหลัก
    status:    { type: String, default: 'processing', index: true },

    // ฟิลด์สถานะตาม API เพื่อคำนวณเปอร์เซ็นต์
    // ถ้ามี progress (ทำไปแล้ว %), remains (เหลือ), start/current (นับจริง)
    progress:     { type: Number, min: 0, max: 100 },
    remains:      { type: Number, min: 0 },
    startCount:   { type: Number, min: 0 },
    currentCount: { type: Number, min: 0 },

    // ไทม์ไลน์
    acceptedAt: { type: Date },      // เวลาที่ออเดอร์ "รับเข้าระบบ" จริง
    createdAt:  { type: Date, default: Date.now },
    updatedAt:  { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// sync user <-> userId (กันโค้ดเก่า/ใหม่ใช้คนละคีย์)
OrderSchema.pre('save', function(next){
  if (this.userId && !this.user)  this.user = this.userId;
  if (this.user   && !this.userId) this.userId = this.user;
  this.updatedAt = new Date();
  next();
});

// ใช้ model ที่มีอยู่ถ้ามี (กันซ้ำ hot-reload)
const OrderModel = models.Order || model('Order', OrderSchema);

// export ได้ทั้ง named และ default
export const Order = OrderModel;
export default OrderModel;
