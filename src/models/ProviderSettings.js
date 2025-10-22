import mongoose from 'mongoose';
export const ProviderSettings = mongoose.model('ProviderSettings', new mongoose.Schema({
  name: { type: String, default: 'iplusview' },
  lastBalance: { type: Number, default: 0 },
  lastSyncAt: Date,
}));
