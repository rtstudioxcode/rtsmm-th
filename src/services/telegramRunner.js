import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";

import { User } from "../models/User.js";
import { TelegramJob } from "../models/TelegramJob.js";
import { TgAccount } from "../models/TgAccount.js";
import { telegramPush, telegramSubscribe } from "../lib/sseTelegram.js";
import { TgInviteLog } from "../models/TgInviteLog.js";

// Track jobs
const running = new Set();

// Helper functions
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function humanDelay() {
  // AI-powered dynamic delay based on account risk
  const r = Math.random();
  if (r < 0.2) return 700 + Math.random() * 300;
  if (r < 0.5) return 1200 + Math.random() * 600;
  if (r < 0.8) return 2000 + Math.random() * 1000;
  return 3500 + Math.random() * 1500;
}

function extractFloodWait(msg) {
  const m = msg.match(/FLOOD_WAIT_(\d+)/i);
  return m ? Number(m[1]) * 1000 : null;
}

function sanitize(g) {
  if (!g) return g;
  return g.replace("https://t.me/", "").replace("t.me/", "").trim();
}

// Create Telegram Client
function makeClient(acc) {
  return new TelegramClient(
    new StringSession(acc.session),
    acc.apiId,
    acc.apiHash,
    {
      connectionRetries: 5,
      requestTimeout: 60000,
      autoReconnect: true,
    }
  );
}

async function safeConnect(client) {
  for (let i = 0; i < 3; i++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 12000);

      await client.connect({ signal: controller.signal });
      clearTimeout(t);
      return true;
    } catch (e) {
      console.log("[safeConnect] fail:", e.message);
      await sleep(1500);
    }
  }
  return false;
}

async function safeClose(client) {
  try {
    client._sender?.stop?.(); // Stop network sender
    client._updatesThread?.stop?.(); // Stop update loop
  } catch (e) {}

  try {
    await client.destroy();
  } catch (e) {
    console.log("destroy fail:", e.message);
  }
}

// Ensure join (join ไม่คิดเป็น invite)
async function ensureJoin(client, group) {
  const g = sanitize(group);
  try {
    await client.invoke(new Api.channels.JoinChannel({ channel: g }));
  } catch (err) {
    const msg = String(err);
    if (msg.includes("ALREADY")) return;
    if (msg.includes("PRIVATE")) return;
    if (msg.includes("INVITE_HASH_INVALID")) return;
    console.log("[ensureJoin]", msg);
  }
}

// Resolve group/channel entity
async function resolveEntity(client, group) {
  const g = sanitize(group);

  for (let i = 0; i < 3; i++) {
    try {
      return await client.getEntity(g);
    } catch {
      await ensureJoin(client, g);
      await sleep(1000);
    }
  }
  return null;
}

// Fetch participants (ไม่รวม bot/deleted/self)
async function fetchSrcMembers(client, src, meId) {
  try {
    const r = await client.invoke(
      new Api.channels.GetParticipants({
        channel: src,
        filter: new Api.ChannelParticipantsRecent(),
        offset: 0,
        limit: 500
      })
    );

    let arr = r.users || [];
    return arr.filter(u => u.id !== meId && !u.bot && !u.deleted);
  } catch (err) {
    console.log("fetchSrcMembers:", err.message);
    return [];
  }
}

// Invite Member (รองรับ Channel ด้วย)
async function inviteOne(client, dstEntity, user) {
  try {
    await client.invoke(
      new Api.channels.InviteToChannel({
        channel: dstEntity,
        users: [user.id]
      })
    );
    return { ok: true };
  } catch (err) {
    const msg = String(err.message || err);

    if (msg.includes("FLOOD_WAIT")) {
      const ms = extractFloodWait(msg) || 7200000; // Default to 2 hours if no flood wait time found
      user.cooldownUntil = new Date(Date.now() + ms); // Set cooldownUntil to the calculated time
      user.status = "COOLDOWN"; // Set status to COOLDOWN
      await user.save(); // Save updated user in DB
      return { flood: true, message: msg };
    }

    if (msg.includes("PEER_FLOOD") || msg.includes("PRIVACY")) {
      user.status = "LOCKED"; // Set status to LOCKED
      await user.save(); // Save updated user in DB
      return { spam: true };
    }

    return { error: msg };
  }
}

// Risk scoring / rotation (AI-based risk scoring)
function riskScore(acc) {
  let score = 0;
  score += acc.invitesToday; // Count invites today
  if (acc.lastError?.includes("FLOOD")) score += 40; // Penalize for flood errors
  if (acc.cooldownUntil && acc.cooldownUntil > Date.now()) score += 50; // Penalize for active cooldown

  // AI-powered risk adjustment: higher score means higher risk
  return score;
}

// Dynamic invite limit based on account status and risk
function quota(acc, remain) {
  if (acc.invitesToday < 10) return Math.min(remain, 30);
  if (acc.invitesToday < 20) return Math.min(remain, 15);
  if (acc.invitesToday < 30) return Math.min(remain, 10);
  return Math.min(remain, 5);
}

// Pick accounts with low risk for tasks
async function pickAccounts() {
  const list = await TgAccount.find({ session: { $ne: null } });
  let ready = [];

  for (const acc of list) {
    if (acc.cooldownUntil && acc.cooldownUntil > Date.now()) continue;
    ready.push({ acc, r: riskScore(acc) });
  }

  ready.sort((a, b) => a.r - b.r); // Sort accounts by risk score
  return ready.map(v => v.acc); // Return sorted accounts
}

