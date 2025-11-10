// models/AffWithdraw.js
import mongoose from 'mongoose';

const AffWithdrawSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  username: { type: String, index: true },
  amount:   { type: Number, required: true, min: 0 },
  kind:     { type: String, enum: ['balance','cash'], required: true }, 
  status:   { type: String, enum: ['success','fail'], default: 'success', index: true },
}, { timestamps: true });

AffWithdrawSchema.index({ createdAt: -1 });

export const AffWithdraw = mongoose.model('AffWithdraw', AffWithdrawSchema);
