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

/* ───────────────────────────────
   GET /topup
──────────────────────────────── */

// ───────────────────────────────
// GET /topup
// ───────────────────────────────
topupRouter.get("/", async (req, res) => {
  try {
    const userId = req?.session?.userId;
    if (!userId) return res.redirect("/login");

    const user = await User.findById(userId).lean();
    if (!user) return res.redirect("/login");

    // โค้ดบัญชีที่ผู้ใช้ผูกไว้ (เช่น ["tw"] หรือ ["kbank", "scb"] ฯลฯ)
    const codes = (user.bankAccounts || []).map((acc) =>
      (acc.accountCode || "").toLowerCase()
    );

    // ดึงสถานะ wallet ที่ระบบเปิดใช้อยู่จริง
    const [twActive, scbActive] = await Promise.all([
      Topup.findOne({ accountCode: "tw", isActive: true }).lean(),
      Topup.findOne({ accountCode: ["kbank", "scb"], isActive: true }).lean(),
    ]);

    const webWallets = [];

    // ถ้ามี TrueWallet ในโปรไฟล์ และระบบเปิดใช้งานอยู่ → แสดง
    if (codes.includes("tw") && twActive) {
      webWallets.push(twActive);
    }

    // ถ้ามี “บัญชีธนาคารใดๆ” ในโปรไฟล์ และ SCB เปิดใช้งาน → แสดง SCB
    if (codes.some((c) => c && c !== "tw") && scbActive) {
      webWallets.push(scbActive);
    }

    // ถ้าไม่มี TW ในโปรไฟล์เลย → fallback เป็น SCB (เฉพาะกรณี SCB เปิดใช้งาน)
    if (!codes.includes("tw") && webWallets.length === 0 && scbActive) {
      webWallets.push(scbActive);
    }

    // ประวัติ
    const transactions = await Transaction.find({ userId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    res.render("topup/index", {
      title: "เติมเงิน",
      user,
      webWallets, // ✅ มีเฉพาะกระเป๋าที่ isActive จริง
      transactions,
    });
  } catch (err) {
    console.error("Topup page error:", err);
    res.status(500).send("เกิดข้อผิดพลาดในระบบ");
  }
});

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
topupRouter.post("/truewallet/gen/link", async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req?.session?.userId;
    if (!userId || !(amount > 0)) {
      return res
        .status(400)
        .json({ success: false, message: "missing_parameters" });
    }

    // ใช้เฉพาะกระเป๋า TW ที่เปิดใช้งานอยู่จริง
    const webWallet = await Topup.findOne({
      accountCode: "tw",
      isActive: true,
    }).lean();
    if (!webWallet) {
      return res
        .status(404)
        .json({ success: false, message: "wallet_inactive" });
    }

    const response = await axios.post(
      "https://apis.truemoneyservices.com/utils/v1/transfer-link-generator",
      {
        mobile_number: webWallet.accountNumber,
        amount: (amount * 1.03).toFixed(2),
        message: "",
      },
      {
        headers: {
          Authorization: `Bearer ${config?.TW_GEN_LINK_SECRET}`,
          "Content-Type": "application/json",
        },
      }
    );

    return res.json({
      accountNumber: webWallet.accountNumber,
      accountName: webWallet.accountName,
      url: response.data.data.url,
    });
  } catch (err) {
    console.error("❌ /truewallet/gen/link error:", err);
    res.status(500).json({ success: false, message: "something_wrong" });
  }
});

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
topupRouter.post("/truewallet", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message)
      return res
        .status(400)
        .json({ success: false, message: "missing_message" });

    // return res.status(200).json({ ok: true });

    const topup = await Topup.findOne({
      accountCode: "tw",
      isActive: true,
      isSMS: false,
    }).lean();

    if (!topup)
      return res
        .status(404)
        .json({ success: false, message: "account_not_found" });

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
    if (event_type !== "P2P")
      return res
        .status(400)
        .json({ success: false, message: "invalid_event_type" });

    const user = await User.findOne({
      bankAccounts: { $elemMatch: { accountNumber: sender_mobile } },
    });

    const added = amount / 100;

    if (!user) {
      await Transaction.create({
        method: "tw",
        senderNumber: sender_mobile,
        amount: added,
        currency: "THB",
        status: "pending",
      });
      console.log(`✅ TrueWallet Deposit: +${added} THB`);

      return res.json({
        success: true,
        method: "tw",
        amount: added,
      });
    }

    if (topup.isAuto) {
      const newBalance = await user.addBalance(added);

      await Transaction.create({
        userId: user._id,
        method: "tw",
        senderNumber: sender_mobile,
        amount: added,
        currency: "THB",
        status: "completed",
      });

      console.log(
        `✅ TrueWallet Deposit: ${user.username} +${added} THB → ${newBalance}`
      );

      return res.json({
        success: true,
        method: "tw",
        username: user.username,
        amount: added,
        status: "completed",
        balance: newBalance,
      });
    } else {
      await Transaction.create({
        userId: user._id,
        method: "tw",
        senderNumber: sender_mobile,
        amount: added,
        currency: "THB",
        status: "pending",
      });

      console.log(
        `✅ TrueWallet Deposit (manual): ${user.username} +${added} THB (pending)`
      );

      // console.log(
      //   `✅ TrueWallet Deposit: ${user.username} +${added} THB → ${newBalance}`
      // );

      return res.json({
        success: true,
        method: "tw",
        username: user.username,
        amount: added,
        status: "pending",
      });
    }
  } catch (err) {
    console.error("❌ /truewallet error:", err);
    res.status(500).json({ success: false, message: "something_wrong" });
  }
});

