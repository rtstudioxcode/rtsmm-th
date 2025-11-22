// src/jobs/bonustimeExpiryJob.js
import cron from "node-cron";
import { checkAndSendBonustimeExpiryMails } from "../services/bonustimeExpiry.js";

export function initBonustimeExpiryJob() {
  // Set the schedule to run once a day at midnight
  const spec = "0 0 * * *"; // Every day at 00:00 (midnight)
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
      timezone: "Asia/Bangkok", // Use the correct timezone
    }
  );
}

// export function initBonustimeExpiryJob() {
//   // ตั้งเวลาให้ทำงานทุกๆ 10 วินาที
//   const spec = "*/10 * * * * *"; // ทุกๆ 10 วินาที
//   console.log("[BonustimeExpiryJob] init with spec =", spec);

//   cron.schedule(
//     spec,
//     async () => {
//       const now = new Date().toISOString();
//       console.log("[BonustimeExpiryJob] tick at", now);
//       try {
//         const result = await checkAndSendBonustimeExpiryMails({
//           logPrefix: "[BonustimeExpiryJob]",
//         });
//         console.log("[BonustimeExpiryJob] result =", result);
//       } catch (err) {
//         console.error("[BonustimeExpiryJob] error:", err);
//       }
//     },
//     {
//       timezone: "Asia/Bangkok",
//     }
//   );
// }

// export function initBonustimeExpiryJob() {
//   const spec = process.env.BONUSTIME_CRON || "5 * * * *"; // นาทีที่ 5 ของทุกชั่วโมง
//   console.log("[BonustimeExpiryJob] init with spec =", spec);

//   cron.schedule(
//     spec,
//     async () => {
//       const now = new Date().toISOString();
//       console.log("[BonustimeExpiryJob] tick at", now);
//       try {
//         const result = await checkAndSendBonustimeExpiryMails({
//           logPrefix: "[BonustimeExpiryJob]",
//         });
//         console.log("[BonustimeExpiryJob] result =", result);
//       } catch (err) {
//         console.error("[BonustimeExpiryJob] error:", err);
//       }
//     },
//     {
//       timezone: "Asia/Bangkok",
//     }
//   );
// }
