// models/AppConfig.js
import mongoose from 'mongoose';

const AppConfigSchema = new mongoose.Schema({
  key:     { type: String, required: true, unique: true, index: true }, // e.g. 'smtp', 'otp', 'session', 'ipv'
  value:   { type: mongoose.Schema.Types.Mixed, required: true },        // โครงสร้างอิสระ (object/number/string)
  secret:  { type: Boolean, default: false },                            // true = ซ่อนจาก UI/Log
  updatedBy: { type: String, default: '' },
}, { timestamps: true });

export const AppConfig = mongoose.model('AppConfig', AppConfigSchema);
