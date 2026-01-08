// src/jobs/topupAutoRejectJob.js
import cron from "node-cron";
import { Transaction } from "../models/Transaction.js";

let BUSY = false;

async function autoRejectOrphanTopups(opts = {}) {
  const {
    logPrefix = "[TopupAutoRejectJob]",
    batchSize = 50,
    ageHours = 12,
  } = opts;

  // ✅ กันงานซ้อนรอบ (สำคัญมาก)
  if (BUSY) return { ok: true, skipped: true, changed: 0 };
  BUSY = true;

  try {
    const cutoff = new Date(Date.now() - ageHours * 60 * 60 * 1000);

    // ✅ รองรับ userId ว่าง/ไม่มี/เป็น string โดยไม่ทำ CastError
    // - ห้ามเขียน { userId: "" } ตรง ๆ เพราะ Mongoose จะ cast แล้วพัง
    const candidates = await Transaction.find({
      status: "pending",
      createdAt: { $lte: cutoff },
      $or: [
        { userId: { $exists: false } },
        { userId: null },
        { userId: { $type: "string" } }, // รวมถึง "" ด้วย
      ],
    })
      .sort({ createdAt: 1 })
      .limit(batchSize)
      .select("_id transactionId note") // ✅ เอาเท่าที่ใช้ ลด IO
      .lean();

    if (!candidates.length) return { ok: true, changed: 0 };

    const tag = "auto-reject:no-user";

    // ✅ ทำเป็น bulkWrite ยิงทีเดียว ลดรอบ DB
    const ops = candidates.map((tx) => {
      const note0 = (tx.note || "").toString();
      const note = note0.includes(tag) ? note0 : (note0 ? `${note0} | ${tag}` : tag);

      return {
        updateOne: {
          filter: { _id: tx._id, status: "pending" },
          update: { $set: { status: "reject", note } },
        },
      };
    });

    const res = await Transaction.bulkWrite(ops, { ordered: false });
    const changed = Number(res.modifiedCount || 0);

    if (changed) {
      console.log(`${logPrefix} auto rejected ${changed} tx (no userId, >${ageHours}h)`);
    }

    return { ok: true, changed };
  } catch (err) {
    console.error("[TopupAutoRejectJob] error:", err);
    return { ok: false, error: err?.message || String(err) };
  } finally {
    BUSY = false;
  }
}

// เรียกครั้งเดียวด้วยมือ (debug)
export async function runTopupAutoRejectOnce() {
  return autoRejectOrphanTopups();
}

export function initTopupAutoRejectJob() {
  const spec = "*/1 * * * *";
  console.log("[TopupAutoRejectJob] init with spec =", spec);

  cron.schedule(
    spec,
    async () => {
      await autoRejectOrphanTopups();
    },
    {
      timezone: "Asia/Bangkok",
      recoverMissedExecutions: true, // ✅ ถ้าพลาดเพราะ event loop หนัก ให้ตามเก็บ 1 ครั้ง
    }
  );
}
