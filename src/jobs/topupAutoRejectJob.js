// src/jobs/topupAutoRejectJob.js
import cron from "node-cron";
import { Transaction } from "../models/Transaction.js";

async function autoRejectOrphanTopups(opts = {}) {
  const {
    logPrefix = "[TopupAutoRejectJob]",
    batchSize = 50, // กันเผื่อมีเยอะ ๆ จะได้ไม่ยิงทีเดียวทั้งก้อน
  } = opts;

  try {
    // === คำนวณเวลาตัด 12 ชั่วโมง ===
    const nowMs = Date.now();
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    const cutoff = new Date(nowMs - twelveHoursMs);

    // === หาเฉพาะรายการที่ไม่มี userId และค้างเกิน 12 ชม. ===
    const candidates = await Transaction.find({
      status: "pending",
      createdAt: { $lte: cutoff },
      $or: [
        { userId: { $exists: false } },
        { userId: null },
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

      // ติด tag ไว้ใน note ว่าถูก auto-reject เพราะไม่มี user
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
          `${logPrefix} auto reject tx=${tx.transactionId || tx._id} (no userId, >12h)`
        );
      }
    }

    return { ok: true, changed };
  } catch (err) {
    console.error("[TopupAutoRejectJob] error:", err);
    return { ok: false, error: err };
  }
}

// เรียกครั้งเดียวด้วยมือ (ถ้าอยาก debug)
export async function runTopupAutoRejectOnce() {
  return autoRejectOrphanTopups();
}

export function initTopupAutoRejectJob() {
  // ทุก ๆ 1 นาที (ตามเวลา Bangkok)
  const spec = "*/1 * * * *";
  console.log("[TopupAutoRejectJob] init with spec =", spec);

  cron.schedule(
    spec,
    async () => {
      const now = new Date().toISOString();
      // console.log("[TopupAutoRejectJob] tick at", now);
      await autoRejectOrphanTopups();
    },
    {
      timezone: "Asia/Bangkok",
    }
  );
}
