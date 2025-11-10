import mongoose from 'mongoose';
import { Otp24Order } from '../src/models/Otp24Order.js';
// import { mongoUri } from '../src/db/mongo.js';

const MONGO_URI = process.env.MONGO_URI
  || 'mongodb://mongo:UExusYQYbMpqTLSRXPKAMfHyuVaRoVnK@ballast.proxy.rlwy.net:33636/rtsmm-th?replicaSet=rs0&authSource=admin&retryWrites=true&w=majority';

await mongoose.connect(MONGO_URI);

const STOPS = ['timeout','failed','refunded'];
const r = await Otp24Order.updateMany(
  { status: { $in: STOPS }, refundApplied: { $ne: true } },
  { $set: { refundApplied: true }, $setOnInsert: {} }
);

console.log('updated:', r.modifiedCount);
await mongoose.disconnect();
process.exit(0);
