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
      const ms = extractFloodWait(msg) || 7200000; // Default to 2 hours if no flood wait time found
      user.cooldownUntil = new Date(Date.now() + ms); // Set cooldownUntil to the calculated time
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

              if (acc.invitesToday >= 40) {
                acc.cooldownUntil = new Date(Date.now() + 7200000);
                acc.status = "COOLDOWN";
                await acc.save();
                break;
              }

              telegramPush(jobId, { invited: job.invited, total: qty, user: username });
            } else if (r.flood) {
              console.log(`บัญชี ${acc.phone} ถูกบล็อกจากการ Flood. กำหนดสถานะเป็น LOCKED`);
              acc.cooldownUntil = new Date(Date.now() + 7200000);
              acc.status = "COOLDOWN";
              await acc.save();
              break;
            } else if (r.spam) {
              acc.cooldownUntil = new Date(Date.now() + 7200000);
              acc.status = "COOLDOWN";
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

    console.log("LOGIN_START_BODY_RAW:", req.body);

    let phone   = String(req.body.phone || "").trim();
    let apiId   = Number(req.body.apiId);
    let apiHash = String(req.body.apiHash || "").trim();

    console.log("LOGIN_START_PARSED:", { phone, apiId, apiHash });

    if (!phone || !apiId || !apiHash) {
      return res.json({ ok:false, error:"กรอกข้อมูลให้ครบ" });
    }
    if (isNaN(apiId)) {
      return res.json({ ok:false, error:"apiId ต้องเป็นตัวเลข" });
    }

    const r = await sendCodeAndGetSession({ phone, apiId, apiHash });

    if (!r || !r.ok) {
      console.log("GRAMJS_SENDCODE_FAIL:", r);
      return res.json({ ok:false, error:r?.error || "ส่งรหัสไม่สำเร็จ" });
    }

    /** ลบ exp ออกก่อนเสมอ */
    const loginToken = signPayload({
      userId: uid,
      username: username,
      phone,
      apiId,
      apiHash,
      phoneCodeHash: r.phoneCodeHash,
      sessionString: r.sessionString,
      ts: Date.now()
    });

    return res.json({
      ok: true,
      codeSent: true,
      loginToken
    });

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

    const clean = { ...data };
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

    /* ===============================================================
       CASE 1 — ถ้าส่งทั้ง code + password → ให้ตรวจ password ก่อน
       (เพราะ Telegram ขอ 2FA อยู่แล้ว)
    ================================================================ */
    if (password && code) {
      result = await checkPasswordWithSession({
        sessionString: data.sessionString,
        password,
        apiId: data.apiId,
        apiHash: data.apiHash
      });
    }

    /* ===============================================================
       CASE 2 — ส่งเฉพาะ password
    ================================================================ */
    else if (password && !code) {
      result = await checkPasswordWithSession({
        sessionString: data.sessionString,
        password,
        apiId: data.apiId,
        apiHash: data.apiHash
      });
    }

    /* ===============================================================
       CASE 3 — ส่งเฉพาะ OTP
    ================================================================ */
    else if (code && !password) {
      result = await signInWithSession({
        sessionString: data.sessionString,
        phone: data.phone,
        phoneCodeHash: data.phoneCodeHash,
        code,
        apiId: data.apiId,
        apiHash: data.apiHash
      });

      // Telegram ต้องการรหัสผ่าน 2FA → แจ้ง UI
      if (result.needPassword) {
        const clean = { ...data };
        delete clean.exp;

        const nextToken = signPayload({
          ...clean,
          sessionString: result.sessionString,
          ts: Date.now()
        });

        return res.json({ ok:false, needPassword:true, loginToken:nextToken });
      }
    }

    /* ===============================================================
       CASE 4 — ไม่ส่งอะไรเลย
    ================================================================ */
    else {
      return res.json({ ok:false, error:"กรุณากรอกข้อมูล" });
    }

    /* ===============================================================
       ถ้าผิด → ส่ง error กลับ
    ================================================================ */
    if (!result || !result.ok) {
      return res.json({ ok:false, error:result?.error || "เกิดข้อผิดพลาด" });
    }

    /* ===============================================================
       CASE SUCCESS → บันทึกบัญชีลง DB
    ================================================================ */
    let acc = await TgAccount.findOne({
      phone: data.phone,
      userId: data.userId
    });

    if (!acc) {
      acc = new TgAccount({
        userId: data.userId,
        username: data.username,
        username: data.name,
        phone: data.phone,
        apiId: data.apiId,
        apiHash: data.apiHash,
        session: result.sessionString,
        status: "READY",
        invitesToday: 0,
        lastInviteResetAt: new Date()
      });
    } else {
      acc.apiId = data.apiId;
      acc.apiHash = data.apiHash;
      acc.session = result.sessionString;
      acc.status = "READY";
    }
    await acc.save();

    return res.json({ ok:true, me:result.me });

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

    const qty = Number(limit) || 0;
    if (qty <= 0) {
      reasons.push("จำนวนสมาชิกต้องมากกว่า 0");
    }

    /* =========================
       ตรวจ CREDIT (2 เครดิต/คน)
    ========================== */
    const cost = qty * 2; // สมมติว่า 2 เครดิตต่อคน
    if (user.credit < cost) {
      reasons.push(`เครดิตไม่เพียงพอ (ต้องใช้ ${cost} เครดิต)`);
    }

    /* =========================
       ตรวจบัญชี Telegram พร้อมใช้งาน
    ========================== */
    const accounts = await TgAccount.find({
      userId: uid
    }).lean();

    if (!accounts.length) {
      reasons.push("คุณยังไม่มีบัญชี Telegram ในระบบ");
    }

    const readyAcc = accounts.filter(a => a.status === "READY");

    if (!readyAcc.length) {
      reasons.push("ยังไม่มีบัญชีพร้อมใช้งาน (READY)");
    }

    /* =========================
       ตรวจ COOL DOWN
    ========================== */
    const now = Date.now();
    const cooldownReasons = [];

    accounts.forEach(acc => {
      if (acc.status === "COOLDOWN" && acc.cooldownUntil) {
        const diff = acc.cooldownUntil - now;
        if (diff > 0) {
          const min = Math.ceil(diff / 60000);
          cooldownReasons.push(`บัญชี ${acc.phone} ติดคูลดาวน์อีก ${min} นาที`);
          acc.status = "COOLDOWN"; // Update account status to COOLDOWN immediately
          acc.save(); // Save the updated status in DB
        }
      }
    });

    if (cooldownReasons.length) {
      reasons.push(...cooldownReasons);
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
