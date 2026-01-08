// routes/topup.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import { jwtVerify } from "jose";

import { getAuthUserId } from "../lib/auth.js";
import { User } from "../models/User.js";
import { Topup } from "../models/Topup.js";
import { Transaction } from "../models/Transaction.js";

import { config } from "../config.js";

export const topupRouter = express.Router();

// helper: สร้าง Date จากเวลา "ตามประเทศไทย" ให้ถูกต้อง
const BANGKOK_TZ_OFFSET_MIN = 7 * 60; // +07:00

function makeBangkokDateFromParts(year, month, day, hour, minute, second = 0) {
  // month: 1-12
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMs = BANGKOK_TZ_OFFSET_MIN * 60 * 1000;
  // ลบ offset ออกเพื่อให้ epoch ตรงกับเวลาไทย (แปลงเป็น UTC)
  return new Date(utcMs - offsetMs);
}

// ───────────────────────────────
// GET /topup
// ───────────────────────────────
topupRouter.get("/", async (req, res) => {
  try {
    const userId = req?.session?.userId;
    if (!userId) return res.redirect("/login");

    const user = await User.findById(userId).lean();
    if (!user) return res.redirect("/login");

    // ✅ แสดงทุกช่องทางที่ "เปิดใช้งาน" จริง โดยจำกัดเฉพาะโค้ดที่รองรับออโต้ตอนนี้
    //    (tw, kbank, scb) — ถ้ามีเพิ่มค่อยขยายลิสต์ได้
    const webWallets = await Topup.find({
      isActive: true,
      accountCode: { $in: ["tw", "kbank", "scb"] },
    }).lean();

    const transactions = await Transaction.find({ userId })
      .sort({ _id: -1 })
      .limit(20)
      .lean();

    res.render("topup/index", {
      title: "เติมเงิน",
      user,
      webWallets,       // ← ส่งกระเป๋าที่ active ทั้งหมดให้หน้าบ้าน
      transactions,
    });
  } catch (err) {
    console.error("Topup page error:", err);
    res.status(500).send("เกิดข้อผิดพลาดในระบบ");
  }
});

/* ───────────────────────────────
   POST /truewallet/gen/link
──────────────────────────────── */
topupRouter.post("/truewallet/gen/link", async (req, res) => {
  try {
    const { amount } = req.body;
    // จำนวนต้องส่งมาเป็นยอดสุทธิที่สุ่มเศษแล้วจาก /topup/create
    const payAmount = Math.round(Number(amount || 0) * 100) / 100;
    if (!(payAmount > 0)) {
      return res.status(400).json({ success: false, message: "invalid_amount" });
    }

    // โหลดบัญชี TrueWallet ที่ใช้งานอยู่
    const webWallet = await Topup.findOne({ accountCode: "tw", isActive: true, isSMS: false }).lean();
    if (!webWallet) {
      return res.status(404).json({ success: false, message: "wallet_inactive" });
    }

    // 👇 แค่ "ขอลิงก์" จาก TrueMoney — ห้ามสร้าง Transaction นะจ๊ะ
    const r = await axios.post(
      "https://apis.truemoneyservices.com/utils/v1/transfer-link-generator",
      {
        mobile_number: webWallet.accountNumber,
        amount: payAmount.toFixed(2),
        message: ""
      },
      {
        headers: {
          Authorization: `Bearer ${config.TW_GEN_LINK_SECRET}`,
          "Content-Type": "application/json",
        },
        // timeout ใส่กันแหกเผื่อเน็ตงอแง
        timeout: 10_000,
      }
    );

    const url = r?.data?.data?.url;
    if (!url) {
      return res.status(502).json({ success: false, message: "tmw_no_url" });
    }

    return res.json({
      success: true,
      url,
      accountNumber: webWallet.accountNumber,
      accountName: webWallet.accountName,
    });
  } catch (err) {
    console.error("❌ /truewallet/gen/link error:", err?.response?.data || err);
    return res.status(500).json({ success: false, message: "server_error" });
  }
});

