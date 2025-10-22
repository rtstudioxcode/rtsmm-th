import mongoose from 'mongoose';
import { config } from '../config.js';

export async function connectMongo() {
  mongoose.set('strictQuery', true);
  // ปล่อยให้ใช้ db จาก URI เลย (รวม query string เช่น authSource)
  await mongoose.connect(config.mongoUri);
  console.log('✅ Mongo connected');
}
