// src/jobs/topupAutoRejectJob.js
import cron from "node-cron";
import { Transaction } from "../models/Transaction.js";

async function autoRejectOrphanTopups(opts = {}) {
  const {
    logPrefix = "[TopupAutoRejectJob]",
    batchSize = 50, // กันเผื่อมีเยอะ ๆ จะได้ไม่ยิงทีเดียวทั้งก้อน
  } = opts;

  try {
    // หา transaction ที่ pending และไม่มี userId หรือ username
    const candidates = await Transaction.find({
        status: "pending",
        $or: [
            // ── ฝั่ง userId: ต้องไม่มี หรือเป็น null เท่านั้น (ห้ามใส่ "")
            { userId: { $exists: false } },
            { userId: null },

            // ── ฝั่ง username: ไม่มี / null / ว่าง
            { username: { $exists: false } },
            { username: null },
            { username: "" },
        ],
    })
        .sort({ createdAt: 1 })
        .limit(batchSize)
        .lean();

    if (!candidates.length) {
      // console.log(`${logPrefix} no orphan pending transactions`);
      return { ok: true, changed: 0 };
    }

    let changed = 0;

    for (const tx of candidates) {
      const update = {
        status: "reject",
      };

      // เพิ่ม note auto-reject ถ้ายังไม่มี
      const tag = "auto-reject:no-user";
      let note = tx.note || "";
      if (!note.includes(tag)) {
        note = note ? `${note} | ${tag}` : tag;
        update.note = note;
      }

      const res = await Transaction.updateOne(
        { _id: tx._id, status: "pending" }, // กัน race condition
        { $set: update }
      );

      if (res.modifiedCount > 0) {
        changed += 1;
        console.log(
          `${logPrefix} auto reject tx=${tx.transactionId || tx._id} (no userId/username)`
        );
      }
    }

    return { ok: true, changed };
  } catch (err) {
    console.error("[TopupAutoRejectJob] error:", err);
    return { ok: false, error: err };
  }
}

// export ไว้เผื่ออยากเรียกครั้งเดียวจากที่อื่น
export async function runTopupAutoRejectOnce() {
  return autoRejectOrphanTopups();
}

export function initTopupAutoRejectJob() {
  // ทุก ๆ 1 นาที
  const spec = "*/1 * * * *";
  console.log("[TopupAutoRejectJob] init with spec =", spec);

  cron.schedule(
    spec,
    async () => {
      const now = new Date().toISOString();
    //   console.log("[TopupAutoRejectJob] tick at", now);
      await autoRejectOrphanTopups();
    },
    {
      timezone: "Asia/Bangkok",
    }
  );
}