/* ───────────────────────────────
   POST /truewallet (Webhook or Confirm)
──────────────────────────────── */
topupRouter.post("/truewallet", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, message: "missing_message" });

    // 0) โหลดคอนฟิก TW ปกติ
    const topup = await Topup.findOne({ accountCode: "tw", isActive: true, isSMS: false }).lean();
    if (!topup) return res.status(404).json({ success: false, message: "account_not_found" });

    // 1) verify JWT จาก TrueMoney
    let payload;
    try {
      const secret = new TextEncoder().encode(topup.secret);
      const { payload: decoded } = await jwtVerify(message, secret);
      payload = decoded;
    } catch (err) {
      console.error("❌ JWT verify failed:", err);
      return res.status(401).json({ success: false, message: "unauthorized" });
    }

    const { event_type, amount, sender_mobile } = payload;
    if (event_type !== "P2P") {
      return res.status(400).json({ success: false, message: "invalid_event_type" });
    }

    // 2) แปลงจำนวนเงิน
    const rawAmount = Math.round(Number(amount)) / 100; // ยอดรวมเศษที่โอนมาจริง (เช่น 10.17)
    const addedCents = Math.round(rawAmount * 100);    // สตางค์สำหรับใช้ match transaction
    
    // 🔥 จุดแก้ไข: คำนวณยอดจำนวนเต็มที่จะเติมให้ผู้ใช้ (เช่น 10.17 -> 10)
    const amountToFill = Math.floor(rawAmount); 

    const occurredAt =
      payload?.transferred_at ? new Date(payload.transferred_at * 1000) :
      payload?.created_at     ? new Date(payload.created_at     * 1000) :
                                new Date();

    // 3) จับคู่ใบ pending
    const pendingTx = await Transaction.findOne({
      method: "tw",
      status: "pending",
      amountCents: addedCents,
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: new Date() } }
      ]
    }).sort({ createdAt: -1 });

    if (pendingTx) {
      const user = await User.findById(pendingTx.userId);
      if (!user) {
        pendingTx.note = "User not found at webhook";
        await pendingTx.save();
        return res.json({ success: true, method: "tw", amount: rawAmount, unmatched: true });
      }

      // 🔥 เติมเครดิตเฉพาะจำนวนเต็ม
      const newBalance = await user.addBalance(amountToFill);

      pendingTx.set({
        status: "completed",
        paidAt: occurredAt,
        amount: amountToFill, // บันทึกยอดที่เติมจริง (จำนวนเต็ม)
        note: `ยอดโอนจริง ${rawAmount} (หักเศษออกตอนเติม)`,
        username: user.username,
        matchedBy: "amountCents"
      });
      await pendingTx.save();

      console.log(`✅ TrueWallet Auto-Topup: ${user.username} +${amountToFill} (from ${rawAmount}) → ${newBalance}`);
      return res.json({
        success: true,
        method: "tw",
        username: user.username,
        amount: amountToFill,
        status: "completed",
        balance: newBalance,
      });
    }

    // 4) ไม่มี pending ให้จับคู่ → fallback ตามเบอร์ผู้โอน
    const user = await User.findOne({
      bankAccounts: { $elemMatch: { accountNumber: sender_mobile } },
    });

    if (!user) {
      await Transaction.create({
        method: "tw",
        senderNumber: sender_mobile,
        amount: amountToFill,      // บันทึกจำนวนเต็ม
        amountCents: addedCents,   // เก็บเศษไว้ตรวจสอบใน amountCents
        currency: "THB",
        status: "pending",
        paidAt: occurredAt,
        note: `unmatched by phone (raw: ${rawAmount})`
      });
      console.log(`✅ TrueWallet Deposit (unmatched): +${amountToFill} THB`);
      return res.json({ success: true, method: "tw", amount: amountToFill });
    }

    // 5) user เจอจากเบอร์
    if (topup.isAuto) {
      const newBalance = await user.addBalance(amountToFill); // เติมเฉพาะจำนวนเต็ม
      await Transaction.create({
        userId: user._id,
        username: user.username,
        method: "tw",
        senderNumber: sender_mobile,
        amount: amountToFill,
        amountCents: addedCents,
        currency: "THB",
        status: "completed",
        paidAt: occurredAt,
        note: `โอนมา ${rawAmount} เติม ${amountToFill}`
      });
      return res.json({
        success: true,
        method: "tw",
        username: user.username,
        amount: amountToFill,
        status: "completed",
        balance: newBalance,
      });
    } else {
      await Transaction.create({
        userId: user._id,
        username: user.username,
        method: "tw",
        senderNumber: sender_mobile,
        amount: amountToFill,
        amountCents: addedCents,
        currency: "THB",
        status: "pending",
        paidAt: occurredAt,
      });
      return res.json({ success: true, method: "tw", username: user.username, amount: amountToFill, status: "pending" });
    }
  } catch (err) {
    console.error("❌ /truewallet error:", err);
    res.status(500).json({ success: false, message: "something_wrong" });
  }
});

/* ───────────────────────────────
   POST /truewallet/check
   🔹 Called when user clicks "ยืนยันการโอนแล้ว"
──────────────────────────────── */
topupRouter.post("/truewallet/check", async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req?.session?.userId;
    if (!userId || !(amount > 0)) {
      return res
        .status(400)
        .json({ success: false, message: "missing_parameters" });
    }

    // ยอดที่บันทึกใน Transaction คือ "added" = amount (ไม่ +3%)
    const targetCents = Math.round(Number(amount) * 100);
    const tx = await Transaction.findOne({
      userId,
      method: "tw",
      amount: targetCents,
      status: "completed",
      createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
    }).sort({ createdAt: -1 });

    if (tx) {
      return res.json({
        success: true,
        verified: true,
        transactionId: tx.transactionId,
        status: tx.status,
      });
    }
    return res.json({
      success: true,
      verified: false,
      message: "ยังไม่พบรายการเติมเงินในระบบ โปรดลองอีกครั้งในอีกสักครู่",
    });
  } catch (err) {
    console.error("❌ /truewallet/check error:", err);
    res.status(500).json({ success: false, message: "something_wrong" });
  }
});

