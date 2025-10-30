// models/User.js
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const BankAccountSchema = new mongoose.Schema({
  accountCode:  { type: String, required: true, trim: true },   // eg. KTB, SCB, TRUEWALLET
  accountNumber:{ type: String, required: true, trim: true, unique: true },   // cleaned digits
  accountName:  { type: String, required: true, trim: true },   // ชื่อบัญชีตามจริง
}, { _id:false });

const UserSchema = new mongoose.Schema({
  // ── บัญชี ───────────────────────────────────────────────
  username: { type: String, required: true, trim: true, unique: true },
  email:    { type: String, trim: true, lowercase: true, index: true, unique: true, sparse: true },
  emailVerified: { type: Boolean, default: false },
  passwordHash: { type: String, required: true },
  role: { type: String, default: 'user' },

  // ── โปรไฟล์ ─────────────────────────────────────────────
  name: { type: String, default: '' },
  avatarUrl: { type: String, default: '/static/assets/logortsmmgif2.gif' },

  // ── กระเป๋าเงิน ─────────────────────────────────────────
  balance: { type: Number, default: 0 },
  currency: { type: String, default: 'THB' },

  // ── ค่าสถิติออเดอร์/การใช้จ่าย ─────────────────────────
  totalOrders:     { type: Number, default: 0 },
  totalOrdersPaid: { type: Number, default: 0 },
  totalSpentRaw:   { type: Number, default: 0 },
  totalSpent:      { type: Number, default: 0 },
  redeemedSpent:   { type: Number, default: 0 },

  // ── เลเวล ───────────────────────────────────────────────
  level:      { type: String, default: '1' },
  levelIndex: { type: Number, default: 0 },
  levelName:  { type: String, default: 'เลเวล 1' },
  levelNeed:  { type: Number, default: 0 }, 
  nextLevelName: { type: String, default: null },
  toNextLevel:   { type: Number, default: 0 },
  lastSpentAt:   { type: Date },

  // ── แต้มสะสม ────────────────────────────────────────────
  points:         { type: Number, default: 0 },
  pointsAccrued:  { type: Number, default: 0 },
  pointsRedeemed: { type: Number, default: 0 },
  pointRateTHB:   { type: Number, default: 0 },
  pointValueTHB:  { type: Number, default: 0 },

}, { timestamps: true });

// ── Methods ───────────────────────────────────────────────
UserSchema.methods.setPassword = async function (password) {
  this.passwordHash = await bcrypt.hash(password, 10);
};
UserSchema.methods.validatePassword = function (password) {
  return bcrypt.compare(password, this.passwordHash);
};

UserSchema.methods.addBalance = async function(amount){
  const val = Number(amount || 0);
  if (!Number.isFinite(val)) throw new Error('Invalid amount');
  const next = (this.balance ?? 0) + val;
  if (next < 0) throw new Error('Insufficient balance');
  this.balance = next;
  await this.save();
  return this.balance;
};

// ── Indexes ───────────────────────────────────────────────
UserSchema.index({ totalSpentRaw: 1 });
UserSchema.index({ levelIndex: 1 });

export const User = mongoose.model('User', UserSchema);
