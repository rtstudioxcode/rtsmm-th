import mongoose from "mongoose";

const TgAccountSchema = new mongoose.Schema({
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    ownerUsername: { type: String, required: true },

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
    activeJobId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // lock account (ป้องกันงานอื่นใช้ชนกัน)
    lockedAt: { type: Date, default: null },
    lockUntil: { type: Date, default: null },

    // Cooldown (ถ้าโดน Flood)
    cooldownUntil: { type: Date, default: null },

}, { timestamps: true });

export const TgAccount = mongoose.model("TgAccount", TgAccountSchema);
