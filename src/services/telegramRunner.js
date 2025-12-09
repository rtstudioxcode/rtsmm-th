import { User } from "../models/User.js";
import { TelegramJob } from "../models/TelegramJob.js";
import { telegramPush } from "../lib/sseTelegram.js";

// หมายเหตุ: ตรงนี้จะใช้ GramJS หรือ Telethon ก็ได้
// ฉันเขียนในเชิงโครงเพื่อ integrate

let runningJobs = new Set();

export async function startTelegramJob(jobId) {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);

  const job = await TelegramJob.findById(jobId);
  if (!job) return;

  job.status = "running";
  job.logs.push({ text: "เริ่มกระบวนการดึงสมาชิก…" });
  await job.save();
  telegramPush(jobId, { status: "running" });

  try {
    // ================================
    // 1) เชื่อมต่อ Account Telegram
    // ================================
    const client = await connectTelegramClient(); // ← นายจะยัดฟังก์ชันจริงได้ทีหลัง

    // ================================
    // 2) ดึงสมาชิกจากกลุ่มต้นทาง
    // ================================
    const members = await fetchMembers(client, job.srcGroup, job.limit);

    // ================================
    // 3) เชิญไปกลุ่มปลายทาง
    // ================================
    for (let m of members) {
      if (job.status === "stopped") break;

      try {
        await inviteMember(client, job.destGroup, m);

        job.invited++;
        telegramPush(jobId, {
          invited: job.invited,
          total: job.limit,
          log: `เชิญ ${m.username || m.id} สำเร็จ`,
        });
      } catch (err) {
        job.failed++;
        telegramPush(jobId, {
          error: err.message,
          log: `เชิญ ${m.username || m.id} ไม่สำเร็จ`,
        });

        if (err.message.includes("FLOOD_WAIT")) {
          const sec = extractFloodWait(err);
          telegramPush(jobId, { log: `FLOOD_WAIT ${sec}s → พักชั่วคราว` });
          await sleep(sec * 1000);
        }
      }

      await job.save();
    }

    job.status = "finished";
    job.logs.push({ text: "งานเสร็จสิ้น" });
    await job.save();

    telegramPush(jobId, { status: "finished" });

    // คืนเครดิต (เฉพาะส่วน failed)
    const user = await User.findById(job.userId);
    const refund = job.failed * 5;
    user.wallet += refund;
    await user.save();
  } catch (err) {
    job.status = "error";
    job.logs.push({ text: "เกิดข้อผิดพลาด: " + err.message });
    await job.save();

    telegramPush(jobId, { status: "error", error: err.message });
  }

  runningJobs.delete(jobId);
}

// ─────────────────────────────
// STOP JOB
// ─────────────────────────────
export async function stopTelegramJob(jobId) {
  const job = await TelegramJob.findById(jobId);
  if (!job) return;

  job.status = "stopped";
  job.logs.push({ text: "หยุดงานโดยผู้ใช้" });
  await job.save();

  telegramPush(jobId, { status: "stopped" });
}

// ─────────────────────────────
// SSE STREAM
// ─────────────────────────────
export function streamTelegramJob(req, res) {
  const jobId = req.params.jobId;
  telegramSubscribe(jobId, res);
}

// ─────────────────────────────
// Helper
// ─────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
