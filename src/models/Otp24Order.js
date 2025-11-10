import mongoose from 'mongoose';

const Otp24OrderSchema = new mongoose.Schema({
  provider:   { type:String, default:'otp24', index:true },
  user:       { type: mongoose.Schema.Types.ObjectId, ref:'User', index:true },

  productId:  { type: mongoose.Schema.Types.ObjectId, ref:'Otp24Product' },
  appName:    { type:String },
  serviceCode:{ type:String },        // โค้ดที่ยิงไป (เช่น "go")
  countryId:  { type:Number, index:true },

  providerPrice: { type:Number, default:0 },
  salePrice:     { type:Number, default:0 },

  orderId:    { type:String, index:true, unique:true, sparse:true },
  phone:      { type:String },

  // สถานะหลัก
  status:     { 
    type:String, 
    enum: ['processing','success','timeout','failed','refunded','canceled'],
    default:'processing',
    index:true
  },
  otp:        { type:String },
  message:    { type:String },

  // เส้นตาย & การคืนเงิน
  createdAt:  { type: Date, index:true },
  expiresAt:  { type: Date, index:true },
  refundApplied: { type: Boolean, default: false, index: true },
  refundedAt:    { type: Date },
  refundNote:    { type: String },
}, { timestamps:true, collection:'otp24orders' });

export const Otp24Order =
  mongoose.models.Otp24Order || mongoose.model('Otp24Order', Otp24OrderSchema);