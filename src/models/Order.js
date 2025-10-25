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
  providerServiceId: { type: Schema.Types.Mixed, required: true },
  link:              { type: String, required: true },
  quantity:          { type: Number, required: true, min: 1 },

  // ราคา
  estCost:     { type: Number, required: true }, // ยอดคาดการณ์/ยอดที่คิดตอนสั่ง (ปัด 2 ตำแหน่งแล้ว)
  cost:        { type: Number },                 // ยอดที่คิดจริง (ถ้ามี)
  currency:    { type: String, default: 'THB' },
  rateAtOrder: { type: Number },                 // เรตสุดท้ายต่อ 1k ตอนสั่ง (effective)

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

  // เวลา/การดำเนินการ
  acceptedAt:   { type: Date },
  canceledAt:   { type: Date },

  // การคืนเงิน
  refundAmount: { type: Number, default: 0, min: 0 },
  refundType:   { type: String, enum: ['full','partial','none', null], default: null },
  lastCancelId: { type: String },
  partialRefunds: [{
    amount: { type: Number, default: 0 },
    note:   { type: String, default: '' },
    at:     { type: Date, default: Date.now }
  }],

  // Refill
  lastRefillAt:       { type: Date },
  lastRefillResponse: { type: Schema.Types.Mixed },
  refillCount:        { type: Number, default: 0, min: 0 },

  // Spent
  spentAccounted:   { type: Number, default: 0 },
  spentAccountedAt: { type: Date },
}, {
  versionKey: false,
  timestamps: true, // createdAt / updatedAt
  strict: true
});

// Indexes
OrderSchema.index({ user: 1, status: 1 });
OrderSchema.index({ userId: 1, status: 1 });
OrderSchema.index({ user: 1, createdAt: -1 });
OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ spentAccounted: 1 });

// sync user <-> userId (กันโค้ดเก่า/ใหม่ใช้คนละคีย์)
OrderSchema.pre('save', function(next){
  if (this.userId && !this.user)   this.user   = this.userId;
  if (this.user   && !this.userId) this.userId = this.user;
  next();
});

/* ───────────────── Auto-recalc hooks ─────────────────
   ทุกครั้งที่มีการบันทึก/อัปเดตออเดอร์ จะคิวให้รีคำนวณยอดใช้จ่ายของผู้ใช้
   ใช้ dynamic import กัน circular dependency
*/
async function enqueueRecalc(userId, meta = {}) {
  if (!userId) return;
  try {
    const mod = await import('../services/spend.js');
    const { reconcileOrderSpend, recalcUserTotals } = mod;

    // ถ้ามี orderId ให้ reconcile แบบต่อใบก่อน (กันนับซ้ำและเก็บ delta)
    if (meta?.orderId) {
      await reconcileOrderSpend(meta.orderId);
    }

    // แล้วค่อย recalc ภาพรวม (ไม่ต้อง force เว้นเคสหนัก ๆ)
    await recalcUserTotals(userId, { reason: meta?.reason || 'order_event' });
  } catch (e) {
    // เงียบไว้ไม่ให้ throw ทำลาย flow สั่งซื้อ
  }
}

OrderSchema.post('save', function docSaved(doc) {
  const uid = doc?.userId || doc?.user;
  if (uid) enqueueRecalc(uid, { reason: 'order_saved', orderId: doc._id });
});

// สำหรับกรณีใช้ findOneAndUpdate / findByIdAndUpdate
OrderSchema.post('findOneAndUpdate', function postF1U(res) {
  const doc = res; // new:true แล้วจะเป็น doc หลังอัปเดต
  const upd = this.getUpdate?.() || {};
  const uid = doc?.userId || doc?.user || upd.userId || upd.user;
  if (uid) enqueueRecalc(uid, { reason: 'order_f1u', orderId: doc?._id });
});

export const Order = models.Order || model('Order', OrderSchema);
export default Order;
