// scripts/recalc-all.js
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { recalcUserTotals } from '../src/services/spend.js';

const MONGO_URI = process.env.MONGO_URI
  || 'mongodb://mongo:UExusYQYbMpqTLSRXPKAMfHyuVaRoVnK@ballast.proxy.rlwy.net:33636/rtsmm-th?replicaSet=rs0&authSource=admin&retryWrites=true&w=majority';

const run = async () => {
  await mongoose.connect(MONGO_URI);
  const users = await User.find({}, {_id:1}).lean();
  for (const u of users) {
    await recalcUserTotals(u._id, { force: true, fullRescan: true });
    console.log('recalc ok:', String(u._id));
  }
  await mongoose.disconnect();
};
run().catch(e => { console.error(e); process.exit(1); });
