// route/telegram.js
import { Router } from "express";
import multer from "multer";
import { parse as csvParse } from "csv-parse/sync";
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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// HELPERS
// Track jobs
const running = new Set();
const stopRequested = new Set();
const PRICE_PER_PERSON = 0;
const MAX_LIMIT_PER_JOB = 1000;
const PEER_FLOOD_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_PHONES = 10000;

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

function normalizeUsername(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;

  // รองรับลิงก์ t.me/xxxx หรือ https://t.me/xxxx
  s = s.replace(/^https?:\/\/t\.me\//i, "")
       .replace(/^t\.me\//i, "")
       .trim();

  if (s.startsWith("@")) s = s.slice(1);

  // username TG ทั่วไป 5-32, a-z0-9_
  // (บางเคสมีจุด แต่ไม่ชัวร์ทุกระบบ ให้เคร่งไว้ก่อน)
  s = s.toLowerCase();
  if (!/^[a-z0-9_]{5,32}$/.test(s)) {
    return { ok:false, value: s, reason:"รูปแบบ @username ไม่ถูกต้อง (ควรเป็น a-z 0-9 _ ยาว 5-32)" };
  }
  return { ok:true, value: "@" + s };
}

function normalizePhone(raw){
  let s = String(raw || "").trim();
  if (!s) return null;

  // เก็บเฉพาะ + และตัวเลข
  s = s.replace(/[^\d+]/g, "");

  if (!s.startsWith("+")) {
    return { ok:false, value:s, reason:"เบอร์ต้องขึ้นต้นด้วย + (E.164) เช่น +6680xxxxxxx" };
  }

  // E.164 ปกติยาว 8-15 ตัว (ไม่รวม +)
  if (!/^\+\d{8,15}$/.test(s)) {
    return { ok:false, value:s, reason:"รูปแบบเบอร์ไม่ถูกต้อง (ควรเป็น + ตามด้วยตัวเลข 8-15 หลัก)" };
  }

  return { ok:true, value:s };
}

function normalizeTarget(raw) {
  const t = String(raw || "").trim();
  if (!t) return null;

  // ถ้าดูเหมือนเบอร์ (+...) ให้ลองเป็น phone ก่อน
  if (t.startsWith("+")) {
    const r = normalizePhone(t);
    if (r?.ok) return { ok:true, kind:"phone", value:r.value };
    return { ok:false, input:t, reason:r?.reason || "เบอร์ไม่ถูกต้อง" };
  }

  // ถ้าขึ้นต้น @ หรือเป็น t.me/ ให้เป็น username
  if (t.startsWith("@") || /^https?:\/\/t\.me\//i.test(t) || /^t\.me\//i.test(t)) {
    const r = normalizeUsername(t);
    if (r?.ok) return { ok:true, kind:"username", value:r.value };
    return { ok:false, input:t, reason:r?.reason || "username ไม่ถูกต้อง" };
  }

  // ถ้าเป็นตัวเลขล้วน/มีขีดวงเล็บ แต่ไม่มี + → ถือว่าเบอร์ผิดฟอร์แมต
  if (/^[\d()\s-]+$/.test(t)) {
    return { ok:false, input:t, reason:"เบอร์ต้องขึ้นต้นด้วย + (E.164) เช่น +6680xxxxxxx" };
  }

  // อย่างอื่นลองตีเป็น username แบบไม่มี @
  const r = normalizeUsername(t);
  if (r?.ok) return { ok:true, kind:"username", value:r.value };
  return { ok:false, input:t, reason:r?.reason || "ไม่รู้จักรูปแบบข้อมูล" };
}

function extractFromText(text) {
  // รองรับ newline, comma, semicolon, tab
  return String(text || "")
    .split(/[\n,;\t\r]+/g)
    .map(x => x.trim())
    .filter(Boolean);
}

function sanitize(g) {
  if (!g) return g;
  return g.replace("https://t.me/", "").replace("t.me/", "").trim();
}

function extractTgCode(err) {
  const s = String(err?.message || err || "");
  // ตัวอย่าง: "FLOOD_WAIT_123" หรือ "USER_NOT_MUTUAL_CONTACT"
  const m = s.match(/[A-Z_]{3,}/g);
  // เอาตัวท้ายๆที่มักเป็น code จริง
  const code = m ? m[m.length - 1] : "";
  return code || "";
}

function extractTgCodeFromAnything(errOrCode) {
  const s = String(errOrCode?.errorMessage || errOrCode?.message || errOrCode || "").toUpperCase();

  // จับ FLOOD_WAIT_123 ก่อน
  const fw = s.match(/FLOOD_WAIT_(\d+)/);
  if (fw) return `FLOOD_WAIT_${fw[1]}`;

  // เอา code ตัวท้ายๆ ที่เป็น A-Z_
  const m = s.match(/[A-Z_]{3,}/g);
  return m ? m[m.length - 1] : "";
}

function translateTgErrorCode(errOrCode) {
  const code = extractTgCodeFromAnything(errOrCode);

  const map = {
    USER_CHANNELS_TOO_MUCH: "ผู้ใช้นี้เข้าร่วมกลุ่ม/ช่องเยอะเกินลิมิตแล้ว (ต้องให้ออกจากบางกลุ่มก่อน)",
    USER_NOT_MUTUAL_CONTACT: "ผู้ใช้นี้ไม่ได้เป็น Mutual Contact (ต้องให้เขาเพิ่มเรา/เคยคุยกันก่อน หรือเปิดให้คนอื่นเชิญได้)",
    USER_PRIVACY_RESTRICTED: "ผู้ใช้นี้ตั้งค่าความเป็นส่วนตัว ไม่อนุญาตให้ถูกเพิ่มเข้ากลุ่ม",
    CHAT_ADMIN_REQUIRED: "ต้องเป็นแอดมิน/มีสิทธิ์เชิญสมาชิกในกลุ่มปลายทางก่อน",
    INVITE_REQUEST_SENT: "ส่งคำขอเข้ากลุ่มแล้ว (กลุ่มปลายทางต้องอนุมัติ)",
    USER_ALREADY_PARTICIPANT: "ผู้ใช้นี้อยู่ในกลุ่มปลายทางอยู่แล้ว",
    USER_BANNED_IN_CHANNEL: "ผู้ใช้นี้ถูกแบนในกลุ่ม/ช่องปลายทาง",
    PEER_FLOOD: "บัญชีผู้เชิญโดนจำกัดชั่วคราว (เชิญถี่เกินไป) → ควรพักบัญชี/สลับบัญชี",
  };

  if (!code) return { code: "", th: "เกิดข้อผิดพลาดไม่ทราบสาเหตุ" };

  if (code.startsWith("FLOOD_WAIT_")) {
    const sec = Number(code.split("_").pop()) || 0;
    const mins = sec ? Math.ceil(sec / 60) : 0;
    return { code, th: mins ? `ติด FloodWait ต้องรอประมาณ ${mins} นาที` : "ติด FloodWait ต้องรอ" };
  }

  return { code, th: map[code] || `ข้อผิดพลาด: ${code}` };
}

function formatInviteFail(name, errOrCode) {
  const tr = translateTgErrorCode(errOrCode);
  return `❌ เชิญ ${name} ไม่สำเร็จ: ${tr.th}${tr.code ? ` (${tr.code})` : ""}`;
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

async function finalizeEarly(job, jobId, qty, reasonText, status = "stopped") {
  job.status = status; // "stopped" | "auto_stopped"
  job.logs.push({ text: `⛔ จบงานอัตโนมัติ: ${reasonText}`, time: new Date() });
  await job.save();

  telegramPush(jobId, {
    status: job.status,
    invited: job.invited,
    total: qty,
    log: `⛔ จบงานอัตโนมัติ: ${reasonText}`
  });

  const miss = Math.max(0, Number(qty) - Number(job.invited || 0));
  if (miss > 0) {
    const refund = miss * PRICE_PER_PERSON;
    if (refund > 0) {
      await User.updateOne({ _id: job.userId }, { $inc: { credit: refund } });
    }
    telegramPush(jobId, { refund, log: `คืนเครดิต ${refund} เครดิต (ขาด ${miss} คน)` });
  }
}

function parseTgGroupRef(raw) {
  let s = String(raw || "").trim();
  
  if (!s || s === "__FILE_IMPORT__") return null;

  // remove prefix
  s = s.replace(/^https?:\/\/t\.me\//i, "")
       .replace(/^t\.me\//i, "")
       .replace(/^@/g, "")
       .trim();

  // strip query
  s = s.split("?")[0].trim();
  if (!s) return null;

  // invite link forms
  if (s.startsWith("+")) return { type: "invite", hash: s.slice(1) };
  if (s.toLowerCase().startsWith("joinchat/")) return { type: "invite", hash: s.slice("joinchat/".length) };

  // public username
  return { type: "public", username: s };
}

function errMsg(err) {
  return String(err?.errorMessage || err?.message || err || "");
}

// Ensure join (join ไม่คิดเป็น invite)
async function ensureJoin(client, group) {
  const ref = parseTgGroupRef(group);
  if (!ref) throw new Error("EMPTY_GROUP");

  try {
    if (ref.type === "invite") {
      await client.invoke(new Api.messages.ImportChatInvite({ hash: ref.hash }));
      return;
    }

    // ✅ ต้องแปลงเป็น InputEntity ก่อน
    const input = await client.getInputEntity(ref.username);
    await client.invoke(new Api.channels.JoinChannel({ channel: input }));
  } catch (err) {
    const msg = errMsg(err).toUpperCase();

    // ✅ ignore already joined
    if (msg.includes("USER_ALREADY_PARTICIPANT") || msg.includes("ALREADY")) return;

    // ✅ ลิงก์/สิทธิ์
    if (msg.includes("INVITE_HASH_INVALID")) return;
    if (msg.includes("CHANNEL_PRIVATE") || msg.includes("CHAT_WRITE_FORBIDDEN")) return;

    console.log("[ensureJoin]", msg);
  }
}

// Resolve group/channel entity
async function resolveEntity(client, group) {
  const ref = parseTgGroupRef(group);
  if (!ref) return null;

  for (let i = 0; i < 3; i++) {
    try {
      // public username
      if (ref.type === "public") {
        return await client.getInputEntity(ref.username);
      }

      // =========================
      // invite hash (+xxxx / joinchat/xxxx)
      // =========================

      // 1) ถ้า "เข้ากลุ่มแล้ว" -> CheckChatInvite จะได้ chat มา (ChatInviteAlready)
      const chk = await client
        .invoke(new Api.messages.CheckChatInvite({ hash: ref.hash }))
        .catch(() => null);

      if (chk?.chat) {
        return await client.getInputEntity(chk.chat);
      }

      // 2) ยังไม่เข้า -> ImportChatInvite เพื่อ join แล้วเอา chats[0]
      const up = await client.invoke(new Api.messages.ImportChatInvite({ hash: ref.hash }));
      const chat = up?.chats?.[0];
      if (chat) return await client.getInputEntity(chat);

      // 3) fallback: import แล้วเช็คอีกที เผื่อ API ไม่ส่ง chats กลับมา
      const chk2 = await client
        .invoke(new Api.messages.CheckChatInvite({ hash: ref.hash }))
        .catch(() => null);

      if (chk2?.chat) return await client.getInputEntity(chk2.chat);

      return null;

    } catch (e) {
      const msg = errMsg(e).toUpperCase();

      // เคสที่ควร "เลิกพยายาม" เลย
      if (msg.includes("INVITE_HASH_INVALID") || msg.includes("INVITE_HASH_EXPIRED")) return null;
      if (msg.includes("CHANNEL_PRIVATE") || msg.includes("CHAT_WRITE_FORBIDDEN")) return null;

      // เคส already participant: ไปเช็คเอา chat จาก CheckChatInvite อีกรอบ
      if (msg.includes("USER_ALREADY_PARTICIPANT") || msg.includes("ALREADY")) {
        const chk = await client
          .invoke(new Api.messages.CheckChatInvite({ hash: ref.hash }))
          .catch(() => null);
        if (chk?.chat) return await client.getInputEntity(chk.chat);
      }

      // best-effort join แล้วลองใหม่
      await ensureJoin(client, group).catch(() => {});
      await sleep(800 + i * 300);
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

function isInputPeerChat(x){
  return x && (x.className === "InputPeerChat" || x.SUBCLASS_OF_ID === 0x6b8d3d5f); // กันพลาด
}

function toInputUser(peerUser){
  // peerUser มักเป็น InputPeerUser
  if (!peerUser) return null;
  if (peerUser.className === "InputUser") return peerUser;
  if (peerUser.className === "InputPeerUser") {
    return new Api.InputUser({ userId: peerUser.userId, accessHash: peerUser.accessHash });
  }
  return null;
}

function pushJobLog(job, jobId, text, { persist = true } = {}) {
  const line = { text, time: new Date() };

  // กัน log บวม (MongoDB doc 16MB)
  if (persist && Array.isArray(job.logs) && job.logs.length < 3000) {
    job.logs.push(line);
  }

  telegramPush(jobId, { log: text, invited: job.invited, total: Number(job.limit || 0) });
}

// Invite Member (รองรับ Channel ด้วย)
async function inviteOne(client, dstEntity, user) {
  try {
    const peerUser = await client.getInputEntity(user);
    const inputUser = toInputUser(peerUser);

    if (isInputPeerChat(dstEntity)) {
      if (!inputUser) return { error: "INPUT_USER_RESOLVE_FAIL" };
      await client.invoke(new Api.messages.AddChatUser({
        chatId: dstEntity.chatId,
        userId: inputUser,
        fwdLimit: 0
      }));
      return { ok: true };
    }

    await client.invoke(new Api.channels.InviteToChannel({
      channel: dstEntity,
      users: [peerUser]
    }));
    return { ok: true };

  } catch (err) {
    const msg = String(err?.errorMessage || err?.message || err || "").toUpperCase();

    // ✅ อยู่ในกลุ่มอยู่แล้ว
    if (
      msg.includes("USER_ALREADY_PARTICIPANT") ||
      msg.includes("USER_ALREADY_MEMBER") ||
      msg.includes("USER_ALREADY_IN_CHAT")
    ) {
      return { already: true, message: msg };
    }

    if (msg.includes("FLOOD_WAIT")) {
      const ms = extractFloodWait(msg) || 2 * 60 * 60 * 1000;
      return { flood: true, waitMs: ms, message: msg };
    }
    if (msg.includes("PEER_FLOOD")) return { peerFlood: true, message: msg };
    if (msg.includes("USER_PRIVACY_RESTRICTED") || msg.includes("PRIVACY")) return { privacy: true, message: msg };

    if (msg.includes("CHAT_ADMIN_REQUIRED") || msg.includes("CHAT_ADMINISTRATOR_REQUIRED")) {
      return { adminRequired: true, message: msg };
    }

    return { error: msg };
  }
}

function phoneForImport(phoneE164) {
  return String(phoneE164 || "")
    .replace(/[^\d+]/g, "")
    .replace(/^\+/, "");
}

async function resolveUserByUsername(client, atUsername) {
  const u = String(atUsername || "").trim();
  const key = u.startsWith("@") ? u.slice(1) : u;
  return await client.getEntity(key); // user entity
}

async function resolveUserByPhone(client, phoneE164) {
  const phone = phoneForImport(phoneE164);
  if (!phone) return null;

  const res = await client.invoke(
    new Api.contacts.ImportContacts({
      contacts: [
        new Api.InputPhoneContact({
          clientId: BigInt(Date.now()), // พอ
          phone,
          firstName: "RTSMM",
          lastName: "Target",
        }),
      ],
    })
  );

  const users = res?.users || [];
  if (!users.length) return null;

  const u = users[0];

  // 🔥 ลบ contact ออกทันที (กัน list บวม)
  try {
    const input = await client.getInputEntity(u);
    await client.invoke(new Api.contacts.DeleteContacts({ id: [input] }));
  } catch (_) {
    // best-effort: บางเคสลบไม่ได้ก็ช่างมัน แต่พยายามแล้ว
  }

  return u;
}

async function resolveTargetUser(client, target) {
  if (!target) return { ok: false, reason: "empty target" };

  const kind = target.kind;
  const value = target.value;

  try {
    if (kind === "username") {
      const ent = await resolveUserByUsername(client, value);
      return ent ? { ok: true, user: ent } : { ok: false, reason: "username not found" };
    }
    if (kind === "phone") {
      const ent = await resolveUserByPhone(client, value);
      return ent ? { ok: true, user: ent } : { ok: false, reason: "phone not found / cannot import" };
    }
    return { ok: false, reason: "unknown kind" };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

// ===============================
// Risk scoring (ยิ่งน้อยยิ่งปลอดภัย)
// ===============================
function riskScore(acc, nowMs) {
  const ROUND_LIMIT = 50;

  let score = 0;
  const invitesToday = Number(acc.invitesToday || 0);
  const usedInRound = invitesToday % ROUND_LIMIT;

  // 1) ใช้งานเยอะ = เสี่ยงขึ้น
  score += invitesToday * 1;

  // 2) ใกล้ชนโควต้าในรอบ (ปลายรอบเสี่ยงกว่า)
  if (usedInRound >= 40) score += 25;
  else if (usedInRound >= 30) score += 15;
  else if (usedInRound >= 20) score += 8;

  // 3) ประวัติ error
  const e = String(acc.lastError || "").toUpperCase();
  if (e.includes("PEER_FLOOD")) score += 120;
  else if (e.includes("FLOOD_WAIT")) score += 80;
  else if (e.includes("PHONE_NUMBER_BANNED") || e.includes("AUTH_KEY_UNREGISTERED")) score += 200;
  else if (e) score += 10;

  // 4) ติดคูลดาวน์จริง ๆ = ห้ามใช้ (บวกหนักให้หล่นไปท้าย/หรือกรองทิ้ง)
  const until = acc.cooldownUntil ? new Date(acc.cooldownUntil).getTime() : 0;
  if (until && until > nowMs) score += 9999;

  // 5) LOCKED = ห้ามใช้
  if (String(acc.status || "").toUpperCase() === "LOCKED") score += 99999;

  return score;
}

// Dynamic invite limit based on account status and risk
function quota(acc, remain) {
  const ROUND_LIMIT = 50;

  const total = Number(acc.invitesToday || 0);
  const usedInRound = total % ROUND_LIMIT;          // 0..49
  const leftInRound = ROUND_LIMIT - usedInRound;    // 50..1

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

// ===============================
// Pick accounts: READY ก่อนเสมอ + เรียงตาม risk
// ===============================
async function pickAccounts(userId, opts = {}) {
  const { maxSecurity = false } = opts;

  if (!userId) return [];
  const now = Date.now();

  // ✅ ปลด COOLDOWN ที่หมดเวลา -> READY (กันค้าง)
  await TgAccount.updateMany(
    {
      userId,
      status: "COOLDOWN",
      cooldownUntil: { $ne: null, $lte: new Date(now) }
    },
    { $set: { status: "READY", cooldownUntil: null } }
  );

  // ✅ ดึงเฉพาะบัญชีที่ "ใช้ได้จริง" (มี session, ไม่ LOCKED, ไม่ติดคูลดาวน์)
  const list = await TgAccount.find({
    userId,
    session: { $nin: [null, ""] },
    status: { $ne: "LOCKED" },
    $or: [{ cooldownUntil: null }, { cooldownUntil: { $lte: new Date(now) } }]
  })
    .select("name phone status invitesToday lastError cooldownUntil createdAt apiId apiHash session")
    .exec();

  // ✅ เรียง: risk ต่ำก่อน (READY จะได้คะแนนต่ำกว่าพวก cooldown อยู่แล้ว)
  const ranked = list
    .map(acc => ({ acc, r: riskScore(acc, now) }))
    .sort((a, b) =>
      a.r - b.r ||
      Number(a.acc.invitesToday || 0) - Number(b.acc.invitesToday || 0) ||
      new Date(a.acc.createdAt || 0) - new Date(b.acc.createdAt || 0)
    );

  let out = ranked.map(x => x.acc);

  // 🔒 โหมด “ปลอดภัยสุด” — ตัดบัญชีที่ risk สูงเกิน (ปรับ threshold ได้)
  if (maxSecurity) {
    out = out.filter(acc => riskScore(acc, now) <= 45);
  }

  return out;
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

    const ROUND_LIMIT = 50;
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

      // ✅ “ต่อรอบ” = ดูยอดในรอบจาก mod 50
      const total = Number(acc.invitesToday || 0);
      const usedInRound = total % ROUND_LIMIT;

      // ✅ กันหลุด: ถ้าครบ 40/80/120 แล้วแต่ยังไม่ถูกตั้ง cooldown (เช่น crash ก่อน save)
      if (total > 0 && usedInRound === 0 && !acc.cooldownUntil) {
        acc.status = "COOLDOWN";
        acc.cooldownUntil = new Date(now + COOLDOWN_MS);
        await acc.save();
        reasons.push(`บัญชี ${acc.phone} ครบโควต้ารอบละ ${ROUND_LIMIT} แล้ว`);
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
    let listIndex = 0;
    let listProcessed = 0;
    let listAlready = 0;

    while (remaining > 0) {
      if (stopRequested.has(String(jobId))) return;
      // ✅ หมุนเฉพาะบัญชีของ user นี้
      const accounts = await pickAccounts(uid, { maxSecurity: !!job.maxSecurity });
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

          // join เฉพาะที่ต้องใช้
          if ((job.mode || "group") === "group") {
            await ensureJoin(client, job.srcGroup);
          }
          await ensureJoin(client, job.destGroup);

          const dst = await resolveEntity(client, job.destGroup);
          if (!dst) throw new Error("resolveEntity(dest) failed");

          let doneThisAcc = 0; // ✅ ใช้ q จริง: บัญชีนี้ทำได้สูงสุด q คน

          // =========================================================
          // MODE: GROUP (ดึงจาก srcGroup)
          // =========================================================
          if ((job.mode || "group") === "group") {
            const src = await resolveEntity(client, job.srcGroup);
            if (!src) throw new Error("resolveEntity(src) failed");

            const me = await client.getMe();

            // ดึงเท่าที่จำเป็น (ไม่ลาก 2000 ตลอด)
            const want = Math.min(2000, Math.max(250, q * 12));
            let members = [];

            try {
              members = await fetchSrcMembers(client, src, me.id, jobId, want);
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

                job.logs.push({ text: `🛑 AUTO STOP: ${reason}`, time: new Date() });
                await job.save();

                await finalizeAutoStop(job, jobId, qty, reason);
                return;
              }

              throw err;
            }

            let batchChecked = 0;
            let batchAlready = 0;
            let batchSkipped = 0;
            let batchInvited = 0;

            for (const user of members) {
              if (stopRequested.has(String(jobId))) return;
              if (remaining <= 0) break;
              if (doneThisAcc >= q) break;

              const username = user.username || user.firstName || ("user_" + user.id);

              const exists = await TgInviteLog.findOne({
                destGroup: job.destGroup,
                tgUserId: user.id
              }).lean();

              if (exists) {
                batchChecked++;
                batchSkipped++;
                batchAlready++;
                // pushJobLog(job, jobId, `👥 ${username} อยู่ในกลุ่มแล้ว (เคยเชิญแล้ว)`, { persist: true });
                continue;
              }

              const r = await inviteOne(client, dst, user);
              batchChecked++;
              
              if (r.ok) {
                batchInvited++;

                await TgInviteLog.create({
                  jobId: job._id,
                  accountId: acc._id,
                  tgUserId: user.id,
                  tgUserName: username,
                  srcGroup: job.srcGroup,
                  destGroup: job.destGroup
                });

                pushJobLog(job, jobId, `✅ เชิญ ${username} สำเร็จ`, { persist: true });

                job.invited++;
                remaining--;
                doneThisAcc++;
                acc.invitesToday++;

                telegramPush(jobId, { invited: job.invited, total: qty, user: username });

                if (acc.invitesToday % ROUND_LIMIT === 0) {
                  acc.cooldownUntil = new Date(Date.now() + COOLDOWN_MS);
                  acc.status = "COOLDOWN";
                  await acc.save();

                  if (remaining > 0) {
                    const left = await pickAccounts(uid);
                    if (!left.length) {
                      await finalizeEarly(job, jobId, qty, `บัญชีครบโควต้า ${ROUND_LIMIT}คน/รอบ และไม่มีบัญชีสำรอง`);
                      return;
                    }
                  }
                  break; // เปลี่ยนบัญชี
                }

              } else if (r.already) {
                batchAlready++;
                // pushJobLog(job, jobId, `👥 ${username} อยู่ในกลุ่มแล้ว`, { persist: true });
                // ไม่ลด remaining ไม่เพิ่ม failed
                continue;

              } else if (r.privacy) {
                job.failed++;
                const msg = formatInviteFail(username, r.error || "unknown error");
                job.logs.push({ text: msg, time: new Date() });
                telegramPush(jobId, { invited: job.invited, total: qty, log: msg });
                continue;

              } else if (r.flood) {
                const waitMs = Math.max(60_000, Number(r.waitMs || COOLDOWN_MS));
                const mins = Math.ceil(waitMs / 60000);

                acc.cooldownUntil = new Date(Date.now() + waitMs);
                acc.status = "COOLDOWN";
                acc.lastError = `FLOOD_WAIT (${mins} นาที)`;
                await acc.save();

                if (remaining > 0) {
                  const left = await pickAccounts(uid);
                  if (!left.length) {
                    await finalizeEarly(job, jobId, qty,
                      `Telegram จำกัดการเชิญชั่วคราว — พักบัญชีประมาณ ${mins} นาที แล้วค่อยลองใหม่`
                    );
                    return;
                  }
                }
                break;

              } else if (r.peerFlood) {
                const hrs = Math.ceil(PEER_FLOOD_COOLDOWN_MS / 3600000);

                acc.cooldownUntil = new Date(Date.now() + PEER_FLOOD_COOLDOWN_MS);
                acc.status = "COOLDOWN";
                acc.lastError = `PEER_FLOOD (${hrs} ชม.)`;
                await acc.save();

                if (remaining > 0) {
                  const left = await pickAccounts(uid);
                  if (!left.length) {
                    await finalizeEarly(job, jobId, qty,
                      `Telegram จำกัดการเชิญ (PEER_FLOOD) — พักบัญชี ${hrs} ชม. แล้วค่อยลองใหม่`
                    );
                    return;
                  }
                }
                break;

              } else {
                job.failed++;
                const msg = formatInviteFail(username, r.error || "unknown error");
                job.logs.push({ text: msg, time: new Date() });
                telegramPush(jobId, { invited: job.invited, total: qty, log: msg });
                continue;
              }

              await sleep(humanDelay());
              await job.save();
            }

            // ✅ ถ้าไล่ครบ batch แล้ว “ไม่มีใครเชิญได้เลย” และที่เจอทั้งหมดคือ already/skip → จบงานได้
            if (remaining > 0 && batchChecked > 0 && batchInvited === 0 && (batchAlready + batchSkipped) >= batchChecked) {
              await job.save();
              await finalizeEarly(job, jobId, qty, "สมาชิกที่ตรวจเจอทั้งหมดอยู่ในกลุ่มปลายทางอยู่แล้ว", "finished");
              return;
            }
          }

          // =========================================================
          // MODE: LIST (ไล่จาก job.targets)
          // =========================================================
          else {
            const targets = Array.isArray(job.targets) ? job.targets : [];

            while (remaining > 0 && doneThisAcc < q && listIndex < targets.length) {
              if (stopRequested.has(String(jobId))) return;

              const t = targets[listIndex++];
              const label = t?.value || "-";

              // ✅ ต้องมีฟังก์ชัน resolveTargetUser() ตามที่ส่งให้ก่อนหน้า
              const rr = await resolveTargetUser(client, t);
              if (!rr.ok) {
                job.failed++;
                const reasonRaw = rr.reason || "RESOLVE_FAIL";
                const tr = translateTgErrorCode(reasonRaw); // เผื่อ reason เป็น code TG
                const msg = `ข้าม ${label}: หา user ไม่เจอ/resolve ไม่ได้ — ${tr.th}${tr.code ? ` (${tr.code})` : ""}`;
                job.logs.push({ text: msg, time: new Date() });
                telegramPush(jobId, { invited: job.invited, total: qty, log: msg });
                await job.save();
                continue;
              }

              const userEnt = rr.user;
              const tgUserId = userEnt.id;
              const showName = userEnt.username ? `@${userEnt.username}` : (userEnt.firstName || label);

              const exists = await TgInviteLog.findOne({
                destGroup: job.destGroup,
                tgUserId
              }).lean();

              listProcessed++;

              if (exists) {
                listAlready++;
                pushJobLog(job, jobId, `👥 ${showName} อยู่ในกลุ่มแล้ว (เคยเชิญแล้ว)`, { persist: true });
                await job.save();
                continue;
              }

              const r = await inviteOne(client, dst, userEnt);

              if (r.ok) {
                await TgInviteLog.create({
                  jobId: job._id,
                  accountId: acc._id,
                  tgUserId,
                  tgUserName: showName,
                  srcGroup: job.srcGroup || "-",
                  destGroup: job.destGroup
                });

                job.logs.push({ text: `เชิญ ${showName} สำเร็จ`, time: new Date() });
                job.invited++;
                remaining--;
                doneThisAcc++;
                acc.invitesToday++;

                telegramPush(jobId, { invited: job.invited, total: qty, user: showName });

                if (acc.invitesToday % ROUND_LIMIT === 0) {
                  acc.cooldownUntil = new Date(Date.now() + COOLDOWN_MS);
                  acc.status = "COOLDOWN";
                  await acc.save();

                  if (remaining > 0) {
                    const left = await pickAccounts(uid);
                    if (!left.length) {
                      await finalizeEarly(job, jobId, qty, `บัญชีครบโควต้า ${ROUND_LIMIT}คน/รอบ และไม่มีบัญชีสำรอง`);
                      return;
                    }
                  }
                  break;
                }

              } else if (r.already) {
                listAlready++;
                pushJobLog(job, jobId, `👥 ${showName} อยู่ในกลุ่มแล้ว`, { persist: true });
                await job.save();
                continue;
              
              } else if (r.privacy) {
                job.failed++;
                const tr = translateTgErrorCode("USER_PRIVACY_RESTRICTED");
                const msg = `ข้าม ${showName}: ${tr.th}${tr.code ? ` (${tr.code})` : ""}`;
                job.logs.push({ text: msg, time: new Date() });
                telegramPush(jobId, { invited: job.invited, total: qty, log: msg });
                await job.save();
                continue;

              } else if (r.flood) {
                const waitMs = Math.max(60_000, Number(r.waitMs || COOLDOWN_MS));
                const mins = Math.ceil(waitMs / 60000);

                acc.cooldownUntil = new Date(Date.now() + waitMs);
                acc.status = "COOLDOWN";
                acc.lastError = `FLOOD_WAIT (${mins} นาที)`;
                await acc.save();

                if (remaining > 0) {
                  const left = await pickAccounts(uid);
                  if (!left.length) {
                    await finalizeEarly(job, jobId, qty, `โดน FLOOD_WAIT ~${mins} นาที และไม่มีบัญชีสำรอง`);
                    return;
                  }
                }
                break;

              } else if (r.peerFlood) {
                const hrs = Math.ceil(PEER_FLOOD_COOLDOWN_MS / 3600000);
                acc.cooldownUntil = new Date(Date.now() + PEER_FLOOD_COOLDOWN_MS);
                acc.status = "COOLDOWN";
                acc.lastError = `PEER_FLOOD (${hrs} ชม.)`;
                await acc.save();

                if (remaining > 0) {
                  const left = await pickAccounts(uid);
                  if (!left.length) {
                    await finalizeEarly(job, jobId, qty, `โดน PEER_FLOOD และไม่มีบัญชีสำรอง`);
                    return;
                  }
                }
                break;

              } else {
                job.failed++;
                const msg = formatInviteFail(showName, r.error || "unknown");
                job.logs.push({ text: msg, time: new Date() });
                telegramPush(jobId, { invited: job.invited, total: qty, log: msg });
              }

              await sleep(humanDelay());
              await job.save();
            }
          }

          // ✅ LIST: รายชื่อหมดแล้ว แต่ remaining ยังเหลือ → จบงาน ไม่งั้นจะวนค้าง
          if ((job.mode === "list") && remaining > 0) {
            const targets = Array.isArray(job.targets) ? job.targets : [];
            const listDone = (listIndex >= targets.length) || (listProcessed >= qty);

            if (listDone) {
              const allAlready = listProcessed > 0 && listAlready >= listProcessed && job.invited === 0;

              const reason = allAlready
                ? "ลองครบทุกชื่อแล้ว: สมาชิกทั้งหมดอยู่ในกลุ่มอยู่แล้ว"
                : "ลองครบรายชื่อแล้ว แต่ไม่สามารถเชิญเพิ่มได้ (อาจติด privacy/ข้อจำกัด/ไม่เจอ user)";

              await finalizeEarly(job, jobId, qty, reason, "finished");
              return;
            }
          }

        } catch (err) {
          const m = err?.message || String(err);
          job.logs.push({ text: `ERROR ${acc.phone}: ${m}`, time: new Date() });
          await job.save();
          telegramPush(jobId, { log: `❌ ERROR ${acc.phone}: ${m}` });
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

function normalizeTargetsForJobModel(rawTargets = []) {
  const list = Array.isArray(rawTargets) ? rawTargets : [];

  // ถ้าเป็น object อยู่แล้ว (อนาคตอาจส่งมาแบบ {value,type}) ก็ใช้เลย
  const justValue = list
    .map(x => (typeof x === "string" ? x : (x?.value || x?.target || x?.text || x?.raw || "")))
    .map(x => String(x || "").trim())
    .filter(Boolean);

  // ถ้า schema targets เป็น [String] ก็คืน string[] ได้เลย
  const tp = TelegramJob?.schema?.path("targets");
  const isDocArray = !!tp?.schema; // มี schema = embedded doc array
  if (!isDocArray) return justValue;

  // ถ้าเป็น embedded doc array -> สร้างเป็น object ให้ตรง schema (แบบยืดหยุ่น)
  const paths = tp.schema.paths || {};
  return justValue.map(v => {
    const obj = {};
    if (paths.value) obj.value = v;
    if (paths.target) obj.target = v;
    if (paths.text) obj.text = v;
    if (paths.raw) obj.raw = v;
    if (paths.type) obj.type = v.startsWith("@") ? "user" : "phone";
    if (paths.valid) obj.valid = true;
    return obj;
  });
}

function coerceTargets(rawTargets = []) {
  const list = Array.isArray(rawTargets) ? rawTargets : [];
  const seen = new Set();
  const out = [];
  const invalid = [];

  for (const item of list) {
    const raw =
      typeof item === "string"
        ? item
        : (item?.value || item?.text || item?.raw || item?.target || "");

    const r = normalizeTarget(raw);
    if (!r) continue;

    if (!r.ok) {
      invalid.push({ input: r.input || raw, reason: r.reason || "invalid" });
      continue;
    }

    const key = `${r.kind}:${String(r.value).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ kind: r.kind, value: r.value });
    if (out.length >= MAX_PHONES) break;
  }

  return { out, invalid };
}

// SSE STREAM
export function streamTelegramJob(req, res) {
  telegramSubscribe(req.params.jobId, res);
}

// ───────────────────────────────────────────────────────────────
// helpers (วางไว้ด้านบนFILE routes)
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

    const { mode, srcGroup, destGroup, limit, maxSecurity, targets } = req.body;

    function isFileImport(v){
      const s = String(v || "").trim();
      return s === "ไฟล์" || s === "__FILE_IMPORT__" || s === "FILE_IMPORT" || s === "FILE";
    }

    const src = String(srcGroup || "").trim();
    const dst = String(destGroup || "").trim();

    const m =
      (mode === "list") ||
      isFileImport(src) ||
      (Array.isArray(targets) && targets.length > 0)
        ? "list"
        : "group";

    const reasons = [];

    console.log("[/telegram/jobs/start] body =", req.body);
    /* =========================
      VALIDATE INPUT
    ========================== */
    let normalizedTargets = [];
    let invalidTargets = [];

    if (!dst) reasons.push("กรุณากรอกลิงก์กลุ่มปลายทาง");

    if (m === "group") {
      if (!src) reasons.push("กรุณากรอกลิงก์กลุ่มต้นทาง");
      if (isFileImport(src)) reasons.push("โหมด group ห้ามใช้ FILE_IMPORT เป็นกลุ่มต้นทาง");
    }

    if (m === "list") {
      const r = coerceTargets(targets);
      normalizedTargets = r.out;
      invalidTargets = r.invalid;

      if (!normalizedTargets.length) {
        reasons.push("โหมด list ต้องมีรายชื่อ targets จากไฟล์/รายการ (รูปแบบ @username หรือ +66...)");
      }

      // เตือนครั้งเดียวพอ (และส่ง invalidTargets กลับไปให้ UI ได้)
      if (invalidTargets.length) {
        reasons.push(`มีรายการที่รูปแบบไม่ถูกต้อง ${invalidTargets.length} รายการ`);
      }
    }

    let qty = Math.floor(Number(limit) || 0);

    if (m === "list") {
      const totalTargets = normalizedTargets.length;

      // ถ้าไม่กรอก limit → ใช้จำนวนที่ “ผ่าน normalize” เท่านั้น
      if (qty <= 0) qty = totalTargets;

      // อย่าให้เกินจำนวนที่มีจริง + max ต่อ job
      qty = Math.min(qty, totalTargets, MAX_LIMIT_PER_JOB);

    } else {
      // group mode: limit ต้องมากกว่า 0 และไม่เกิน max ต่อ job
      qty = Math.min(qty, MAX_LIMIT_PER_JOB);
    }

    if (qty <= 0) reasons.push("จำนวนสมาชิกต้องมากกว่า 0");

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
      .select("phone status cooldownUntil session invitesToday lastError createdAt")
      .lean();

    const now = Date.now();
    const warnings = [];

    if (!accounts.length) {
      reasons.push("คุณยังไม่มีบัญชี Telegram ในระบบ");
    } else {
      // ✅ ready จริง: มี session + ไม่ติดคูลดาวน์ + ไม่ LOCKED
      const readySorted = await pickAccounts(uid, { maxSecurity: !!maxSecurity });

      // ✅ เก็บ warning เฉพาะตัวที่ติดคูลดาวน์ (เพื่อโชว์เฉยๆ)
      for (const acc of accounts) {
        const until = acc.cooldownUntil ? new Date(acc.cooldownUntil).getTime() : null;
        if (String(acc.status) === "COOLDOWN" && until && until > now) {
          const min = Math.ceil((until - now) / 60000);
          warnings.push(`บัญชี ${acc.phone} ติดคูลดาวน์อีก ${min} นาที`);
        }
        if (!acc.session) warnings.push(`บัญชี ${acc.phone} ไม่มี session`);
        if (String(acc.status) === "LOCKED") warnings.push(`บัญชี ${acc.phone} ถูกล็อก (LOCKED)`);
      }

      // ❌ ถ้าไม่มี READY เลย ค่อยบล็อก
      if (!readySorted.length) {
        reasons.push("ยังไม่มีบัญชีพร้อมใช้งาน (READY)");
        // จะเอา warnings ไปแสดงร่วมด้วยก็ได้
        reasons.push(...warnings);
      } else {
        // ✅ มี READY แล้ว → ห้ามบล็อกเพราะบัญชีอื่น COOLDOWN
        // ส่ง warnings กลับไปให้ UI โชว์แบบไม่บล็อก
      }
    }

    /* =========================
      มีเหตุผลที่งานเริ่มไม่ได้?
    ========================== */
    if (reasons.length > 0) {
      return res.json({
        ok: false,
        type: "precheck_fail",
        reasons,
        warnings,
        invalidTargets: invalidTargets || []
      });
    }

    /* =========================
       มีเหตุผลที่งานเริ่มไม่ได้?
    ========================== */
    if (reasons.length > 0) {
      return res.json({
        ok: false,
        type: "precheck_fail",
        reasons,
        invalidTargets: invalidTargets || []
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
      mode: m,
      srcGroup: (m === "group") ? src : null,
      destGroup: dst,
      targets: (m === "list") ? normalizedTargets : [],
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

router.get("/history/:jobId", requireAuth, async (req, res) => {
  const q = { _id: req.params.jobId };

  // ถ้าไม่ใช่แอดมิน ให้เห็นเฉพาะของตัวเอง
  if (req.user?.role !== "admin") q.userId = req.user._id;

  const job = await TelegramJob.findOne(q)
    .select("orderId srcGroup destGroup limit invited failed status logs createdAt")
    .lean();

  if (!job) return res.json({ ok: false, error: "ไม่พบงานนี้" });

  return res.json({
    ok: true,
    logs: job.logs || [],
    meta: {
      orderId: job.orderId,
      srcGroup: job.srcGroup,
      destGroup: job.destGroup,
      limit: job.limit,
      invited: job.invited,
      failed: job.failed,
      status: job.status,
      createdAt: job.createdAt,
    },
  });
});

/* ===============================================================
   API: เพิ่มเบอร์
=============================================================== */
router.post("/targets/parse", requireAuth, upload.single("file"), (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.json({ ok:false, error:"ไม่พบFILE" });

    const filename = String(file.originalname || "").toLowerCase();
    const content = file.buffer.toString("utf8");

    let rawItems = [];

    if (filename.endsWith(".csv")) {
      const records = csvParse(content, {
        relax_quotes: true,
        relax_column_count: true,
        skip_empty_lines: true
      });
      rawItems = records.flat().map(v => String(v || "").trim()).filter(Boolean);
    } else {
      rawItems = extractFromText(content);
    }

    const seen = new Set();
    const targets = [];
    const invalid = [];

    for (const item of rawItems) {
      const r = normalizeTarget(item);
      if (!r) continue;

      if (!r.ok) {
        invalid.push({ input: r.input || item, reason: r.reason || "invalid" });
        continue;
      }

      const key = `${r.kind}:${String(r.value).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      targets.push({ kind: r.kind, value: r.value });
      if (targets.length >= MAX_PHONES) break;
    }

    // แยกให้ UI ใช้ง่าย
    const phones = targets.filter(t => t.kind === "phone").map(t => t.value);
    const usernames = targets.filter(t => t.kind === "username").map(t => t.value);

    return res.json({
      ok:true,
      targets,
      phones,
      usernames,
      invalid,
      max: MAX_PHONES
    });
  } catch (e) {
    console.error("parse targets error:", e);
    return res.json({ ok:false, error:"อ่านFILEไม่สำเร็จ" });
  }
});

export default router;
