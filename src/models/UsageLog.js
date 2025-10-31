// src/models/UsageLog.js
import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;

/**
 * ใช้เก็บประวัติการหัก/คืนเครดิต ฯลฯ
 * - บรรทัด index ด้านล่างทำให้ (orderId,type='refund') เป็น unique
 *   เพื่อกัน "คืนเงินซ้ำ" เวลากดซ้ำ/เรียกซ้ำ
 */
const usageLogSchema = new Schema(
  {
    userId:   { type: Types.ObjectId, ref: 'User', required: true },
    orderId:  { type: Types.ObjectId, ref: 'Order', required: false },
    type:     { type: String, enum: ['refund', 'spend', 'topup'], required: true },
    amount:   { type: Number, required: true, default: 0 },
    currency: { type: String, default: 'THB' },
    note:     { type: String, default: '' },
  },
  { timestamps: true, versionKey: false }
);

// กันคืนเงินซ้ำ: unique เฉพาะเอกสารที่ type = 'refund'
usageLogSchema.index(
  { orderId: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: 'refund' } }
);

// ตั้งชื่อคอลเลกชันเป็น usage_logs ชัดๆ (ตัวเลือกที่ 3)
export const UsageLog = model('UsageLog', usageLogSchema, 'usage_logs');
