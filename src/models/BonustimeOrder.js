// src/models/BonustimeOrder.js
import mongoose from "mongoose";

const BonustimeOrderSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  referrer:    { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  serialKey:   { type: String, index: true },
  type:        { type: String, enum: ["buy", "renew", "upgrade"], required: true },
  packageType: { type: String, enum: ["normal", "lotto"], required: true },
  days:        { type: Number, default: 0 },
  amountTHB:          { type: Number, required: true },
  affiliateRewardTHB: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

export const BonustimeOrder = mongoose.model("BonustimeOrder", BonustimeOrderSchema);
