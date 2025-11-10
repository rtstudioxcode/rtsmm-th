import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { recalcUserTotals } from '../src/services/spend.js';

const MONGO_URI = process.env.MONGO_URI
  || 'mongodb://mongo:UExusYQYbMpqTLSRXPKAMfHyuVaRoVnK@ballast.proxy.rlwy.net:33636/rtsmm-th?replicaSet=rs0&authSource=admin&retryWrites=true&w=majority';

(async () => {
  await mongoose.connect(MONGO_URI);
  const cursor = User.find({}, { _id:1 }).cursor();

  let ok = 0, fail = 0;
  for await (const u of cursor) {
    try {
      await recalcUserTotals(u._id, { force: true, reason: 'otp24_success_only_migration' });
      ok++;
    } catch (e) {
      console.error('FAIL', u._id, e?.message || e);
      fail++;
    }
  }
  await mongoose.disconnect();
  console.log('DONE:', { ok, fail });
})();