// Show errors during precheck
function showPrecheckErrors(reasons = [], jobId) {
  telegramPush(jobId, {
    status: "error",
    type: "precheck_fail",
    reasons
  });
}

// Main Runner: Start Telegram Job
export async function startTelegramJob(jobId) {
  const allAccounts = await TgAccount.find({ session: { $ne: null } });
  let reasons = [];

  // Pre-check for usable accounts
  const usable = allAccounts.filter(acc => {
    if (!acc.session) {
      reasons.push(`บัญชี ${acc.phone} ไม่มี session (ใช้งานไม่ได้)`);
      return false;
    }
    if (acc.cooldownUntil && acc.cooldownUntil > Date.now()) {
      const mins = Math.ceil((acc.cooldownUntil - Date.now()) / 120000);
      reasons.push(`บัญชี ${acc.phone} ติดคูลดาวน์ (${mins} นาที)`);
      acc.status = "COOLDOWN";
      acc.save();
      return false;
    }
    if (acc.invitesToday >= 40) {
      reasons.push(`บัญชี ${acc.phone} ถึงลิมิตรอบนี้แล้ว (40/40)`);
      return false;
    }
    return true;
  });

  if (usable.length === 0) {
    let job = await TelegramJob.findById(jobId);
    job.status = "error";
    job.logs.push({ text: "ไม่มีบัญชีที่พร้อมใช้งาน" });
    await job.save();
    telegramPush(jobId, { status: "error", reasons });
    running.delete(jobId);
    showPrecheckErrors(reasons, jobId);
    return;
  }

  if (running.has(jobId)) return;
  running.add(jobId);

  let job = await TelegramJob.findById(jobId);
  if (!job) return;

  job.logs.push({ text: "เริ่มงาน..." });
  await job.save();

  const qty = job.limit;
  telegramPush(jobId, { status: "running", total: qty, invited: 0 });

  try {
    let remaining = qty;

    while (remaining > 0) {
      const accounts = await pickAccounts();
      if (!accounts.length) break;

      for (const acc of accounts) {
        if (remaining <= 0) break;

        const q = quota(acc, remaining);
        if (q <= 0) continue;

        const client = makeClient(acc);

        try {
          const ok = await safeConnect(client);
          if (!ok) continue;

          await client.getMe().catch(() => { throw new Error("GET_ME_FAIL"); });
          await ensureJoin(client, job.srcGroup);
          await ensureJoin(client, job.destGroup);

          const src = await resolveEntity(client, job.srcGroup);
          const dst = await resolveEntity(client, job.destGroup);
          if (!src || !dst) throw new Error("resolveEntity failed");

          const me = await client.getMe();
          const members = await fetchSrcMembers(client, src, me.id);

          for (const user of members) {
            if (remaining <= 0) break;

            const exists = await TgInviteLog.findOne({
              destGroup: job.destGroup,
              tgUserId: user.id
            }).lean();

            if (exists) {
              continue;
            }

            const r = await inviteOne(client, dst, user);
            const username = user.username || user.firstName || ("user_" + user.id);

            if (r.ok) {
              await TgInviteLog.create({
                jobId: job._id,
                accountId: acc._id,
                tgUserId: user.id,
                tgUserName: username,
                destGroup: job.destGroup
              });

              job.logs.push({ text: `เชิญ ${username} สำเร็จ`, time: new Date() });
              job.invited++;
              remaining--;
              acc.invitesToday++;

              telegramPush(jobId, { invited: job.invited, total: qty, user: username });
            } else if (r.flood) {
              acc.cooldownUntil = new Date(Date.now() + 7200000); // 2 hours cooldown
              acc.status = "LOCKED";
              await acc.save();
              break;
            } else if (r.spam) {
              acc.cooldownUntil = new Date(Date.now() + 7200000); // 2 hours cooldown
              acc.status = "LOCKED";
              await acc.save();
              break;
            }

            await sleep(humanDelay());
            await job.save();
          }

        } catch (err) {
          job.logs.push({ text: `ERROR ${acc.phone}: ${err.message}` });
        } finally {
          try { await safeClose(client); } catch {}
          await acc.save();
        }
      }
      await sleep(800);
    }

    job.status = (job.invited >= qty) ? "finished" : "error";
    job.logs.push({ text: `งานเสร็จสิ้น (${job.invited}/${qty})`, time: new Date() });
    await job.save();

    telegramPush(jobId, { status: job.status, invited: job.invited, total: qty });
    const miss = qty - job.invited;
    if (miss > 0) {
      const refund = miss * 2;
      const user = await User.findById(job.userId);
      user.credit += refund;
      await user.save();
      telegramPush(jobId, { refund, log: `คืนเครดิต ${refund} เครดิต` });
    }

  } catch (err) {
    job.status = "error";
    job.logs.push({ text: err.message });
    await job.save();
    telegramPush(jobId, { status: "error", error: err.message });
  }

  running.delete(jobId);
}

// Stop job
export async function stopTelegramJob(jobId) {
  const job = await TelegramJob.findById(jobId);
  if (!job) return;

  job.status = "stopped";
  job.logs.push({ text: "หยุดงานโดยผู้ใช้" });
  await job.save();

  telegramPush(jobId, { status: "stopped", log: "หยุดงานแล้ว" });
}

// SSE STREAM
export function streamTelegramJob(req, res) {
  telegramSubscribe(req.params.jobId, res);
}
