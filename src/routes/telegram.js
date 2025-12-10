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

import { signPayload, verifyPayload } from "../lib/tgLoginToken.js";
import { startTelegramJob, stopTelegramJob, streamTelegramJob } from "../services/telegramRunner.js";

const router = Router();

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
      .select("phone status invitesToday lastError createdAt")
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
    res.render("telegram/history", {
      title: "ประวัติการดึงสมาชิก"
    });
  } catch (err) {
    console.error("TG HISTORY PAGE ERROR:", err);
    res.status(500).send("Error");
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
