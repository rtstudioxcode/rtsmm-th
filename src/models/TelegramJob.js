import mongoose from "mongoose";

const LogSchema = new mongoose.Schema({
  time: { type: Date, default: Date.now },
  text: String,
});

const TargetSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["phone", "username"], required: true },
    value: { type: String, required: true },
  },
  { _id: false }
);

const TelegramJobSchema = new mongoose.Schema({
  orderId: { type: String, index: true, unique: true, sparse: true },

  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  username: { type: String, required: true },

  mode: { type: String, enum: ["group", "list"], default: "group" },
  targets: { type: [TargetSchema], default: [] },
  maxSecurity: { type: Boolean, default: false },

  srcGroup: { type: String, default: null },
  destGroup: { type: String, required: true },

  limit: { type: Number, default: 0 },
  invited: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ["pending", "running", "finished", "failed", "error", "stopped", "auto_stopped"],
    default: "pending",
  },

  logs: { type: [LogSchema], default: [] },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

TelegramJobSchema.pre("save", function () {
  this.updatedAt = new Date();
});

export const TelegramJob = mongoose.model("TelegramJob", TelegramJobSchema);
