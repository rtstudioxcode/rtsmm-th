// src/jobs/bonustimeExpiryJob.js
import cron from "node-cron";
import { checkAndSendBonustimeExpiryMails } from "../services/bonustimeExpiry.js";

export function initBonustimeExpiryJob() {
  const spec = process.env.BONUSTIME_CRON || "5 * * * *"; // นาทีที่ 5 ของทุกชั่วโมง
  console.log("[BonustimeExpiryJob] init with spec =", spec);

  cron.schedule(
    spec,
    async () => {
      const now = new Date().toISOString();
      console.log("[BonustimeExpiryJob] tick at", now);
      try {
        const result = await checkAndSendBonustimeExpiryMails({
          logPrefix: "[BonustimeExpiryJob]",
        });
        console.log("[BonustimeExpiryJob] result =", result);
      } catch (err) {
        console.error("[BonustimeExpiryJob] error:", err);
      }
    },
    {
      timezone: "Asia/Bangkok",
    }
  );
}
