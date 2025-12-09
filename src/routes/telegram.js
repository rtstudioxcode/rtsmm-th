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

    const accounts = await TgAccount.find({ ownerId: uid })
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
      ownerId: uid,
      ownerUsername: username,
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
      ownerId: data.ownerId
    });

    if (!acc) {
      acc = await TgAccount.create({
        ownerId: data.ownerId,
        ownerUsername: data.ownerUsername,
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
      await acc.save();
    }

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

    if (String(acc.ownerId) !== String(uid)) {
      return res.json({ ok: false, message: "ไม่มีสิทธิ์ลบ" });
    }

    await TgAccount.updateOne(
      { _id: id },
      { $unset: { ownerId: "", ownerUsername: "" } }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("UNLINK ERROR:", err);
    return res.json({ ok: false, message: "เกิดข้อผิดพลาด" });
  }
});


/* ===============================================================
   JOB STREAM (ไม่ต้อง admin)
=============================================================== */
router.get("/:jobId/stream", requireAuth, (req, res) => {
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

    const list = await TelegramJob.find({ ownerId: uid })
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
