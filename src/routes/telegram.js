// route/telegram.js
import { Router } from "express";
import { User } from "../models/User.js";
import { TelegramJob } from "../models/TelegramJob.js";
import { TgAccount } from "../models/TgAccount.js";
import { requireAuth } from "../middleware/auth.js";
import {
  sendCodeAndGetSession,
  resendCode,
  signInWithSession,
  checkPasswordWithSession
} from "../services/telegramLogin.js";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { telegramPush, telegramSubscribe } from "../lib/sseTelegram.js";
import { TgInviteLog } from "../models/TgInviteLog.js";
import { signPayload, verifyPayload } from "../lib/tgLoginToken.js";

const router = Router();

// HELPERS
// Track jobs
const running = new Set();
const stopRequested = new Set();
const PRICE_PER_PERSON = 0;
const MAX_LIMIT_PER_JOB = 1000;

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

async function finalizeEarly(job, jobId, qty, reasonText) {
  job.status = "stopped";
  job.logs.push({ text: `⛔ จบงานอัตโนมัติ: ${reasonText}`, time: new Date() });
  await job.save();

  telegramPush(jobId, { status: job.status, invited: job.invited, total: qty, log: `⛔ จบงานอัตโนมัติ: ${reasonText}` });

  const miss = qty - job.invited;
  if (miss > 0) {
    const refund = miss * PRICE_PER_PERSON;
    await User.updateOne({ _id: job.userId }, { $inc: { credit: refund } });
    telegramPush(jobId, { refund, log: `คืนเครดิต ${refund} เครดิต (ขาด ${miss} คน)` });
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
async function fetchSrcMembers(client, src, meId, jobId, want = 2000) {
  const out = [];
  const seen = new Set();
  const pageSize = 200;

  try {
    for (let offset = 0; offset < want; offset += pageSize) {
      const r = await client.invoke(new Api.channels.GetParticipants({
        channel: src,
        filter: new Api.ChannelParticipantsSearch({ q: "" }),
        offset,
        limit: pageSize
      }));

      const users = r.users || [];
      if (!users.length) break;

      for (const u of users) {
        if (!u || u.bot || u.deleted) continue;
        if (String(u.id) === String(meId)) continue;
        const key = String(u.id);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(u);
        if (out.length >= want) break;
      }
      if (out.length >= want) break;
    }

    return out;
  } catch (err) {
    const msg = String(err?.errorMessage || err?.message || err || "");

    if (msg.includes("CHAT_ADMIN_REQUIRED")) {
      telegramPush(jobId, {
        status: "failed",
        log: "❌ ดึงรายชื่อสมาชิกไม่ได้ (ต้องเป็นแอดมินในกลุ่มต้นทาง หรือกลุ่ม/ช่องนี้ไม่อนุญาตให้ดึงสมาชิก)"
      });

      await TelegramJob.updateOne(
        { _id: jobId },
        { $set: { status: "failed" }, $push: { logs: { text: "CHAT_ADMIN_REQUIRED: ต้องเป็นแอดมินในกลุ่มต้นทาง", time: new Date() } } }
      );

      return [];
    }

    telegramPush(jobId, { status: "error", log: "❌ error: " + msg });
    await TelegramJob.updateOne(
      { _id: jobId },
      { $set: { status: "error" }, $push: { logs: { text: "error: " + msg, time: new Date() } } }
    );

    return [];
  }
}

// Invite Member (รองรับ Channel ด้วย)
async function inviteOne(client, dstEntity, user) {
  try {
    const inputUser = await client.getInputEntity(user); // ✅ แปลงเป็น InputUser
    await client.invoke(new Api.channels.InviteToChannel({
      channel: dstEntity,
      users: [inputUser]
    }));
    return { ok: true };
  } catch (err) {
    const msg = String(err?.message || err);

    if (msg.includes("FLOOD_WAIT")) {
      const ms = extractFloodWait(msg) || 7200000;
      return { flood: true, waitMs: ms, message: msg };
    }
    if (msg.includes("PEER_FLOOD") || msg.includes("PRIVACY")) {
      return { spam: true, message: msg };
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
  const ROUND_LIMIT = 40;

  const total = Number(acc.invitesToday || 0);
  const usedInRound = total % ROUND_LIMIT;          // 0..39
  const leftInRound = ROUND_LIMIT - usedInRound;    // 40..1

  // ปลอดภัย: ถ้าเต็มรอบแล้ว (usedInRound=0 แต่ total>0) แปลว่าเพิ่งครบ 40/80/120
  // ควรพักบัญชี (แต่ใน runner คุณจะ set COOLDOWN แล้ว) ตรงนี้กันหลุดไว้เฉยๆ
  if (total > 0 && usedInRound === 0) return 0;

  // logic เดิม แต่ใช้ "usedInRound" แทน invitesToday
  let dynamic;
  if (usedInRound < 10) dynamic = 30;
  else if (usedInRound < 20) dynamic = 15;
  else if (usedInRound < 30) dynamic = 10;
  else dynamic = 5;

  return Math.min(remain, leftInRound, dynamic);
}
// Pick accounts with low risk for tasks
async function pickAccounts(userId) {
  if (!userId) return [];

  const list = await TgAccount.find({
    userId,
    session: { $ne: null }
  });

  const now = Date.now();
  const ready = [];

  for (const acc of list) {
    // ไม่เอาบัญชีคนอื่น (กันพลาด เผื่อ userId เป็น null)
    if (!acc.userId || String(acc.userId) !== String(userId)) continue;

    // ตัด LOCKED / COOLDOWN
    if (acc.status === "LOCKED") continue;
    if (acc.cooldownUntil && acc.cooldownUntil.getTime() > now) continue;

    ready.push({ acc, r: riskScore(acc) });
  }

  ready.sort((a, b) => a.r - b.r);
  return ready.map(v => v.acc);
}

// Show errors during precheck
function showPrecheckErrors(reasons = [], jobId) {
  telegramPush(jobId, {
    status: "error",
    type: "precheck_fail",
    reasons
  });
}

async function finalizeAutoStop(job, jobId, qty, reasonText) {
  job.status = "auto_stopped";
  job.logs.push({ text: `🛑 หยุดงานอัตโนมัติ: ${reasonText}`, time: new Date() });
  await job.save();

  telegramPush(jobId, {
    status: job.status,
    invited: job.invited,
    total: qty,
    log: `🛑 หยุดงานอัตโนมัติ: ${reasonText}`
  });

  const miss = qty - job.invited;
  if (miss > 0) {
    const refund = miss * PRICE_PER_PERSON;
    await User.updateOne({ _id: job.userId }, { $inc: { credit: refund } });
    job.logs.push({ text: `คืนเครดิต ${refund} เครดิต (ขาด ${miss} คน)`, time: new Date() });
    await job.save();
    telegramPush(jobId, { refund, log: `คืนเครดิต ${refund} เครดิต (ขาด ${miss} คน)` });
  }
}

// Main Runner: Start Telegram Job
export async function startTelegramJob(jobId) {
  if (running.has(jobId)) return;
  running.add(jobId);

  let job = null;
  try {
    job = await TelegramJob.findById(jobId);
    if (!job) return;

    const uid = job.userId; // ✅ เจ้าของงาน

    if (!uid) {
      job.status = "error";
      job.logs.push({ text: "เจ้าของงานหายไป: userId ว่างเปล่า", time: new Date() });
      await job.save();
      telegramPush(jobId, { status: "error", log: "เจ้าของงานหายไป" });
      return;
    }

    const now = Date.now();
    const reasons = [];

    // ✅ ดึงเฉพาะบัญชีของ user นี้เท่านั้น
    const allAccounts = await TgAccount.find({
      userId: uid,
      session: { $ne: null }
    });

    // Pre-check for usable accounts (เฉพาะของ user นี้)
    const usable = [];

    const ROUND_LIMIT = 40;
    const COOLDOWN_MS = 2 * 60 * 60 * 1000;

    
    for (const acc of allAccounts) {
      console.log(`ตรวจสอบบัญชี ${acc.phone}, owner=${acc.userId}, jobOwner=${uid}`);

      if (!acc.session) {
        reasons.push(`บัญชี ${acc.phone} ไม่มี session (ใช้งานไม่ได้)`);
        continue;
      }

      // กันเผื่อหลุดมา
      if (!acc.userId || String(acc.userId) !== String(uid)) {
        reasons.push(`บัญชี ${acc.phone} ไม่ใช่ของผู้ใช้งานนี้`);
        continue;
      }

      if (acc.status === "LOCKED") {
        reasons.push(`บัญชี ${acc.phone} ถูกล็อก (LOCKED)`);
        continue;
      }

      // ✅ ถ้าคูลดาวน์ยังไม่หมด = ใช้ไม่ได้
      if (acc.cooldownUntil && acc.cooldownUntil.getTime() > now) {
        const mins = Math.ceil((acc.cooldownUntil.getTime() - now) / 60000);
        reasons.push(`บัญชี ${acc.phone} ติดคูลดาวน์ (${mins} นาที)`);
        acc.status = "COOLDOWN";
        await acc.save();
        continue;
      }

      // ✅ ถ้าคูลดาวน์หมดแล้ว ให้ปลดกลับ READY
      if (acc.status === "COOLDOWN" && acc.cooldownUntil && acc.cooldownUntil.getTime() <= now) {
        acc.status = "READY";
        acc.cooldownUntil = null;
        await acc.save();
      }

      // ✅ “ต่อรอบ” = ดูยอดในรอบจาก mod 40
      const total = Number(acc.invitesToday || 0);
      const usedInRound = total % ROUND_LIMIT;

      // ✅ กันหลุด: ถ้าครบ 40/80/120 แล้วแต่ยังไม่ถูกตั้ง cooldown (เช่น crash ก่อน save)
      if (total > 0 && usedInRound === 0 && !acc.cooldownUntil) {
        acc.status = "COOLDOWN";
        acc.cooldownUntil = new Date(now + COOLDOWN_MS);
        await acc.save();
        reasons.push(`บัญชี ${acc.phone} ครบโควต้ารอบละ ${ROUND_LIMIT} แล้ว (พัก 2 ชม.)`);
        continue;
      }

      usable.push(acc);
    }

    if (usable.length === 0) {
      job.status = "error";
      job.logs.push({ text: "ไม่มีบัญชีที่พร้อมใช้งาน" });
      await job.save();

      telegramPush(jobId, { status: "error", reasons });
      showPrecheckErrors(reasons, jobId);
      return;
    }

    job.logs.push({ text: "เริ่มงาน..." });
    await job.save();

    const rawQty = Number(job.limit || 0);
    const qty = Math.min(rawQty, MAX_LIMIT_PER_JOB);

    if (rawQty !== qty) {
      job.limit = qty;
      job.logs.push({ text: `ปรับ limit จาก ${rawQty} → ${qty} (max ต่อรอบ)`, time: new Date() });
      await job.save();
    }

    telegramPush(jobId, { status: "running", total: qty, invited: 0 });
    let remaining = qty;

    while (remaining > 0) {
      if (stopRequested.has(String(jobId))) return;
      // ✅ หมุนเฉพาะบัญชีของ user นี้
      const accounts = await pickAccounts(uid);
      if (!accounts.length) {
        await finalizeEarly(job, jobId, qty, "บัญชีทั้งหมดติด COOLDOWN/LOCKED ก่อนเสร็จงาน");
        return;
      }

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
          let members = [];
          try {
            members = await fetchSrcMembers(client, src, me.id, jobId);
          } catch (err) {
            const msg = String(err?.message || err || "");

            const isAdminRequired =
              msg.includes("CHAT_ADMIN_REQUIRED") ||
              msg.includes("CHAT_ADMINISTRATOR_REQUIRED") ||
              msg.includes("channels.getParticipants");

            if (isAdminRequired) {
              const srcTxt = job?.srcGroup ? String(job.srcGroup) : "-";
              const dstTxt = job?.destGroup ? String(job.destGroup) : "-";
              const phone  = acc?.phone ? String(acc.phone) : "-";

              const reason =
                `ดึงสมาชิกไม่ได้ (ต้องเป็นแอดมินกลุ่ม/ช่อง) [CHAT_ADMIN_REQUIRED]\n` +
                `• บัญชีที่ใช้: ${phone}\n` +
                `• กลุ่มเป้าหมาย: ${srcTxt}\n` +
                `• กลุ่มปลายทาง: ${dstTxt}\n` +
                `วิธีแก้: เพิ่มบัญชีนี้เป็น Admin ในกลุ่ม/ช่องหรือใช้กลุ่ม/ช่องที่อนุญาตเพิ่มสมาชิกได้`;

              // ✅ เก็บลงรายงาน
              job.logs.push({ text: `🛑 AUTO STOP: ${reason}`, time: new Date() });
              await job.save();

              // ✅ จบงานทันที + เปลี่ยนสถานะ auto_stopped + คืนเครดิตที่เหลือ
              await finalizeAutoStop(job, jobId, qty, reason);
              return;
            }

            // ไม่ใช่เคส admin required ก็โยนให้ catch ใหญ่จัดการ
            throw err;
          }

          for (const user of members) {
            if (stopRequested.has(String(jobId))) return;

            if (remaining <= 0) break;

            const exists = await TgInviteLog.findOne({
              destGroup: job.destGroup,
              tgUserId: user.id
            }).lean();

            if (exists) continue;

            const r = await inviteOne(client, dst, user);
            const username = user.username || user.firstName || ("user_" + user.id);

            if (r.ok) {
              await TgInviteLog.create({
                jobId: job._id,
                accountId: acc._id,
                tgUserId: user.id,
                tgUserName: username,
                srcGroup: job.srcGroup,
                destGroup: job.destGroup
              });

              job.logs.push({ text: `เชิญ ${username} สำเร็จ`, time: new Date() });
              job.invited++;
              remaining--;
              acc.invitesToday++;

              if (acc.invitesToday % ROUND_LIMIT === 0) {
                acc.cooldownUntil = new Date(Date.now() + COOLDOWN_MS);
                acc.status = "COOLDOWN";
                await acc.save();

                // ✅ ถ้ายังเหลืองาน แต่ไม่มีบัญชีให้ทำต่อ -> จบเลย
                if (remaining > 0) {
                  const left = await pickAccounts(uid);
                  if (!left.length) {
                    await finalizeEarly(job, jobId, qty, `บัญชีครบโควต้า ${ROUND_LIMIT}คน/รอบ และไม่มีบัญชีสำรอง`);
                    return;
                  }
                }

                break;
              }

              telegramPush(jobId, { invited: job.invited, total: qty, user: username });
            } else if (r.flood || r.spam) {
              acc.cooldownUntil = new Date(Date.now() + COOLDOWN_MS);
              acc.status = "COOLDOWN";
              await acc.save();

              if (remaining > 0) {
                const left = await pickAccounts(uid);
                if (!left.length) {
                  await finalizeEarly(job, jobId, qty, "ระบบของ Telegram จำกัดการเชิญชั่วคราว (ถูกมองว่าส่งคำเชิญถี่เกินไป/เสี่ยงสแปม) จึงพักบัญชีทั้งหมดไว้ก่อน เพื่อความปลอดภัย");
                  return;
                }
              }

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
      const refund = miss * PRICE_PER_PERSON;
      const user = await User.findById(job.userId);
      user.credit += refund;
      await user.save();
      telegramPush(jobId, { refund, log: `คืนเครดิต ${refund} เครดิต` });
    }

  } catch (err) {
    if (job) {
      job.status = "error";
      job.logs.push({ text: err.message });
      await job.save();
    }
    telegramPush(jobId, { status: "error", error: err.message });
  } finally {
    running.delete(jobId);
    stopRequested.delete(String(jobId));
  }
}

// Stop job
export async function stopTelegramJob(jobId, by = "user") {
  const id = String(jobId || "");
  if (!id) return { ok:false, error:"missing jobId" };

  const job = await TelegramJob.findById(id);
  if (!job) return { ok:false, error:"not_found" };

  // กันซ้ำ: ถ้าไม่ใช่ running แล้ว ไม่ต้องทำอะไร
  if (String(job.status) !== "running") {
    return { ok:false, error:`not_running:${job.status}` };
  }

  const qty = Number(job.limit || 0);
  const invited = Number(job.invited || 0);
  const miss = Math.max(0, qty - invited);
  const refund = miss * PRICE_PER_PERSON;

  // สั่ง runner ให้หยุดทันที (signal)
  stopRequested.add(id);

  // ปิดงานทันที + เก็บ log ไว้ในรายงาน
  job.status = "stopped";
  job.logs.push({
    text: `⛔ หยุดงานโดย ${by === "user" ? "ผู้ใช้" : by} (คืน ${refund} เครดิต / ขาด ${miss} คน)`,
    time: new Date()
  });
  await job.save();

  // คืนเครดิตตามที่เหลือ
  if (refund > 0) {
    await User.updateOne({ _id: job.userId }, { $inc: { credit: refund } });
  }

  // ส่ง realtime ไปหน้าเว็บ
  telegramPush(id, {
    status: "stopped",
    invited,
    total: qty,
    refund,
    log: `⛔ หยุดงานแล้ว • คืน ${refund} เครดิต (ขาด ${miss} คน)`
  });

  return { ok:true, refund, miss, invited, total: qty };
}

// SSE STREAM
export function streamTelegramJob(req, res) {
  telegramSubscribe(req.params.jobId, res);
}

// ───────────────────────────────────────────────────────────────
// helpers (วางไว้ด้านบนไฟล์ routes)
// ───────────────────────────────────────────────────────────────
function clamp(str, max = 60) {
  return String(str || "").trim().slice(0, max);
}

function safeUsername(input, fallback) {
  let u = String(input || "").trim();
  // อนุญาต a-z 0-9 _ . (เหมือนๆ ข้อจำกัดที่เจอบ่อย)
  u = u.toLowerCase().replace(/[^a-z0-9_\.]/g, "");
  if (!u) u = String(fallback || "").replace(/\D/g, "");
  if (!u) u = "tguser_" + Date.now();
  return clamp(u, 32);
}


/* ===============================================================
   PAGE: Telegram UI
=============================================================== */
router.get("/", requireAuth, (req, res) => {
  res.render("telegram/index", {
    title: "RTSSM-TH.COM | บอทเทเลแกรม"
  });
});

/* ===============================================================
   TELEGRAM ACCOUNT — USER LIST
=============================================================== */
router.get("/accounts", requireAuth, async (req, res) => {
  try {
    const uid = req.session.user._id;

    const accounts = await TgAccount.find({ userId: uid })
      .select("name phone status invitesToday lastError createdAt cooldownUntil")
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ ok: true, accounts });
  } catch (err) {
    console.error("TG ACCOUNT LIST ERROR:", err);
    return res.json({ ok: false });
  }
});

/* =====================================================================
   STEP 1 — START LOGIN (ส่ง OTP)
===================================================================== */
router.post("/accounts/login/start", requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.json({ ok:false, error:"ไม่ได้ล็อกอิน" });

    const uid = user._id;
    const username = user.username;

    let phone    = String(req.body.phone || "").trim();
    let apiId    = Number(req.body.apiId);
    let apiHash  = String(req.body.apiHash || "").trim();
    const name   = clamp(req.body.name, 60); // optional ชื่อที่ผู้ใช้กรอก

    if (!phone || !apiId || !apiHash) return res.json({ ok:false, error:"กรอกข้อมูลให้ครบ" });
    if (isNaN(apiId)) return res.json({ ok:false, error:"apiId ต้องเป็นตัวเลข" });

    const r = await sendCodeAndGetSession({ phone, apiId, apiHash });
    if (!r || !r.ok) return res.json({ ok:false, error:r?.error || "ส่งรหัสไม่สำเร็จ" });

    const loginToken = signPayload({
      userId: uid,
      username,              // username ฝั่งเว็บ
      displayName: name,     // เก็บชื่อจากฟอร์ม (ถ้ามี)
      phone, apiId, apiHash,
      phoneCodeHash: r.phoneCodeHash,
      sessionString: r.sessionString,
      ts: Date.now()
    });

    return res.json({ ok:true, codeSent:true, loginToken });
  } catch (err) {
    console.error("START_LOGIN_ERROR:", err);
    return res.json({ ok:false, error:"เกิดข้อผิดพลาด" });
  }
});

/* =====================================================================
   STEP 1.1 — RESEND OTP
===================================================================== */
router.post("/accounts/login/resend", requireAuth, async (req, res) => {
  try {
    const { loginToken } = req.body;
    if (!loginToken) return res.json({ ok:false, error:"ไม่มี token" });

    const data = verifyPayload(loginToken);
    if (!data) return res.json({ ok:false, error:"token ผิด" });

    const r = await resendCode({
      sessionString: data.sessionString,
      phone: data.phone,
      apiId: data.apiId,
      apiHash: data.apiHash
    });
    if (!r.ok) return res.json(r);

    const clean = { ...data }; // displayName จะถูกเก็บต่ออยู่ในนี้
    delete clean.exp;

    const newToken = signPayload({
      ...clean,
      phoneCodeHash: r.phoneCodeHash,
      sessionString: r.sessionString,
      ts: Date.now()
    });

    return res.json({ ok:true, loginToken:newToken });
  } catch (err) {
    console.error("RESEND ERROR:", err);
    return res.json({ ok:false });
  }
});

/* =====================================================================
   STEP 2 — VERIFY OTP / PASSWORD (2FA)
===================================================================== */
router.post("/accounts/login/finish", requireAuth, async (req, res) => {
  try {
    const { loginToken } = req.body;
    const code = (req.body.code || "").trim();
    const password = (req.body.password || "").trim();

    const data = verifyPayload(loginToken);
    if (!data) return res.json({ ok:false, error:"token ผิด" });
    if (Date.now() - data.ts > 15 * 60 * 1000)
      return res.json({ ok:false, error:"หมดอายุแล้ว" });

    let result = null;

    if (password && code) {
      result = await checkPasswordWithSession({
        sessionString: data.sessionString,
        password, apiId: data.apiId, apiHash: data.apiHash
      });
    } else if (password) {
      result = await checkPasswordWithSession({
        sessionString: data.sessionString,
        password, apiId: data.apiId, apiHash: data.apiHash
      });
    } else if (code) {
      result = await signInWithSession({
        sessionString: data.sessionString,
        phone: data.phone,
        phoneCodeHash: data.phoneCodeHash,
        code, apiId: data.apiId, apiHash: data.apiHash
      });
      if (result.needPassword) {
        const clean = { ...data }; delete clean.exp;
        const nextToken = signPayload({ ...clean, sessionString: result.sessionString, ts: Date.now() });
        return res.json({ ok:false, needPassword:true, loginToken:nextToken });
      }
    } else {
      return res.json({ ok:false, error:"กรุณากรอกข้อมูล" });
    }

    if (!result || !result.ok) {
      return res.json({ ok:false, error:result?.error || "เกิดข้อผิดพลาด" });
    }

    // สร้างชื่อ/ยูสเซอร์เนมสุดท้าย
    const me = result.me || {};
    const providedName = clamp(data.displayName, 60);
    const tgName = clamp([me.firstName, me.lastName].filter(Boolean).join(" "), 60);

    const nameFinal =
      providedName || tgName || (me.username ? `@${me.username}` : String(data.phone));

    const usernameFinal = safeUsername(
      me.username,
      data.username || data.phone || ("tguser_" + Date.now())
    );

    // upsert
    let acc = await TgAccount.findOne({ phone: data.phone, userId: data.userId });

    if (!acc) {
      acc = new TgAccount({
        userId: data.userId,
        name: nameFinal,
        username: usernameFinal,
        phone: data.phone,
        apiId: data.apiId,
        apiHash: data.apiHash,
        session: result.sessionString,
        status: "READY",
        invitesToday: 0,
        lastInviteResetAt: new Date()
      });
    } else {
      acc.apiId   = data.apiId;
      acc.apiHash = data.apiHash;
      acc.session = result.sessionString;
      acc.status  = "READY";
      if (providedName) acc.name = providedName;
      if (!acc.name) acc.name = nameFinal;
      if (!acc.username) acc.username = usernameFinal;
    }

    await acc.save();

    return res.json({
      ok:true,
      me: result.me,
      account: { id: acc._id, name: acc.name, username: acc.username }
    });

  } catch (err) {
    console.error("FINISH LOGIN ERROR:", err);
    return res.json({ ok:false, error:"เกิดข้อผิดพลาด" });
  }
});

/* ===============================================================
   DELETE ACCOUNT
=============================================================== */
router.delete("/accounts/:id/unlink", requireAuth, async (req, res) => {
  try {
    const uid = req.session.user._id;
    const id = req.params.id;

    const acc = await TgAccount.findById(id);
    if (!acc) return res.json({ ok: false, message: "ไม่พบข้อมูลบัญชี" });

    if (String(acc.userId) !== String(uid)) {
      return res.json({ ok: false, message: "ไม่มีสิทธิ์ลบ" });
    }

    await TgAccount.updateOne(
      { _id: id },
      { $unset: { userId: "", username: "" } }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("UNLINK ERROR:", err);
    return res.json({ ok: false, message: "เกิดข้อผิดพลาด" });
  }
});

/* ===============================================================
   START TELEGRAM JOB — พร้อมระบบ PRECHECK แบบเต็ม
=============================================================== */
router.post("/jobs/start", requireAuth, async (req, res) => {
  try {
    const uid  = req.session.user._id;
    const user = await User.findById(uid).lean();
    if (!user) return res.json({ ok:false, error:"ไม่พบผู้ใช้" });

    const { srcGroup, destGroup, limit, maxSecurity } = req.body;

    const reasons = [];

    /* =========================
       VALIDATE INPUT
    ========================== */
    if (!srcGroup || !destGroup) {
      reasons.push("กรุณากรอกลิงก์กลุ่มต้นทางและปลายทาง");
    }

    const qty = Math.floor(Number(limit) || 0);

    if (qty <= 0) reasons.push("จำนวนสมาชิกต้องมากกว่า 0");
    if (qty > MAX_LIMIT_PER_JOB) reasons.push(`สูงสุด ${MAX_LIMIT_PER_JOB} คนต่อรอบ`);

    /* =========================
       ตรวจ CREDIT (2 เครดิต/คน)
    ========================== */
    

    const cost = qty * PRICE_PER_PERSON;
    if (user.credit < cost) {
      reasons.push(`เครดิตไม่เพียงพอ (ต้องใช้ ${cost} เครดิต)`);
    }

    /* =========================
      ตรวจบัญชี Telegram พร้อมใช้งาน
    ========================== */
    const accounts = await TgAccount.find({ userId: uid })
      .select("phone status cooldownUntil session")
      .lean();

    if (!accounts.length) {
      reasons.push("คุณยังไม่มีบัญชี Telegram ในระบบ");
    }

    const now = Date.now();

    /* READY ใช้งานได้จริง = READY + มี session + ไม่ติดคูลดาวน์ */
    const readyAcc = accounts.filter(a => {
      if (a.status !== "READY") return false;
      if (!a.session) return false;

      if (!a.cooldownUntil) return true;

      const until = new Date(a.cooldownUntil).getTime();
      return until <= now;
    });

    if (!readyAcc.length) {
      reasons.push("ยังไม่มีบัญชีพร้อมใช้งาน (READY)");
    }

    /* =========================
      ตรวจ COOL DOWN (แค่รายงาน ไม่ต้องแก้ DB)
    ========================== */
    for (const acc of accounts) {
      if (acc.status === "COOLDOWN" && acc.cooldownUntil) {
        const until = new Date(acc.cooldownUntil).getTime();
        const diff = until - now;

        if (diff > 0) {
          const min = Math.ceil(diff / 60000);
          reasons.push(`บัญชี ${acc.phone} ติดคูลดาวน์อีก ${min} นาที`);
        }
      }
    }

    /* =========================
       มีเหตุผลที่งานเริ่มไม่ได้?
    ========================== */
    if (reasons.length > 0) {
      return res.json({
        ok: false,
        type: "precheck_fail",
        reasons
      });
    }

    /* =========================
       PRECHECK ผ่าน → เริ่มสร้างงาน
    ========================== */
    const orderId = "TG" + Date.now().toString().slice(-8);

    const job = await TelegramJob.create({
      orderId,
      userId: uid,
      username: user.username,
      srcGroup,
      destGroup,
      limit: qty,
      invited: 0,
      failed: 0,
      status: "running",
      maxSecurity: !!maxSecurity,
      logs: [],
      createdAt: new Date()
    });

    // ตัดเครดิต (กรณี cost = 0 = ไม่ตัด)
    await User.updateOne(
      { _id: uid },
      { $inc: { credit: -cost } }
    );

    // เริ่มทำงานแบบ async
    startTelegramJob(job._id);

    return res.json({ ok:true, jobId: job._id, orderId: job.orderId });

  } catch (err) {
    console.error("START_JOB_ERROR:", err);
    return res.json({ ok:false, error:"เกิดข้อผิดพลาด" });
  }
});

/* ===============================================================
   STOP TELEGRAM JOB
=============================================================== */
router.post("/jobs/:jobId/stop", requireAuth, async (req, res) => {
  try {
    const uid = req.session.user._id;
    const jobId = req.params.jobId;

    const job = await TelegramJob.findById(jobId); // ✅ ไม่ใช้ lean เพราะต้อง save()
    if (!job) return res.json({ ok:false, error:"ไม่พบงาน" });

    if (String(job.userId) !== String(uid)) {
      return res.json({ ok:false, error:"ไม่มีสิทธิ์หยุดงาน" });
    }

    // ✅ แสดงปุ่มเฉพาะ running อยู่แล้ว แต่กันซ้ำอีกชั้น
    if (String(job.status) !== "running") {
      return res.json({ ok:false, error:`งานไม่อยู่ในสถานะ running (ตอนนี้: ${job.status})` });
    }

    const qty = Number(job.limit || 0);
    const invited = Number(job.invited || 0);
    const miss = Math.max(0, qty - invited);
    const refund = miss * PRICE_PER_PERSON;

    // ✅ สั่งให้ runner หยุดทันที (in-memory signal)
    stopRequested.add(String(jobId));

    // ✅ ปิดงานทันที
    job.status = "stopped";
    job.logs.push({ text: `⛔ หยุดงานโดยผู้ใช้ (คืน ${refund} เครดิต / ขาด ${miss} คน)`, time: new Date() });
    await job.save();

    // ✅ คืนเครดิตตามคนที่เหลือ
    if (refund > 0) {
      await User.updateOne({ _id: job.userId }, { $inc: { credit: refund } });
    }

    telegramPush(jobId, {
      status: "stopped",
      invited,
      total: qty,
      refund,
      log: `⛔ หยุดงานแล้ว • คืน ${refund} เครดิต (ขาด ${miss} คน)`
    });

    return res.json({ ok:true, refund, miss, invited, total: qty });

  } catch (err) {
    console.error("STOP_JOB_ERROR:", err);
    return res.json({ ok:false, error:"เกิดข้อผิดพลาด" });
  }
});

/* ===============================================================
   JOB STREAM (ไม่ต้อง admin)
=============================================================== */
router.get("/jobs/:jobId/stream", requireAuth, async (req, res) => {
  const uid = req.session.user._id;
  const job = await TelegramJob.findById(req.params.jobId).select("userId").lean();
  if (!job) return res.status(404).end();
  if (String(job.userId) !== String(uid)) return res.status(403).end();
  streamTelegramJob(req, res);
});

/* ===============================================================
   PAGE: Telegram Pull History
=============================================================== */
router.get("/history", requireAuth, async (req, res) => {
  try {
    const uid = req.session.user._id; // Get the user ID from the session

    // Fetch job history for the user
    const history = await TelegramJob.find({ userId: uid })
      .select("orderId srcGroup destGroup invited limit status createdAt logs")
      .sort({ createdAt: -1 })  // Sort by the latest date
      .lean();  // Convert to JavaScript object for easier manipulation

    // Pass history to the EJS template
    res.render("telegram/history", {
      title: "ประวัติการใช้งาน",
      history: history,
    });
  } catch (err) {
    console.error("Error fetching history:", err);
    res.status(500).send("Error fetching data");
  }
});

/* ===============================================================
   API: HISTORY LIST
=============================================================== */
router.get("/history/list", requireAuth, async (req, res) => {
  try {
    const uid = req.session.user._id;

    const list = await TelegramJob.find({ userId: uid })
      .select("srcGroup destGroup invited limit status logs createdAt")
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ ok: true, list });
  } catch (err) {
    console.error("TG HISTORY LIST ERROR:", err);
    return res.json({ ok: false, error: "เกิดข้อผิดพลาด" });
  }
});

export default router;
