// models/AppConfig.js
import mongoose from 'mongoose';

const AppConfigSchema = new mongoose.Schema({
  key:     { type: String, required: true, unique: true, index: true },
  value:   { type: mongoose.Schema.Types.Mixed, required: true },
  secret:  { type: Boolean, default: false },
  updatedBy: { type: String, default: '' },
}, { timestamps: true });

export const AppConfig = mongoose.model('AppConfig', AppConfigSchema);
