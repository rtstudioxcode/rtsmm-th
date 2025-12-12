import mongoose from "mongoose";

const TgAccountSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    username: { type: String, required: true },

    name: { type: String, required: true },

    phone: { type: String, required: true, unique: true },

    apiId: { type: Number, required: true },
    apiHash: { type: String, required: true },

    session: { type: String, required: true },

    status: {
        type: String,
        enum: ["READY", "COOLDOWN", "ERROR", "NEED_LOGIN", "LOCKED"],
        default: "READY"
    },

    // ระบบเช็คจำนวนเชิญต่อวัน
    invitesToday: { type: Number, default: 0 },
    lastInviteResetAt: { type: Date, default: null },

    // Error ล่าสุด
    lastError: { type: String, default: null },

    // สำหรับ login code
    phoneCodeHash: { type: String, default: null },

    lastJoined: {
        source: { type: String, default: null },
        dest: { type: String, default: null }
    },

    // กำลังถูกใช้งานกับงานไหน
    activeJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramJob', default: null },

    // lock account (ป้องกันงานอื่นใช้ชนกัน)
    lockedAt: { type: Date, default: null },
    lockUntil: { type: Date, default: null },

    // Cooldown (ถ้าโดน Flood)
    cooldownUntil: { type: Date, default: null },

}, { timestamps: true });

TgAccountSchema.index({ userId: 1, phone: 1 }, { unique: true });
TgAccountSchema.index({ userId: 1, status: 1, cooldownUntil: 1 });
TgAccountSchema.index({ activeJobId: 1 });

export const TgAccount = mongoose.model("TgAccount", TgAccountSchema);
