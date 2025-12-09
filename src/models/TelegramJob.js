import mongoose from "mongoose";

const LogSchema = new mongoose.Schema({
  time: { type: Date, default: Date.now },
  text: String,
});

const TelegramJobSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

  srcGroup: { type: String, required: true },
  destGroup: { type: String, required: true },

  limit: { type: Number, default: 0 },
  invited: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ["pending", "running", "finished", "error", "stopped"],
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