/* ───────────────────────────────
   POST /scb (Auto SMS webhook)
──────────────────────────────── */
topupRouter.post("/scb", async (req, res) => {
  try {
    const { message, secret, timestamp } = req.body;
    if (!message || !secret || !timestamp) {
      return res
        .status(400)
        .json({ success: false, message: "missing_parameters" });
    }

    const baseDate = new Date(timestamp * 1000);
    const seconds = baseDate.getSeconds();

    // ตัวอย่าง SCB: "26/10@18:54 1,234.00 จากKBANK/x123456 เข้าบัญชี xxx เข้าx987654"
    // ยืดหยุ่นขึ้นเล็กน้อย (ช่องว่าง/ตัวหนังสือคั่น)
    const regex =
      /(\d{2})\/(\d{2})@(\d{2}):(\d{2})\s+([\d,]+\.\d{2})\s+จาก([A-Z]+)\/x(\d+).*?เข้าx(\d+)/i;

    const match = String(message).match(regex);
    if (!match) {
      return res
        .status(400)
        .json({ success: false, message: "invalid_message_format" });
    }

    let [
      ,
      day,
      month,
      hour,
      minute,
      amountStr,
      bankLogoRaw,
      senderLast6,
      receiverLast6,
    ] = match;

    // Normalize bank logo
    let bankLogo = String(bankLogoRaw || "")
      .trim()
      .toUpperCase();
    const bankMap = {
      KBNK: "KBANK",
      KTBK: "KTB",
      SCBA: "SCB",
      BAYK: "BAY",
    };
    if (bankMap[bankLogo]) bankLogo = bankMap[bankLogo];

    const year = new Date().getFullYear();

    // Construct UTC date directly (no timezone conversion)
    const parsedDate = new Date(
      Date.UTC(year, month - 1, day, hour, minute, seconds)
    );

    console.log("Final UTC ISO:", parsedDate.toISOString());

    const amount = Number(String(amountStr).replace(/,/g, "")) || 0;
    const amt = Math.round(amount * 100) / 100;
    const senderDigits = String(senderLast6 || "").trim();
    const receiverDigits = String(receiverLast6 || "").trim();

    // ✅ ใช้เฉพาะบัญชี SCB ที่เปิดใช้งาน + รับ SMS
    const topup = await Topup.findOne({
      type: "DEPOSIT",
      accountCode: "scb",
      accountNumber: new RegExp(`${receiverDigits}$`, "i"),
      isActive: true,
      isSMS: true,
    }).lean();

    if (!topup) {
      return res
        .status(404)
        .json({ success: false, message: "account_not_found" });
    }
    if (secret !== topup.secret) {
      return res.status(401).json({ success: false, message: "unauthorized" });
    }

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

    // หาเจ้าของบัญชีผู้โอน (last6)
    const user = await User.findOne({
      bankAccounts: {
        $elemMatch: { accountNumber: new RegExp(`${senderDigits}$`) },
      },
    });

    // 📨 กรณีไม่รู้ว่าเป็นผู้ใช้คนไหน → บันทึก pending เพื่อให้แอดมินจับคู่
    if (!user) {
      await Transaction.create({
        method: "scb",
        senderBank: bankLogo.toLowerCase(),
        senderLast6: senderDigits,
        receiverLast6: receiverDigits,
        amount: amt,
        currency: "THB",
        status: "pending",
        createdAt: parsedDate,
      });
      console.log(`✅ SCB Deposit (unmatched): +${amt} THB`);
      return res.json({ success: true, method: "scb", amount: amt, timestamp });
    }

    if (topup.isAuto) {
      const newBalance = await user.addBalance(amt);

      await Transaction.create({
        userId: user._id,
        method: "scb",
        senderBank: bankLogo.toLowerCase(),
        senderLast6: senderDigits,
        receiverLast6: receiverDigits,
        amount: amt,
        currency: "THB",
        status: "completed",
        createdAt: parsedDate,
      });

      console.log(
        `✅ SCB Deposit: ${user.username} +${amt} THB → ${newBalance}`
      );
      return res.json({
        success: true,
        method: "scb",
        username: user.username,
        amount: amt,
        balance: newBalance,
        timestamp,
      });
    } else {
      await Transaction.create({
        userId: user._id,
        method: "scb",
        senderBank: bankLogo.toLowerCase(),
        senderLast6: senderDigits,
        receiverLast6: receiverDigits,
        amount: amt,
        currency: "THB",
        status: "pending",
        createdAt: parsedDate,
      });

      console.log(
        `✅ SCB Deposit (manual): ${user.username} +${amt} THB (pending)`
      );
      return res.json({
        success: true,
        method: "scb",
        username: user.username,
        amount: amt,
        status: "pending",
        timestamp,
      });
    }
  } catch (err) {
    console.error("❌ /scb error:", err);
    return res.status(500).json({ success: false, message: "something_wrong" });
  }
});


