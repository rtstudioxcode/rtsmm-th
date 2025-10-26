import mongoose from "mongoose";

const topupSchema = new mongoose.Schema({
  accountCode: String,
  accountName: String,
  accountNumber: String,
  isActive: { type: Boolean, default: true },
  isSMS: { type: Boolean, default: false },
  isAuto: { type: Boolean, default: false },
  secret: String,
  type: String,
});

export const topup = mongoose.model("topup", topupSchema);