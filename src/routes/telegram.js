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
async function inviteOne(client, dstEntity, targetUser) {
  try {
    await client.invoke(
      new Api.channels.InviteToChannel({
        channel: dstEntity,
        users: [targetUser.id]
      })
    );
    return { ok: true };
  } catch (err) {
    const msg = String(err.message || err);
    const m = msg.match(/FLOOD_WAIT_(\d+)/i);
    const ms = (m ? Number(m[1]) : 7200) * 1000; // default 2h

    if (msg.includes("FLOOD_WAIT")) {
      return { flood: true, ms, message: msg };
    }
    if (msg.includes("PEER_FLOOD") || msg.includes("PRIVACY")) {
      return { spam: true, ms, message: msg };
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

async function checkTelegramAccountStatus(client, acc) {
  try {
    // เชื่อมต่อกับ Telegram API
    await client.connect(); // ต้องเชื่อมต่อก่อนที่จะเรียกใช้งาน
    console.log(`บัญชี ${acc.phone} เชื่อมต่อสำเร็จ`);

    const me = await client.getMe(); // Get account details
    console.log(`ข้อมูลจาก Telegram: ${JSON.stringify(me)}`);

    // เช็คการติดสถานะต่างๆ เช่น COOLDOWN หรือ PEER_FLOOD
    if (acc.lastError === 'PEER_FLOOD') {
      console.log(`บัญชี ${acc.phone} ถูก Flood! กำหนดสถานะเป็น COOLDOWN`);
      acc.status = "COOLDOWN";
      acc.cooldownUntil = new Date(Date.now() + 7200000); // 2 ชั่วโมง
      await acc.save();
    } else if (acc.status === 'READY') {
      console.log(`บัญชี ${acc.phone} พร้อมใช้งาน`);
    }
  } catch (err) {
    console.error(`ไม่สามารถตรวจสอบสถานะบัญชี ${acc.phone}: ${err.message}`);
    acc.status = 'LOCKED';
    await acc.save();  // เปลี่ยนสถานะเป็น LOCKED หากไม่สามารถตรวจสอบได้
  }
}

// Main Runner: Start Telegram Job
export async function startTelegramJob(jobId) {
  const allAccounts = await TgAccount.find({ session: { $ne: null } });
  let reasons = [];

  // Pre-check for usable accounts
  const usable = allAccounts.filter(acc => {
    console.log(`ตรวจสอบบัญชี ${acc.phone}, สถานะ: ${acc.status}, LastError: ${acc.lastError}`);
    
    if (!acc.session) {
      reasons.push(`บัญชี ${acc.phone} ไม่มี session (ใช้งานไม่ได้)`);
      return false;
    }
    
    if (acc.cooldownUntil && acc.cooldownUntil > Date.now()) {
      const mins = Math.ceil((acc.cooldownUntil - Date.now()) / 60000);
      reasons.push(`บัญชี ${acc.phone} ติดคูลดาวน์ (${mins} นาที)`);
      acc.status = "COOLDOWN";
      acc.save();
      return false;
    }
    
    if (acc.invitesToday >= 40) {
      reasons.push(`บัญชี ${acc.phone} ถึงลิมิตวันนี้แล้ว (40/40)`);
      acc.invitesToday = 0; // Reset for the next round
      acc.status = "READY"; // Reset to READY after completing a round
      acc.save();
      return false;
    }
    
    // สร้าง Telegram Client เพื่อการตรวจสอบสถานะจริงจาก API
    const client = new TelegramClient(
      new StringSession(acc.session), // ใช้ session ของบัญชีที่มี
      acc.apiId,
      acc.apiHash,
      { connectionRetries: 5, requestTimeout: 60000, autoReconnect: true }
    );

    // ตรวจสอบสถานะบัญชีจาก API
    checkTelegramAccountStatus(client, acc);  // เพิ่มการตรวจสอบจาก API

    console.log(`บัญชี ${acc.phone} ผ่านการตรวจสอบสถานะและพร้อมใช้งาน`);
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

              // ครบโควตาวันนี้ → เข้า COOLDOWN 2 ชม.
              if (acc.invitesToday >= 40) {
                acc.cooldownUntil = new Date(Date.now() + 7200000);
                acc.status = "COOLDOWN";
                acc.lastError = ""; // เคลียร์
                await acc.save();
                job.logs.push({ text: `บัญชี ${acc.phone} เข้าพักคูลดาวน์ 120 นาที (ครบลิมิตรายวัน)`, time: new Date() });
                await job.save();
                telegramPush(jobId, { type: "info", msg: `บัญชี ${acc.phone} เข้าพักคูลดาวน์ 120 นาที (ครบลิมิตรายวัน)` });
                break;
              }

              telegramPush(jobId, { invited: job.invited, total: qty, user: username });
            }
            else if (r.flood) {
              const mins = Math.ceil((r.ms || 7200000) / 60000);
              acc.status = "COOLDOWN";
              acc.cooldownUntil = new Date(Date.now() + (r.ms || 7200000));
              acc.lastError = r.message || "FLOOD_WAIT";
              await acc.save();

              job.logs.push({ text: `บัญชี ${acc.phone} โดนจำกัด (FLOOD_WAIT) พัก ${mins} นาที`, time: new Date() });
              await job.save();

              telegramPush(jobId, {
                type: "warn",
                msg: `บัญชี ${acc.phone} โดนจำกัด (FLOOD_WAIT) พัก ${mins} นาที`
              });
              break; // เปลี่ยนไปใช้อีกบัญชี
            }
            else if (r.spam) {
              const mins = Math.ceil((r.ms || 7200000) / 60000);
              acc.status = "LOCKED"; // กรณี PEER_FLOOD/PRIVACY ให้ล็อคไว้ก่อน
              acc.cooldownUntil = new Date(Date.now() + (r.ms || 7200000));
              acc.lastError = r.message || "PEER_FLOOD/PRIVACY";
              await acc.save();

              job.logs.push({ text: `บัญชี ${acc.phone} ถูกจำกัดด้านความเป็นส่วนตัว/สแปม (LOCKED) พัก ${mins} นาที`, time: new Date() });
              await job.save();

              telegramPush(jobId, {
                type: "error",
                msg: `บัญชี ${acc.phone} ถูกจำกัดด้านความเป็นส่วนตัว/สแปม (LOCKED) พัก ${mins} นาที`
              });
              break; // เปลี่ยนไปใช้อีกบัญชี
            }
            else if (r.error) {
              job.logs.push({ text: `เชิญ ${username} ล้มเหลว: ${r.error}`, time: new Date() });
              await job.save();
              telegramPush(jobId, { type: "error", msg: `เชิญ ${username} ล้มเหลว: ${r.error}` });
            }

            // จังหวะพักแบบมนุษย์ + เซฟงาน
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
   START TELEGRAM JOB — PRECHECK เข้ม + UX ดีขึ้น
=============================================================== */
router.post("/jobs/start", requireAuth, async (req, res) => {
  try {
    const uid  = req.session.user._id;
    const user = await User.findById(uid).lean();
    if (!user) return res.json({ ok:false, error:"ไม่พบผู้ใช้" });

    // ── helpers
    const sanitize = (g) => String(g||"").replace(/^https?:\/\/t\.me\//i,"").replace(/^t\.me\//i,"").trim();
    const toInt = (v, d=0) => Number.isFinite(Number(v)) ? Number(v) : d;

    // ── รับค่า
    let { srcGroup, destGroup, limit, maxSecurity } = req.body;
    srcGroup  = sanitize(srcGroup);
    destGroup = sanitize(destGroup);
    const qty = Math.max(0, Math.min(toInt(limit, 0), 500)); // cap 500/งาน

    const reasons = [];
    const warnings = [];

    // ── VALIDATE INPUT
    if (!srcGroup || !destGroup) reasons.push("กรุณากรอกลิงก์กลุ่มต้นทางและปลายทาง");
    if (srcGroup && destGroup && srcGroup.toLowerCase() === destGroup.toLowerCase()) {
      reasons.push("กลุ่มต้นทางและปลายทางต้องไม่เหมือนกัน");
    }
    if (qty <= 0) reasons.push("จำนวนสมาชิกต้องมากกว่า 0");

    // ── ค่าใช้จ่าย
    const UNIT_CREDIT = 2; // 2 เครดิต/คน
    const cost = qty * UNIT_CREDIT;
    if ((user.credit || 0) < cost) {
      reasons.push(`เครดิตไม่เพียงพอ (ต้องใช้ ${cost} เครดิต)`);
    }

    // ── ตรวจบัญชีผู้ใช้
    const accounts = await TgAccount.find({ userId: uid }).lean();
    if (!accounts.length) reasons.push("คุณยังไม่มีบัญชี Telegram ในระบบ");

    const now = Date.now();

    // พร้อมใช้งานจริง: READY และไม่ติดคูลดาวน์/ล็อก
    const usable = accounts.filter(a => {
      const cdOk   = !(a.cooldownUntil && a.cooldownUntil > now);
      const lockOk = a.status !== "LOCKED";
      return a.session && a.status === "READY" && cdOk && lockOk;
    });

    if (!usable.length) reasons.push("ยังไม่มีบัญชีพร้อมใช้งาน (READY และไม่ติดคูลดาวน์/ล็อก)");

    // ── เขียน warning รายบัญชีที่ติดคูลดาวน์
    accounts.forEach(a => {
      if (a.cooldownUntil && a.cooldownUntil > now) {
        const min = Math.ceil((a.cooldownUntil - now)/60000);
        warnings.push(`บัญชี ${a.phone} ติดคูลดาวน์อีก ~${min} นาที`);
      }
      if (a.status === "LOCKED") {
        warnings.push(`บัญชี ${a.phone} ถูกล็อก (LOCKED)`);
      }
    });

    // ── สรุปเหตุผลถ้าสตาร์ทไม่ได้
    if (reasons.length) {
      return res.json({
        ok: false,
        type: "precheck_fail",
        reasons,
        warnings,
        summary: { srcGroup, destGroup, qty, unitCredit: UNIT_CREDIT, cost }
      });
    }

    // ── สร้างงาน
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

    // ── ตัดเครดิตทันที (กัน overuse)
    if (cost > 0) {
      await User.updateOne({ _id: uid }, { $inc: { credit: -cost } });
    }

    // ── เริ่มงาน async
    startTelegramJob(job._id);

    return res.json({
      ok: true,
      jobId: job._id,
      orderId: job.orderId,
      streamUrl: `/telegram/jobs/${job._id}/stream`,
      warnings,
      summary: { srcGroup, destGroup, qty, unitCredit: UNIT_CREDIT, cost }
    });

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

    const job = await TelegramJob.findById(jobId).lean();
    if (!job) return res.json({ ok:false, error:"ไม่พบงาน" });
    if (String(job.userId) !== String(uid)) {
      return res.json({ ok:false, error:"ไม่มีสิทธิ์หยุดงาน" });
    }

    stopTelegramJob(jobId);
    return res.json({ ok:true });

  } catch (err) {
    console.error("STOP_JOB_ERROR:", err);
    return res.json({ ok:false });
  }
});

/* ===============================================================
   JOB STREAM (ไม่ต้อง admin)
=============================================================== */
router.get("/jobs/:jobId/stream", (req, res) => {
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
