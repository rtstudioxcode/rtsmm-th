import mongoose from "mongoose";

const LogSchema = new mongoose.Schema({
  time: { type: Date, default: Date.now },
  text: String,
});

const TelegramJobSchema = new mongoose.Schema({
  orderId:    { type:String, index:true, unique:true, sparse:true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  username: { type: String, required: true },

  srcGroup: { type: String, required: true },
  destGroup: { type: String, required: true },

  limit: { type: Number, default: 0 },
  invited: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },

  // เพิ่ม fields สำหรับระบบ pause/resume
  scanOffset: { type: Number, default: 0 },       // offset สำหรับ GetParticipants
  pausedAt:   { type: Date, default: null },
  nextRunAt:  { type: Date, default: null },
  lastRunAt:  { type: Date, default: null },

  // กันงานหนักใน 1 รอบ
  runCount:   { type: Number, default: 0 },       // นับรอบที่รันไปแล้ว

  status: {
    type: String,
    enum: ["pending", "running", "finished", "error", "stopped", "failed", "stopped"],
    default: "pending",
  },

  logs: [LogSchema],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

TelegramJobSchema.pre("save", function () {
  this.updatedAt = new Date();
});

export const TelegramJob = mongoose.model("TelegramJob", TelegramJobSchema);
