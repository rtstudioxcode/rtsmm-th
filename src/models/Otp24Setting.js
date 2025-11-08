// src/models/Otp24Setting.js
import mongoose from 'mongoose';

const Otp24SettingSchema = new mongoose.Schema(
  {
    // คีย์หลัก
    name: { type: String, default: 'otp24', index: true, unique: true },

    // เครดิต/ยอดเงินจากผู้ให้บริการ
    lastBalance: { type: Number, default: 0 },
    lastSyncAt: { type: Date, default: null },
    lastSyncError: { type: String, default: '' },
    lastSyncResult: { type: mongoose.Schema.Types.Mixed, default: null }, // ตัดทอนแล้วก่อนเซฟ

    // สถานะการซิงก์ "สินค้า/บริการ OTP"
    productsLastSyncAt: { type: Date, default: null },
    productsLastCount: { type: Number, default: 0 },
    productsLastError: { type: String, default: '' },
  },
  {
    collection: 'otp24setting',
    minimize: true,
    strict: true,
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  }
);

export const Otp24Setting =
  mongoose.models.Otp24Setting || mongoose.model('Otp24Setting', Otp24SettingSchema);
