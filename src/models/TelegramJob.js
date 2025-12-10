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

  status: {
    type: String,
    enum: ["pending", "running", "finished", "error", "stopped", "failed"],
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
