import mongoose from 'mongoose';

const OtpTokenSchema = new mongoose.Schema({
  email: { type: String, index: true, required: true },
  purpose: { type: String, default: 'email-verify' }, // เผื่ออนาคตมีหลายจุด
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: true },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  lastSentAt: { type: Date, default: null },
  usedAt: { type: Date, default: null },
}, { timestamps: true });

OtpTokenSchema.index({ email: 1, purpose: 1 });

export const OtpToken = mongoose.model('OtpToken', OtpTokenSchema);