/* ───────────────────────────────
   POST /BANK (Auto SMS webhook)
──────────────────────────────── */
topupRouter.post("/create", async (req, res) => {
  try {
    const uid = getAuthUserId(req);
    if (!uid) return res.status(401).json({ ok: false, error: "unauthorized" });

    const user = await User.findById(uid).lean();
    if (!user) {
      return res.status(400).json({ ok: false, error: "user_not_found" });
    }

    const base = Number(req.body.amount);
    const walletCode = String(req.body.walletCode || "tw").toLowerCase();
    if (!Number.isFinite(base) || base < 10) {
      return res.status(400).json({ ok: false, error: "invalid_amount_min_10" });
    }

    // ⛔ กันใบ pending ซ้ำของผู้ใช้เดียวกัน-วิธีเดียวกัน (ยังไม่หมดอายุ)
    const now = Date.now();
    const existing = await Transaction.findOne({
      userId: uid,
      method: walletCode,
      status: "pending",
      expiresAt: { $gt: new Date(now) }
    }).sort({ createdAt: -1 });

    if (existing) {
      // TW ให้ไป gen link เอง /truewallet/gen/link, ธนาคารส่ง QR KBANK อย่างเดียว
      const qrUrl = walletCode === "tw" ? null : "/static/assets/payment/qr-kbank.jpg";
      const expiresIn = Math.max(30, Math.floor((existing.expiresAt.getTime() - now) / 1000));
      return res.json({
        ok: true,
        pendingTxId: String(existing._id),
        txId: String(existing._id),
        displayAmount: existing.amount,
        expiresIn,
        qrUrl
      });
    }

    // ✅ สร้าง pending ใหม่: สุ่มเศษ 0.01..0.60 และเช็ค "global clash" สำหรับ method นั้น ๆ
    const pickUniqueCents = async () => {
      for (let t = 0; t < 20; t++) { // เพิ่มรอบ loop เผื่อกรณีเศษชนกัน
        // สุ่มเลข 1 ถึง 19
        const randomSmallCents = Math.floor(Math.random() * 19) + 1; 
        
        // คำนวณยอดเงินรวมเศษ (เช่น 100.00 + 0.17 = 100.17)
        const uniqueAmt = (Math.round(base * 100) + randomSmallCents) / 100;
        const uniqueCents = Math.round(uniqueAmt * 100);

        // เช็คว่ายอดรวมเศษนี้มีการใช้งานค้างอยู่ในระบบไหม
        const clash = await Transaction.exists({
          method: walletCode,
          status: "pending",
          amountCents: uniqueCents,
          expiresAt: { $gt: new Date() }
        });
        
        if (!clash) return { uniqueAmt, uniqueCents };
      }
      
      // Fallback กรณีสุ่มแล้วชนบ่อย (เพิ่มโอกาสสุ่มใหม่)
      const finalCents = Math.floor(Math.random() * 19) + 1;
      const finalAmt = (Math.round(base * 100) + finalCents) / 100;
      return { uniqueAmt: finalAmt, uniqueCents: Math.round(finalAmt * 100) };
    };

    const { uniqueAmt, uniqueCents } = await pickUniqueCents();

    const tx = await Transaction.create({
      userId: uid,
      username: user.username,
      method: walletCode,
      amount: uniqueAmt,
      amountCents: uniqueCents,
      expectedAmount: uniqueAmt,
      status: "pending",
      // expiresAt: new Date(now + 30 * 60 * 1000), // 30 นาที
      expiresAt: new Date(now + 2 * 60 * 60 * 1000), // 2 ชั่วโมง
    });

    // ธนาคาร: ใช้ QR KBANK อย่างเดียว / TW: null (ไป gen link เอง)
    const qrUrl = walletCode === "tw" ? null : "/static/assets/payment/qr-kbank.jpg";

    return res.json({
      ok: true,
      txId: String(tx._id),
      displayAmount: uniqueAmt,
      expiresIn: 300,
      qrUrl
    });
  } catch (err) {
    console.error("create topup error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

topupRouter.get("/tx/:id", async (req, res) => {
  try {
    const tx = await Transaction.findById(req.params.id).lean();
    if (!tx) return res.status(404).json({ ok: false, error: "not_found" });

    // ให้ watcher ใช้ปิดโมดัลได้ชัวร์ ๆ
    res.json({
      ok: true,
      status: tx.status,
      method: tx.method,
      amount: tx.amount,
      paidAt: tx.paidAt || null,
      updatedAt: tx.updatedAt || null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// เติมเครดิต KBANK แบบจับคู่ด้วยยอดเงิน + เศษ (อัปเดต)
topupRouter.post("/kbank", async (req, res) => {
  try {
    const { message, secret, timestamp } = req.body;
    if (!message || !secret || !timestamp)
      return res.status(400).json({ success:false, message:"missing_parameters" });

    // รองรับ 2 รูปแบบ:
    // 1) 24/10 12:34 บช X-123456 รับโอนจาก X-654321 1,234.56 คงเหลือ
    // 2) 09/12/68 11:14 บช X-0314 เงินเข้า 2,000.02 คงเหลือ 3,515.09 บ.
    const regex = /(\d{2})\/(\d{2})(?:\/(\d{2}))?\s+(\d{2}):(\d{2})\s+บช\s+X-(\d+)\s+(?:รับโอนจาก\s+X-(\d+)\s+)?(?:เงินเข้า|รับโอนจาก\s+X-\d+)\s+([\d,]+\.\d{2})(?:\s+คงเหลือ\s+([\d,]+\.\d{2}))?/i;
    const match = String(message).match(regex);
    if (!match) {
      return res.status(400).json({ success:false, message:"invalid_message_format" });
    }

    // ─────────────────────── Parsed fields ───────────────────────
    let [
      _,
      day,
      month,
      year2,
      hour,
      minute,
      receiverDigits,
      senderDigits,
      amountStr,
      balanceStr
    ] = match;

    senderDigits = senderDigits || ""; // optional

    // ปี: ถ้ามี /68 → 2068
    let year;
    if (year2) {
      year = 2000 + Number(year2);
    } else {
      year = new Date().getFullYear();
    }

    // Amount
    const amt = Number(amountStr.replace(/,/g, "")) || 0;
    const amtCents = Math.round(amt * 100);

    // seconds จาก timestamp
    const seconds = new Date(timestamp * 1000).getSeconds();

    const parsedDate = makeBangkokDateFromParts(
      year,
      Number(month),
      Number(day),
      Number(hour),
      Number(minute),
      seconds
    );

    // ─────────────────────── ตรวจบัญชี / secret ───────────────────────
    const topup = await Topup.findOne({
      type: "DEPOSIT",
      accountCode: "kbank",
      accountNumber: new RegExp(`${receiverDigits}$`, "i"),
      isActive: true,
      isSMS: true,
    }).lean();

    if (!topup)
      return res.status(404).json({ success:false, message:"account_not_found" });
    if (secret !== topup.secret)
      return res.status(401).json({ success:false, message:"unauthorized" });

    // ─────────────────────── กันยิงซ้ำ ±2 นาที ───────────────────────
    const twoMinBefore = new Date(parsedDate.getTime() - 2 * 60 * 1000);
    const twoMinAfter  = new Date(parsedDate.getTime() + 2 * 60 * 1000);

    const dup = await Transaction.findOne({
      method: "kbank",
      amountCents: amtCents,
      status: "completed",
      createdAt: { $gte: twoMinBefore, $lte: twoMinAfter },
    }).lean();

    if (dup) {
      return res.json({
        success:true,
        method:"kbank",
        deduped:true,
        amount:amt,
        timestamp
      });
    }

    // ─────────────────────── หา Pending ที่มีเจ้าของ ───────────────────────
    const pendingTx = await Transaction.findOne({
      method: "kbank",
      amountCents: amtCents,
      status: "pending",
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: new Date() } },
      ],
    }).sort({ createdAt: -1 });

    // ❌ ไม่มีเจ้าของ → สร้าง unmatched
    if (!pendingTx) {
      await Transaction.create({
        method: "kbank",
        amount: amt,
        amountCents: amtCents,
        currency: "THB",
        status: "pending",
        senderLast6: senderDigits,
        receiverLast6: receiverDigits,
        createdAt: parsedDate,
        note: "unmatched by amount",
      });

      console.log(`✅ KBANK Deposit (unmatched): +${amt} THB`);
      return res.json({
        success:true,
        method:"kbank",
        amount:amt,
        timestamp,
        unmatched:true
      });
    }

    // ─────────────────────── มีเจ้าของจริง → เติมเครดิต ───────────────────────
    const user = await User.findById(pendingTx.userId);
    if (!user) {
      pendingTx.note = "User not found at webhook";
      await pendingTx.save();
      return res.json({
        success:true,
        method:"kbank",
        amount:amt,
        unmatched:true
      });
    }

    const newBalance = await user.addBalance(amt);

    pendingTx.set({
      status: "completed",
      matchedBy: "amountCents",
      matchedTxId: pendingTx._id,
      senderLast6: senderDigits,
      receiverLast6: receiverDigits,
      createdAt: parsedDate,   // เวลาอิง SMS
      paidAt: new Date(),      // เวลาเว็บบันทึกสำเร็จ
      username: user.username
    });
    await pendingTx.save();

    console.log(`✅ KBANK Auto-Topup: ${user.username} +${amt} → ${newBalance}`);

    return res.json({
      success:true,
      method:"kbank",
      username:user.username,
      amount:amt,
      status:"completed",
      timestamp
    });

  } catch (err) {
    console.error("❌ /kbank error:", err);
    return res.status(500).json({
      success:false,
      message:"something_wrong"
    });
  }
});

// เติมเครดิต SCB แบบจับคู่ด้วยยอดเงิน + เศษ (อัปเดตให้ logic = KBANK)
topupRouter.post("/scb", async (req, res) => {
  try {
    const { message, secret, timestamp } = req.body;
    if (!message || !secret || !timestamp) {
      return res.status(400).json({ success: false, message: "missing_parameters" });
    }

    // ตัวอย่าง: "26/10@18:54 1,234.00 จากKBANK/x123456 เข้าบัญชี xxx เข้าx987654"
    const regex = /(\d{2})\/(\d{2})@(\d{2}):(\d{2})\s+([\d,]+\.\d{2})\s+จาก([A-Z]+)\/x(\d+).*?เข้าx(\d+)/i;
    const match = String(message).match(regex);
    if (!match) {
      return res.status(400).json({ success: false, message: "invalid_message_format" });
    }

    let [, day, month, hour, minute, amountStr, bankLogoRaw, senderLast6, receiverLast6] = match;

    // normalize bank code (เก็บประกอบข้อมูล)
    let bankLogo = String(bankLogoRaw || "").trim().toUpperCase();
    const bankMap = { KBNK: "KBANK", KTBK: "KTB", SCBA: "SCB", BAYK: "BAY" };
    if (bankMap[bankLogo]) bankLogo = bankMap[bankLogo];

    // เวลาแบบ UTC ให้เสถียร (เหมือน KBANK)
    const year = new Date().getFullYear();
    const seconds = new Date(timestamp * 1000).getSeconds();
    const parsedDate = makeBangkokDateFromParts(
      Number(year),
      Number(month),
      Number(day),
      Number(hour),
      Number(minute),
      Number(seconds)
    );

    // จำนวนเงิน
    const amt = Number(String(amountStr).replace(/,/g, "")) || 0;
    const amtCents = Math.round(amt * 100);
    const senderDigits = String(senderLast6 || "").trim();
    const receiverDigits = String(receiverLast6 || "").trim();

    // ตรวจบัญชี + secret
    const topup = await Topup.findOne({
      type: "DEPOSIT",
      accountCode: "scb",
      accountNumber: new RegExp(`${receiverDigits}$`, "i"),
      isActive: true,
      isSMS: true,
    }).lean();

    if (!topup) {
      return res.status(404).json({ success: false, message: "account_not_found" });
    }
    if (secret !== topup.secret) {
      return res.status(401).json({ success: false, message: "unauthorized" });
    }

    // กันยิงซ้ำ: completed เดิมในช่วง ±2 นาที ด้วย amountCents
    const twoMinBefore = new Date(parsedDate.getTime() - 2 * 60 * 1000);
    const twoMinAfter  = new Date(parsedDate.getTime() + 2 * 60 * 1000);
    const dup = await Transaction.findOne({
      method: "scb",
      amountCents: amtCents,
      status: "completed",
      createdAt: { $gte: twoMinBefore, $lte: twoMinAfter },
    }).lean();

    if (dup) {
      return res.json({ success: true, method: "scb", deduped: true, amount: amt, timestamp });
    }

    // จับคู่ใบ pending ที่ยังไม่หมดอายุ → เอาใบล่าสุด
    const pendingTx = await Transaction.findOne({
      method: "scb",
      amountCents: amtCents,
      status: "pending",
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
    }).sort({ createdAt: -1 });

    if (!pendingTx) {
      await Transaction.create({
        method: "scb",
        senderBank: bankLogo.toLowerCase(),
        senderLast6: senderDigits,
        receiverLast6: receiverDigits,
        amount: amt,
        amountCents: amtCents,
        currency: "THB",
        status: "pending",
        createdAt: parsedDate,
        note: "unmatched by amount",
      });
      console.log(`✅ SCB Deposit (unmatched): +${amt} THB`);
      return res.json({ success: true, method: "scb", amount: amt, timestamp, unmatched: true });
    }

    // มีเจ้าของ → เติมเครดิต + อัปเดตใบเดิม
    const user = await User.findById(pendingTx.userId);
    if (!user) {
      pendingTx.note = "User not found at webhook";
      await pendingTx.save();
      return res.json({ success: true, method: "scb", amount: amt, unmatched: true });
    }

    const newBalance = await user.addBalance(amt);
    pendingTx.set({
      status: "completed",
      matchedBy: "amountCents",
      matchedTxId: pendingTx._id,
      senderLast6: senderDigits,
      receiverLast6: receiverDigits,
      createdAt: parsedDate,  // เวลาอิง SMS
      paidAt: new Date(),     // เวลาบันทึกสำเร็จในระบบ
      username: user.username,
    });
    await pendingTx.save();

    console.log(`✅ SCB Auto-Topup: ${user.username} +${amt} → ${newBalance}`);
    return res.json({
      success: true,
      method: "scb",
      username: user.username,
      amount: amt,
      status: "completed",
      timestamp,
    });
  } catch (err) {
    console.error("❌ /scb error:", err);
    return res.status(500).json({ success: false, message: "something_wrong" });
  }
});


// ระบบเก่าทั้งหมด
/* ───────────────────────────────
   GET /topup
──────────────────────────────── */
// topupRouter.get("/", async (req, res) => {
//   try {
//     const userId = req?.session?.userId;
//     if (!userId) return res.redirect("/login");

//     const user = await User.findById(userId).lean();
//     if (!user) return res.redirect("/login");

//     // โค้ดบัญชีที่ผู้ใช้ผูกไว้ (เช่น ["tw"] หรือ ["kbank", "scb"] ฯลฯ)
//     const codes = (user.bankAccounts || []).map((acc) =>
//       (acc.accountCode || "").toLowerCase()
//     );

//     // ดึงสถานะ wallet ที่ระบบเปิดใช้อยู่จริง
//     const [twActive, scbActive] = await Promise.all([
//       Topup.findOne({ accountCode: "tw", isActive: true }).lean(),
//       Topup.findOne({ accountCode: { $in: ["kbank", "scb"] }, isActive: true }).lean(),
//     ]);

//     const webWallets = [];

//     // ถ้ามี TrueWallet ในโปรไฟล์ และระบบเปิดใช้งานอยู่ → แสดง
//     if (codes.includes("tw") && twActive) {
//       webWallets.push(twActive);
//     }

//     // ถ้ามี “บัญชีธนาคารใดๆ” ในโปรไฟล์ และ SCB เปิดใช้งาน → แสดง SCB
//     if (codes.some((c) => c && c !== "tw") && scbActive) {
//       webWallets.push(scbActive);
//     }

//     // ถ้าไม่มี TW ในโปรไฟล์เลย → fallback เป็น SCB (เฉพาะกรณี SCB เปิดใช้งาน)
//     if (!codes.includes("tw") && webWallets.length === 0 && scbActive) {
//       webWallets.push(scbActive);
//     }

//     // ประวัติ
//     const transactions = await Transaction.find({ userId })
//       .sort({ createdAt: -1 })
//       .limit(20)
//       .lean();

//     res.render("topup/index", {
//       title: "เติมเงิน",
//       user,
//       webWallets,
//       transactions,
//     });
//   } catch (err) {
//     console.error("Topup page error:", err);
//     res.status(500).send("เกิดข้อผิดพลาดในระบบ");
//   }
// });

// topupRouter.get("/", async (req, res) => {
//   try {
//     const userId = req?.session?.userId;
//     if (!userId) return res.redirect("/login");

//     // 🟢 Find user
//     const user = await User.findById(userId).lean();
//     if (!user) return res.redirect("/login");

//     // 🟣 Gather all user account codes
//     // 🟢 Gather user account codes
//     const codes = (user.bankAccounts || []).map((acc) => acc.accountCode);
//     let webWallets = [];

//     // 🟣 Case 1: User has TrueWallet
//     if (codes.includes("tw")) {
//       // Always include TrueWallet
//       const twWallet = await Topup.findOne({ accountCode: "tw" }).lean();
//       if (twWallet) webWallets.push(twWallet);

//       // If user also has any bank, always pair with SCB
//       const hasBank = codes.some((c) => c !== "tw");
//       if (hasBank) {
//         const scbWallet = await Topup.findOne({ accountCode: "scb" }).lean();
//         if (scbWallet) webWallets.push(scbWallet);
//       }
//     } else {
//       // 🟢 Case 2: User has NO TrueWallet → always fallback to SCB
//       const scbWallet = await Topup.findOne({ accountCode: "scb" }).lean();
//       if (scbWallet) webWallets.push(scbWallet);
//     }

//     // 🧾 Fetch transaction history (latest first)
//     const transactions = await Transaction.find({ userId })
//       .sort({ createdAt: -1 })
//       .limit(20)
//       .lean();

//     // ✅ Render page
//     res.render("topup/index", {
//       title: "เติมเงิน",
//       user,
//       webWallets,
//       transactions, // 🟢 send to frontend
//     });
//   } catch (err) {
//     console.error("Topup page error:", err);
//     res.status(500).send("เกิดข้อผิดพลาดในระบบ");
//   }
// });

/* ───────────────────────────────
   POST /truewallet/gen/link
──────────────────────────────── */
// topupRouter.post("/truewallet/gen/link", async (req, res) => {
//   try {
//     const { amount } = req.body;
//     const userId = req?.session?.userId;
//     if (!userId || !(amount > 0)) {
//       return res
//         .status(400)
//         .json({ success: false, message: "missing_parameters" });
//     }

//     // ใช้เฉพาะกระเป๋า TW ที่เปิดใช้งานอยู่จริง
//     const webWallet = await Topup.findOne({
//       accountCode: "tw",
//       isActive: true,
//     }).lean();
//     if (!webWallet) {
//       return res
//         .status(404)
//         .json({ success: false, message: "wallet_inactive" });
//     }

//     const response = await axios.post(
//       "https://apis.truemoneyservices.com/utils/v1/transfer-link-generator",
//       {
//         mobile_number: webWallet.accountNumber,
//         amount: Number(amount).toFixed(2),
//         message: "",
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${config?.TW_GEN_LINK_SECRET}`,
//           "Content-Type": "application/json",
//         },
//       }
//     );

//     return res.json({
//       accountNumber: webWallet.accountNumber,
//       accountName: webWallet.accountName,
//       url: response.data.data.url,
//     });
//   } catch (err) {
//     console.error("❌ /truewallet/gen/link error:", err);
//     res.status(500).json({ success: false, message: "something_wrong" });
//   }
// });

// topupRouter.post("/truewallet/gen/link", async (req, res) => {
//   try {
//     const { amount } = req.body;
//     const userId = req?.session?.userId;
//     const user = await User.findById(userId);
//     const webWallet = await Topup.findOne({
//       accountCode: user.bankAccounts[0].accountCode,
//     });

//     const response = await axios.post(
//       "https://apis.truemoneyservices.com/utils/v1/transfer-link-generator",
//       {
//         mobile_number: webWallet.accountNumber,
//         amount: (amount * 1.03).toString(),
//         message: "",
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${config?.TW_GEN_LINK_SECRET}`,
//           "Content-Type": "application/json",
//         },
//       }
//     );

//     return res.json({
//       accountNumber: webWallet.accountNumber,
//       accountName: webWallet.accountName,
//       url: response.data.data.url,
//     });
//   } catch (err) {
//     console.error("❌ /truewallet/gen/link error:", err);
//     res.status(500).json({ success: false, message: "something_wrong" });
//   }
// });

/* ───────────────────────────────
   POST /truewallet (Webhook or Confirm)
──────────────────────────────── */
// topupRouter.post("/truewallet", async (req, res) => {
//   try {
//     const { message } = req.body;

//     if (!message)
//       return res
//         .status(400)
//         .json({ success: false, message: "missing_message" });

//     // return res.status(200).json({ ok: true });

//     const topup = await Topup.findOne({
//       accountCode: "tw",
//       isActive: true,
//       isSMS: false,
//     }).lean();

//     if (!topup)
//       return res
//         .status(404)
//         .json({ success: false, message: "account_not_found" });

//     let payload;
//     try {
//       const secret = new TextEncoder().encode(topup.secret);
//       const { payload: decoded } = await jwtVerify(message, secret);
//       payload = decoded;
//     } catch (err) {
//       console.error("❌ JWT verify failed:", err);
//       return res.status(401).json({ success: false, message: "unauthorized" });
//     }

//     const { event_type, amount, sender_mobile } = payload;
//     if (event_type !== "P2P")
//       return res
//         .status(400)
//         .json({ success: false, message: "invalid_event_type" });

//     const user = await User.findOne({
//       bankAccounts: { $elemMatch: { accountNumber: sender_mobile } },
//     });

//     const added = amount / 100;

//     if (!user) {
//       await Transaction.create({
//         method: "tw",
//         senderNumber: sender_mobile,
//         amount: added,
//         currency: "THB",
//         status: "pending",
//       });
//       console.log(`✅ TrueWallet Deposit: +${added} THB`);

//       return res.json({
//         success: true,
//         method: "tw",
//         amount: added,
//       });
//     }

//     if (topup.isAuto) {
//       const newBalance = await user.addBalance(added);

//       await Transaction.create({
//         userId: user._id,
//         method: "tw",
//         senderNumber: sender_mobile,
//         amount: added,
//         currency: "THB",
//         status: "completed",
//       });

//       console.log(
//         `✅ TrueWallet Deposit: ${user.username} +${added} THB → ${newBalance}`
//       );

//       return res.json({
//         success: true,
//         method: "tw",
//         username: user.username,
//         amount: added,
//         status: "completed",
//         balance: newBalance,
//       });
//     } else {
//       await Transaction.create({
//         userId: user._id,
//         method: "tw",
//         senderNumber: sender_mobile,
//         amount: added,
//         currency: "THB",
//         status: "pending",
//       });

//       console.log(
//         `✅ TrueWallet Deposit (manual): ${user.username} +${added} THB (pending)`
//       );

//       // console.log(
//       //   `✅ TrueWallet Deposit: ${user.username} +${added} THB → ${newBalance}`
//       // );

//       return res.json({
//         success: true,
//         method: "tw",
//         username: user.username,
//         amount: added,
//         status: "pending",
//       });
//     }
//   } catch (err) {
//     console.error("❌ /truewallet error:", err);
//     res.status(500).json({ success: false, message: "something_wrong" });
//   }
// });

/* ───────────────────────────────
   POST /BANK (Webhook SMS Auto)
──────────────────────────────── */
// topupRouter.post("/scb", async (req, res) => {
//   try {
//     const { message, secret, timestamp } = req.body;
//     if (!message || !secret || !timestamp) {
//       return res
//         .status(400)
//         .json({ success: false, message: "missing_parameters" });
//     }

//     const baseDate = new Date(timestamp * 1000);
//     const seconds = baseDate.getSeconds();

//     // ตัวอย่าง SCB: "26/10@18:54 1,234.00 จากKBANK/x123456 เข้าบัญชี xxx เข้าx987654"
//     // ยืดหยุ่นขึ้นเล็กน้อย (ช่องว่าง/ตัวหนังสือคั่น)
//     const regex =
//       /(\d{2})\/(\d{2})@(\d{2}):(\d{2})\s+([\d,]+\.\d{2})\s+จาก([A-Z]+)\/x(\d+).*?เข้าx(\d+)/i;

//     const match = String(message).match(regex);
//     if (!match) {
//       return res
//         .status(400)
//         .json({ success: false, message: "invalid_message_format" });
//     }

//     let [
//       ,
//       day,
//       month,
//       hour,
//       minute,
//       amountStr,
//       bankLogoRaw,
//       senderLast6,
//       receiverLast6,
//     ] = match;

//     // Normalize bank logo
//     let bankLogo = String(bankLogoRaw || "")
//       .trim()
//       .toUpperCase();
//     const bankMap = {
//       KBNK: "KBANK",
//       KTBK: "KTB",
//       SCBA: "SCB",
//       BAYK: "BAY",
//     };
//     if (bankMap[bankLogo]) bankLogo = bankMap[bankLogo];

//     const year = new Date().getFullYear();

//     // Construct UTC date directly (no timezone conversion)
//     const parsedDate = new Date(
//       Date.UTC(year, month - 1, day, hour, minute, seconds)
//     );

//     console.log("Final UTC ISO:", parsedDate.toISOString());

//     const amount = Number(String(amountStr).replace(/,/g, "")) || 0;
//     const amt = Math.round(amount * 100) / 100;
//     const senderDigits = String(senderLast6 || "").trim();
//     const receiverDigits = String(receiverLast6 || "").trim();

//     // ✅ ใช้เฉพาะบัญชี SCB ที่เปิดใช้งาน + รับ SMS
//     const topup = await Topup.findOne({
//       type: "DEPOSIT",
//       accountCode: "scb",
//       accountNumber: new RegExp(`${receiverDigits}$`, "i"),
//       isActive: true,
//       isSMS: true,
//     }).lean();

//     if (!topup) {
//       return res
//         .status(404)
//         .json({ success: false, message: "account_not_found" });
//     }
//     if (secret !== topup.secret) {
//       return res.status(401).json({ success: false, message: "unauthorized" });
//     }

//     // 🔐 กันยิงซ้ำ: หา tx ที่เหมือนกันภายใน ±2 นาที
//     // const twoMinAgo = new Date(timestamp.getTime() - 2 * 60 * 1000);
//     // const twoMinAfter = new Date(timestamp.getTime() + 2 * 60 * 1000);
//     // const duplicate = await Transaction.findOne({
//     //   method: "scb",
//     //   senderLast6: senderDigits,
//     //   receiverLast6: receiverDigits,
//     //   amount: amt,
//     //   createdAt: { $gte: twoMinAgo, $lte: twoMinAfter },
//     // }).lean();

//     // if (duplicate) {
//     //   return res.json({
//     //     success: true,
//     //     method: "scb",
//     //     deduped: true,
//     //     amount: amt,
//     //     timestamp,
//     //   });
//     // }

//     // หาเจ้าของบัญชีผู้โอน (last6)
//     const user = await User.findOne({
//       bankAccounts: {
//         $elemMatch: { accountNumber: new RegExp(`${senderDigits}$`) },
//       },
//     });

//     // 📨 กรณีไม่รู้ว่าเป็นผู้ใช้คนไหน → บันทึก pending เพื่อให้แอดมินจับคู่
//     if (!user) {
//       await Transaction.create({
//         method: "scb",
//         senderBank: bankLogo.toLowerCase(),
//         senderLast6: senderDigits,
//         receiverLast6: receiverDigits,
//         amount: amt,
//         currency: "THB",
//         status: "pending",
//         createdAt: parsedDate,
//       });
//       console.log(`✅ SCB Deposit (unmatched): +${amt} THB`);
//       return res.json({ success: true, method: "scb", amount: amt, timestamp });
//     }

//     if (topup.isAuto) {
//       const newBalance = await user.addBalance(amt);

//       await Transaction.create({
//         userId: user._id,
//         method: "scb",
//         senderBank: bankLogo.toLowerCase(),
//         senderLast6: senderDigits,
//         receiverLast6: receiverDigits,
//         amount: amt,
//         currency: "THB",
//         status: "completed",
//         createdAt: parsedDate,
//       });

//       console.log(
//         `✅ SCB Deposit: ${user.username} +${amt} THB → ${newBalance}`
//       );
//       return res.json({
//         success: true,
//         method: "scb",
//         username: user.username,
//         amount: amt,
//         balance: newBalance,
//         timestamp,
//       });
//     } else {
//       await Transaction.create({
//         userId: user._id,
//         method: "scb",
//         senderBank: bankLogo.toLowerCase(),
//         senderLast6: senderDigits,
//         receiverLast6: receiverDigits,
//         amount: amt,
//         currency: "THB",
//         status: "pending",
//         createdAt: parsedDate,
//       });

//       console.log(
//         `✅ SCB Deposit (manual): ${user.username} +${amt} THB (pending)`
//       );
//       return res.json({
//         success: true,
//         method: "scb",
//         username: user.username,
//         amount: amt,
//         status: "pending",
//         timestamp,
//       });
//     }
//   } catch (err) {
//     console.error("❌ /scb error:", err);
//     return res.status(500).json({ success: false, message: "something_wrong" });
//   }
// });

// topupRouter.post("/kbank", async (req, res) => {
//   try {
//     const { message, secret, timestamp } = req.body;
//     if (!message || !secret || !timestamp) {
//       return res
//         .status(400)
//         .json({ success: false, message: "missing_parameters" });
//     }

//     const baseDate = new Date(timestamp * 1000);
//     const seconds = baseDate.getSeconds();

//     const regex =
//       /(\d{2})\/(\d{2})(?:\/\d{2})?\s+(\d{2}):(\d{2})\s+บช\s+X-(\d+)\s+รับโอนจาก\s+X-(\d+)\s+([\d,]+\.\d{2})\s+คงเหลือ/i;

//     const match = String(message).match(regex);
//     if (!match) {
//       return res
//         .status(400)
//         .json({ success: false, message: "invalid_message_format" });
//     }

//     let [, day, month, hour, minute, receiverLast6, senderLast6, amountStr] =
//       match;

//     const year = new Date().getFullYear();

//     // Construct UTC date directly (no timezone conversion)
//     const parsedDate = new Date(
//       Date.UTC(year, month - 1, day, hour, minute, seconds)
//     );

//     console.log("Final UTC ISO:", parsedDate.toISOString());

//     const amount = Number(String(amountStr).replace(/,/g, "")) || 0;
//     const amt = Math.round(amount * 100) / 100;
//     const senderDigits = String(senderLast6 || "").trim();
//     const receiverDigits = String(receiverLast6 || "").trim();

//     const topup = await Topup.findOne({
//       type: "DEPOSIT",
//       accountCode: "kbank",
//       accountNumber: new RegExp(`${receiverDigits}$`, "i"),
//       isActive: true,
//       isSMS: true,
//     }).lean();

//     if (!topup) {
//       return res
//         .status(404)
//         .json({ success: false, message: "account_not_found" });
//     }
//     if (secret !== topup.secret) {
//       return res.status(401).json({ success: false, message: "unauthorized" });
//     }

    // 🔐 กันยิงซ้ำ: หา tx ที่เหมือนกันภายใน ±2 นาที
    // const twoMinAgo = new Date(timestamp.getTime() - 2 * 60 * 1000);
    // const twoMinAfter = new Date(timestamp.getTime() + 2 * 60 * 1000);
    // const duplicate = await Transaction.findOne({
    //   method: "scb",
    //   senderLast6: senderDigits,
    //   receiverLast6: receiverDigits,
    //   amount: amt,
    //   createdAt: { $gte: twoMinAgo, $lte: twoMinAfter },
    // }).lean();

    // if (duplicate) {
    //   return res.json({
    //     success: true,
    //     method: "scb",
    //     deduped: true,
    //     amount: amt,
    //     timestamp,
    //   });
    // }

//     const user = await User.findOne({
//       bankAccounts: {
//         $elemMatch: { accountNumber: new RegExp(`${senderDigits}$`) },
//       },
//     });

//     // 📨 กรณีไม่รู้ว่าเป็นผู้ใช้คนไหน → บันทึก pending เพื่อให้แอดมินจับคู่
//     if (!user) {
//       await Transaction.create({
//         method: "kbank",
//         senderLast6: senderDigits,
//         receiverLast6: receiverDigits,
//         amount: amt,
//         currency: "THB",
//         status: "pending",
//         createdAt: parsedDate,
//       });
//       console.log(`✅ KBANK Deposit (unmatched): +${amt} THB`);
//       return res.json({ success: true, method: "scb", amount: amt, timestamp });
//     }

//     if (topup.isAuto) {
//       const newBalance = await user.addBalance(amt);

//       await Transaction.create({
//         userId: user._id,
//         method: "kbank",
//         senderLast6: senderDigits,
//         receiverLast6: receiverDigits,
//         amount: amt,
//         currency: "THB",
//         status: "completed",
//         createdAt: parsedDate,
//       });

//       console.log(
//         `✅ KBANK Deposit: ${user.username} +${amt} THB → ${newBalance}`
//       );
//       return res.json({
//         success: true,
//         method: "kbank",
//         username: user.username,
//         amount: amt,
//         status: "completed",
//         timestamp,
//       });
//     } else {
//       await Transaction.create({
//         userId: user._id,
//         method: "kbank",
//         senderLast6: senderDigits,
//         receiverLast6: receiverDigits,
//         amount: amt,
//         currency: "THB",
//         status: "pending",
//         createdAt: parsedDate,
//       });

//       console.log(
//         `✅ KBANK Deposit (manual): ${user.username} +${amt} THB (pending)`
//       );
//       return res.json({
//         success: true,
//         method: "kbank",
//         username: user.username,
//         amount: amt,
//         status: "pending",
//         timestamp,
//       });
//     }
//   } catch (err) {
//     console.error("❌ /kbank error:", err);
//     return res.status(500).json({ success: false, message: "something_wrong" });
//   }
// });

// topupRouter.post("/scb", async (req, res) => {
//   try {
//     const { message, secret } = req.body;
//     if (!message || !secret)
//       return res
//         .status(400)
//         .json({ success: false, message: "missing_parameters" });

//     const regex =
//       /(\d{2})\/(\d{2})@(\d{2}):(\d{2})\s+([\d,]+\.\d{2})\s+จาก([A-Z]+)\/x(\d+).*เข้าx(\d+)/;
//     const match = message.match(regex);
//     if (!match)
//       return res
//         .status(400)
//         .json({ success: false, message: "invalid_message_format" });

//     let [
//       ,
//       day,
//       month,
//       hour,
//       minute,
//       amountStr,
//       bankLogo,
//       senderLast6,
//       receiverLast6,
//     ] = match;

//     if (bankLogo) {
//       bankLogo = bankLogo.trim().toUpperCase();

//       const map = {
//         KBNK: "KBANK",
//       };

//       if (map[bankLogo]) bankLogo = map[bankLogo];
//     }

//     const year = new Date().getFullYear();
//     const timestamp = new Date(
//       `${year}-${month}-${day}T${hour}:${minute}:00+07:00`
//     );
//     const amount = parseFloat(amountStr.replace(/,/g, ""));
//     const senderDigits = senderLast6.trim();
//     const receiverDigits = receiverLast6.trim();

//     const topup = await Topup.findOne({
//       type: "DEPOSIT",
//       accountCode: "scb",
//       accountNumber: new RegExp(`${receiverDigits}$`),
//       isActive: true,
//       isSMS: true,
//     }).lean();

//     if (!topup)
//       return res
//         .status(404)
//         .json({ success: false, message: "account_not_found" });

//     if (secret !== topup.secret)
//       return res.status(401).json({ success: false, message: "unauthorized" });

//     const user = await User.findOne({
//       bankAccounts: {
//         $elemMatch: { accountNumber: new RegExp(`${senderDigits}$`) },
//       },
//     });

//     if (!user) {
//       await Transaction.create({
//         method: "scb",
//         senderBank: bankLogo.toLowerCase(),
//         senderLast6: senderDigits,
//         receiverLast6: receiverDigits,
//         amount,
//         currency: "THB",
//         status: "pending",
//       });
//       console.log(`✅ SCB Deposit: +${amount} THB`);
//       return res.json({
//         success: true,
//         method: "scb",
//         amount,
//         timestamp,
//       });
//     }

//     if (topup.isAuto) {
//       const newBalance = await user.addBalance(amount);

//       // ✅ Record transaction
//       await Transaction.create({
//         userId: user._id,
//         method: "scb",
//         senderBank: bankLogo.toLowerCase(),
//         senderLast6: senderDigits,
//         receiverLast6: receiverDigits,
//         amount,
//         currency: "THB",
//         status: "completed",
//       });

//       console.log(
//         `✅ SCB Deposit: ${user.username} +${amount} THB → ${newBalance}`
//       );

//       return res.json({
//         success: true,
//         method: "scb",
//         username: user.username,
//         amount,
//         balance: newBalance,
//         timestamp,
//       });
//     } else {
//       await Transaction.create({
//         userId: user._id,
//         method: "scb",
//         senderBank: bankLogo.toLowerCase(),
//         senderLast6: senderDigits,
//         receiverLast6: receiverDigits,
//         amount,
//         currency: "THB",
//         status: "pending",
//       });

//       console.log(
//         `✅ SCB Deposit: ${user.username} +${amount} THB → ${newBalance}`
//       );
//       return res.json({
//         success: true,
//         method: "scb",
//         username: user.username,
//         amount,
//         balance: newBalance,
//         timestamp,
//       });
//     }
//   } catch (err) {
//     console.error("❌ /scb error:", err);
//     res.status(500).json({ success: false, message: "something_wrong" });
//   }
// });

/* ───────────────────────────────
   POST /truewallet/check
   🔹 Called when user clicks "ยืนยันการโอนแล้ว"
──────────────────────────────── */
// topupRouter.post("/truewallet/check", async (req, res) => {
//   try {
//     const { amount } = req.body;
//     const userId = req?.session?.userId;

//     if (!userId || !amount)
//       return res
//         .status(400)
//         .json({ success: false, message: "missing_parameters" });

//     console.log(amount * 1.03);

//     const tx = await Transaction.findOne({
//       userId,
//       method: "tw",
//       amount: amount * 1.03,
//       status: "completed",
//       createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
//     }).sort({ createdAt: -1 });

//     if (tx) {
//       return res.json({
//         success: true,
//         verified: true,
//         transactionId: tx.transactionId,
//         status: tx.status,
//       });
//     } else {
//       return res.json({
//         success: true,
//         verified: false,
//         message: "ยังไม่พบรายการเติมเงินในระบบ โปรดลองอีกครั้งในอีกสักครู่",
//       });
//     }
//   } catch (err) {
//     console.error("❌ /truewallet/check error:", err);
//     res.status(500).json({ success: false, message: "something_wrong" });
//   }
// });