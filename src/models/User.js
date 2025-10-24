// models/User.js
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const UserSchema = new mongoose.Schema({
  level: { type: String, default: '1' },
  name: { type: String, default: '' },
  avatarUrl: { type: String, default: '/static/assets/img/user-blue.png' },
  username: { type: String, required: true, trim: true, unique: true },
  email:    { type: String, trim: true, lowercase: true, index: true, unique: true, sparse: true },
  emailVerified: { type: Boolean, default: false },
  passwordHash: { type: String, required: true },
  role: { type: String, default: 'user' },
  balance: { type: Number, default: 0 },
  totalOrders: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  currency: { type: String, default: 'THB' },
}, { timestamps: true });

UserSchema.methods.setPassword = async function (password) {
  this.passwordHash = await bcrypt.hash(password, 10);
};
UserSchema.methods.validatePassword = function (password) {
  return bcrypt.compare(password, this.passwordHash);
};

// เติมเงิน/หักเงินอย่างปลอดภัย
UserSchema.methods.addBalance = async function(amount){
  const val = Number(amount || 0);
  if (!Number.isFinite(val)) throw new Error('Invalid amount');
  const next = (this.balance ?? 0) + val;
  if (next < 0) throw new Error('Insufficient balance');
  this.balance = next;
  await this.save();
  return this.balance;
};

export const User = mongoose.model('User', UserSchema);