topupRouter.post("/create", async (req, res) => {
  try {
    const uid = getAuthUserId(req);
    if (!uid) return res.status(401).json({ ok:false, error:"unauthorized" });

    const base = Number(req.body.amount);
    const walletCode = String(req.body.walletCode || "kbank");
    if (!Number.isFinite(base) || base < 1)
      return res.status(400).json({ ok:false, error:"invalid_amount" });

    // เศษ .01-.60
    const decimalCents = Math.floor(Math.random() * 60) + 1;    // 1..60
    const uniqueAmt = (Math.round(base * 100) + decimalCents) / 100;
    const uniqueCents = Math.round(uniqueAmt * 100);

    const tx = await Transaction.create({
      userId: uid,
      method: walletCode,          // "kbank" / "scb" ...
      amount: uniqueAmt,
      amountCents: uniqueCents,    // <── สำคัญ
      expectedAmount: uniqueAmt,
      status: "pending",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    // รูป QR ของบัญชีปลายทาง (ใส่ของจริงตามธนาคาร)
    const qrUrl = "/static/assets/payment/qr-kbank.jpg";

    res.json({ ok:true, qrUrl, displayAmount: uniqueAmt, txId: String(tx._id), expiresIn: 300 });
  } catch (err) {
    console.error("create topup error:", err);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

topupRouter.get("/tx/:id", async (req,res)=>{
  try{
    const tx = await Transaction.findById(req.params.id).lean();
    if(!tx) return res.status(404).json({ok:false, error:"not_found"});
    // คืนสถานะพอ
    res.json({ ok:true, status: tx.status, method: tx.method, amount: tx.amount });
  }catch(e){
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// เติมเครดิต KBANK แบบจับคู่ด้วยยอดเงิน + เศษ
topupRouter.post("/kbank", async (req, res) => {
  try {
    const { message, secret, timestamp } = req.body;
    if (!message || !secret || !timestamp)
      return res.status(400).json({ success:false, message:"missing_parameters" });

    // ดึงจาก SMS
    const regex = /(\d{2})\/(\d{2})(?:\/\d{2})?\s+(\d{2}):(\d{2})\s+บช\s+X-(\d+)\s+รับโอนจาก\s+X-(\d+)\s+([\d,]+\.\d{2})\s+คงเหลือ/i;
    const match = String(message).match(regex);
    if (!match) return res.status(400).json({ success:false, message:"invalid_message_format" });

    let [, day, month, hour, minute, receiverLast6, senderLast6, amountStr] = match;
    const year = new Date().getFullYear();
    const seconds = new Date(timestamp * 1000).getSeconds();
    const parsedDate = new Date(Date.UTC(year, month - 1, day, hour, minute, seconds));

    const amt = Number(String(amountStr).replace(/,/g, "")) || 0;   // 10.31
    const amtCents = Math.round(amt * 100);                         // 1031
    const senderDigits = String(senderLast6||"").trim();
    const receiverDigits = String(receiverLast6||"").trim();

    // ตรวจบัญชี + secret
    const topup = await Topup.findOne({
      type: "DEPOSIT",
      accountCode: "kbank",
      accountNumber: new RegExp(`${receiverDigits}$`, "i"),
      isActive: true,
      isSMS: true,
    }).lean();
    if (!topup)  return res.status(404).json({ success:false, message:"account_not_found" });
    if (secret !== topup.secret) return res.status(401).json({ success:false, message:"unauthorized" });

    // กันยิงซ้ำ: completed ซ้ำในช่วง ±2 นาที ด้วย amountCents
    const twoMinBefore = new Date(parsedDate.getTime() - 2*60*1000);
    const twoMinAfter  = new Date(parsedDate.getTime() + 2*60*1000);
    const dup = await Transaction.findOne({
      method: "kbank",
      amountCents: amtCents,
      status: "completed",
      createdAt: { $gte: twoMinBefore, $lte: twoMinAfter },
    }).lean();
    if (dup) {
      return res.json({ success:true, method:"kbank", deduped:true, amount:amt, timestamp });
    }

    // จับคู่กับ pending ที่สร้างจาก /topup/create
    const pendingTx = await Transaction.findOne({
      method: "kbank",
      amountCents: amtCents,
      status: "pending",
    });

    if (!pendingTx) {
      // เก็บไว้ให้แอดมินตรวจ (ยังไม่มีเจ้าของ)
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
      return res.json({ success:true, method:"kbank", amount:amt, timestamp, unmatched:true });
    }

    // มีเจ้าของ → เติมเครดิต
    const user = await User.findById(pendingTx.userId);
    if (!user) {
      pendingTx.note = "User not found at webhook";
      await pendingTx.save();
      return res.json({ success:true, method:"kbank", amount:amt, unmatched:true });
    }

    const newBalance = await user.addBalance(amt);
    pendingTx.set({
      status: "completed",
      matchedBy: "amount",
      matchedTxId: pendingTx._id,
      senderLast6: senderDigits,
      receiverLast6: receiverDigits,
      createdAt: parsedDate,
      paidAt: new Date(),
      username: user.username 
    });
    await pendingTx.save();
    // pendingTx.status = "completed";
    // pendingTx.matchedBy = "amount";
    // pendingTx.senderLast6 = senderDigits;
    // pendingTx.receiverLast6 = receiverDigits;
    // pendingTx.createdAt = parsedDate;
    // pendingTx.paidAt = new Date();
    // await pendingTx.save();

    console.log(`✅ KBANK Auto-Topup: ${user.username} +${amt} → ${newBalance}`);
    return res.json({ success:true, method:"kbank", username:user.username, amount:amt, status:"completed", timestamp });
  } catch (err) {
    console.error("❌ /kbank error:", err);
    return res.status(500).json({ success:false, message:"something_wrong" });
  }
});

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
    const target = Math.round(Number(amount) * 100) / 100;
    const tx = await Transaction.findOne({
      userId,
      method: "tw",
      amount: target, // ✅ เทียบยอดสุทธิ
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
