// src/models/Service.js
import mongoose from 'mongoose';

const ServiceSchema = new mongoose.Schema(
  {
    providerServiceId: String,
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    subcategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory' },

    name: String,
    description: String,
    currency: { type: String, default: 'THB' },

    rate: { type: Number, default: 0 },       // ราคาใช้งานจริง
    base_rate: { type: Number, default: 0 },  // ราคาเดิมจาก provider (กันทบซ้อน)

    min: Number,
    max: Number,
    step: Number,

    type: String,
    dripfeed: Boolean,
    refill: Boolean,
    cancel: Boolean,
    average_delivery: String,

    details: {},
    lastPricedAt: Date,
  },
  { timestamps: true }
);

export const Service =
  mongoose.models.Service || mongoose.model('Service', ServiceSchema);
