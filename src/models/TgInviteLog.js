// models/TgInviteLog.js
import mongoose from "mongoose";

const TgInviteLogSchema = new mongoose.Schema({
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: "TelegramJob" },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "TgAccount" },
  tgUserId: { type: Number, index: true },
  tgUserName: String,
  destGroup: String,
  createdAt: { type: Date, default: Date.now }
});

// index ป้องกัน insert ซ้ำในระดับ group
TgInviteLogSchema.index({ destGroup: 1, tgUserId: 1 }, { unique: true });

export const TgInviteLog = mongoose.model("TgInviteLog", TgInviteLogSchema);
