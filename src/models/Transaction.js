// import mongoose from "mongoose";
// import { ulid } from "ulid"; // npm install ulid

// const TransactionSchema = new mongoose.Schema(
//   {
//     // ── ผู้ใช้ที่ทำการเติมเงิน ───────────────────────────
//     userId: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "User",
//       index: true,
//     },

//     // ── ช่องทางการเติมเงิน ─────────────────────────────
//     method: {
//       type: String,
//       enum: ["tw", "scb", "kbank", "manual"],
//       required: true,
//     },

//     senderBank: String,
//     senderLast6: String,
//     receiverLast6: String,
//     senderNumber: String,

//     // ── จำนวนเงิน ───────────────────────────────────────
//     amount: { type: Number, required: true, min: 0 },
//     currency: { type: String, default: "THB" },

//     // ── สถานะ ───────────────────────────────────────────
//     status: {
//       type: String,
//       enum: ["pending", "completed", "failed", "cancelled"],
//       default: "pending",
//       index: true,
//     },

//     // ── หมายเลขธุรกรรมแบบ ULID ─────────────────────────
//     transactionId: {
//       type: String,
//       unique: true,
//       default: () => ulid(),
//       index: true,
//     },
//   },
//   { timestamps: true }
// );

// export const Transaction =
//   mongoose.models.Transaction ||
//   mongoose.model("Transaction", TransactionSchema);


// models/Transaction.js
import mongoose from "mongoose";
import { ulid } from "ulid";

const TransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },

  username: { type: String },

  method: { type: String, enum: ["tw","scb","kbank","manual"], required: true },

  // จาก SMS/สลิป
  senderBank: String,
  senderLast6: String,
  receiverLast6: String,
  senderNumber: String,

  // จำนวนเงิน
  amount: { type: Number, required: true, min: 0 },          // 10.31
  amountCents: { type: Number, required: true, index: true }, // 1031 (สำคัญ!)

  currency: { type: String, default: "THB" },

  status: {
    type: String,
    enum: ["pending","completed","failed","cancelled", "reject"],
    default: "pending",
    index: true,
  },

  // ข้อมูลประกอบ
  transactionId: { type: String, unique: true, default: () => ulid(), index: true },
  expectedAmount: Number,
  expiresAt: Date,
  paidAt: Date,
  matchedBy: String, 
  matchedTxId: mongoose.Schema.Types.ObjectId,
  note: String,
}, { timestamps: true });

TransactionSchema.index({ method: 1, status: 1, amountCents: 1, createdAt: -1 });
TransactionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { status: 'pending' } }
);

export const Transaction =
  mongoose.models.Transaction || mongoose.model("Transaction", TransactionSchema);
