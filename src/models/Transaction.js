import mongoose from "mongoose";
import { ulid } from "ulid"; // npm install ulid

const TransactionSchema = new mongoose.Schema(
  {
    // ── ผู้ใช้ที่ทำการเติมเงิน ───────────────────────────
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ── ช่องทางการเติมเงิน ─────────────────────────────
    method: {
      type: String,
      enum: ["truewallet", "scb"],
      required: true,
    },

    // ── จำนวนเงิน ───────────────────────────────────────
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "THB" },

    // ── สถานะ ───────────────────────────────────────────
    status: {
      type: String,
      enum: ["pending", "completed", "failed", "cancelled"],
      default: "pending",
      index: true,
    },

    // ── หมายเลขธุรกรรมแบบ ULID ─────────────────────────
    transactionId: {
      type: String,
      unique: true,
      default: () => ulid(),
      index: true,
    },
  },
  { timestamps: true }
);

export const Transaction =
  mongoose.models.Transaction ||
  mongoose.model("Transaction", TransactionSchema);
