// src/jobs/bonustimeExpiryJob.js
import cron from "node-cron";
import { checkAndSendBonustimeExpiryMails } from "../services/bonustimeExpiry.js";

export function initBonustimeExpiryJob() {
  // รันทุกชั่วโมงนับนาทีที่ 5 (เช่น 00:05, 01:05, 02:05, ...)
  cron.schedule(
    "5 * * * *",
    async () => {
      try {
        const result = await checkAndSendBonustimeExpiryMails({
          logPrefix: "[BonustimeExpiryJob]",
        });
        if (result.sent > 0) {
          console.log(
            `[BonustimeExpiryJob] sent ${result.sent} emails to ${result.users} users`
          );
        }
      } catch (err) {
        console.error("[BonustimeExpiryJob] error:", err);
      }
    },
    {
      timezone: "Asia/Bangkok",
    }
  );

  console.log("[BonustimeExpiryJob] scheduled: every hour at minute 5 (Asia/Bangkok)");
}
