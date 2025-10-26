// // src/routes/api.orders.js
// import { Router } from 'express';
// import { requireLogin, requireAdmin } from '../middleware/auth.js';
// import { cancelOrder as pvCancel, getOrderStatus } from '../lib/iplusviewAdapter.js';

// const router = Router();

// /**
//  * คำนวณจำนวนเงินที่คืนได้
//  * - ถ้ามี remains/quantity => คืนตามสัดส่วนที่ยังไม่ถูกใช้
//  * - ถ้ามี progress => คืนตาม (100 - progress)%
//  * - ถ้าเป็น processing และไม่มีข้อมูลความคืบหน้า => คืนเต็ม
//  */
// function calcRefund(o) {
//   const cur = o.currency || o.service?.currency || 'THB';
//   const amount = Number(o.estCost ?? o.cost ?? (((o.quantity||0)/1000) * (o.service?.rate||0))) || 0;

//   const qty = Number(o.quantity)||0;
//   if (typeof o.remains === 'number' && qty > 0 && amount > 0) {
//     const leftPct = Math.max(0, Math.min(1, o.remains / qty));
//     const refund = +(amount * leftPct).toFixed(2);
//     return { refund, type: (refund <= 0 || refund >= amount) ? 'full' : 'partial', currency: cur };
//   }

//   if (typeof o.progress === 'number' && amount > 0) {
//     const leftPct = Math.max(0, Math.min(1, 1 - (o.progress/100)));
//     const refund = +(amount * leftPct).toFixed(2);
//     return { refund, type: (refund <= 0 || refund >= amount) ? 'full' : 'partial', currency: cur };
//   }

//   if (String(o.status||'').toLowerCase() === 'processing') {
//     return { refund: amount, type: 'full', currency: cur };
//   }

//   // ไม่มีข้อมูลจะคืนไม่ได้
//   return { refund: 0, type: 'none', currency: cur };
// }

// // ✅ อนุญาตทั้งเจ้าของออเดอร์ และแอดมิน
// router.post('/api/orders/:id/cancel', requireLogin, async (req, res) => {
//   try {
//     const { id } = req.params;
//     const Order = req.db?.Order;
//     const User  = req.db?.User;
//     if (!Order || !User) throw new Error('DB not injected');

//     const o = await Order.findById(id).populate('user service').exec();
//     if (!o) return res.status(404).json({ ok:false, error:'not found' });

//     const isAdmin = req.user?.role === 'admin';
//     const isOwner = String(o.user?._id || '') === String(req.user?._id || '');
//     if (!isAdmin && !isOwner) return res.status(403).json({ ok:false, error:'forbidden' });

//     const stLower = String(o.status||'').toLowerCase();
//     if (stLower === 'canceled') {
//       return res.json({ ok:true, already:true, status:'canceled', refundAmount: o.refundAmount||0, refundType: o.refundType||null });
//     }
//     if (stLower === 'completed') {
//       return res.status(400).json({ ok:false, error:'completed order cannot be canceled' });
//     }

//     let providerRejected = false;

//     // 1) พยายามยกเลิกกับผู้ให้บริการก่อน (ถ้ามี providerOrderId)
//     if (o.providerOrderId) {
//       try {
//         const pv = await pvCancel(o.providerOrderId);
//         // บางเจ้า “รับคำขอยกเลิก” แต่ยังไม่เปลี่ยนสถานะ ให้ถือว่าสำเร็จและไปขึ้นสถานะ canceled ในระบบเรา
//         // ถ้าเจ้าไหนตอบ reject ตรง ๆ ให้โยนไป fallback ด้านล่าง
//         const status = String(pv.status||'').toLowerCase();
//         if (/reject|denied|cannot|failed/.test(status)) providerRejected = true;
//       } catch (e) {
//         providerRejected = true;
//       }
//     } else {
//       // ไม่มีหมายเลขฝั่ง provider → ทำ local cancel เลย
//       providerRejected = true;
//     }

//     // 2) ตัดสินใจคืนเงิน + เปลี่ยนสถานะในระบบเรา (local cancel)
//     //    — ทำทั้งกรณี provider รับ/ไม่รับ เพื่อให้ผู้ใช้ได้คำตอบทันที
//     const { refund, type, currency } = calcRefund(o);

//     // คืนเงินเข้ากระเป๋าผู้ใช้ (ถ้ามีเงินจะคืน)
//     if (refund > 0 && o.user) {
//       await User.updateOne(
//         { _id: o.user._id },
//         { $inc: { balance: refund } }
//       );

//       // คุณอาจจะบันทึกรายการเดินบัญชีด้วย ถ้ามีโมเดล WalletTransaction
//       // await req.db.WalletTransaction.create({...})
//     }

//     // อัปเดตออเดอร์
//     o.status       = 'canceled';
//     o.refundAmount = refund;
//     o.refundType   = (type === 'none' ? null : type);
//     o.updatedAt    = new Date();
//     await o.save();

//     return res.json({
//       ok: true,
//       status: o.status,
//       refundAmount: refund,
//       refundType: o.refundType,
//       currency
//     });
//   } catch (e) {
//     console.error('cancel API error:', e?.response?.data || e);
//     res.status(500).json({ ok:false, error: e.message || 'cancel failed' });
//   }
// });

// export default router;
