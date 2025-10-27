import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import { jwtVerify } from "jose";

import { User } from "../models/User.js";
import { Topup } from "../models/Topup.js";
import Transaction from "../models/Transaction.js"; // ✅ ULID-based transaction model

export const topupRouter = express.Router();

/* ───────────────────────────────
   GET /topup
──────────────────────────────── */
topupRouter.get("/", async (req, res) => {
  const userId = req?.session?.userId;
  const user = await User.findById(userId);
  const webWallet = await Topup.findOne({
    accountCode: user.bankAccounts[0].accountCode,
  });

  res.render("topup/index", { title: "เติมเงิน", user, webWallet });
});

/* ───────────────────────────────
   POST /truewallet/gen/link
──────────────────────────────── */
topupRouter.post("/truewallet/gen/link", async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req?.session?.userId;
    const user = await User.findById(userId);
    const webWallet = await Topup.findOne({
      accountCode: user.bankAccounts[0].accountCode,
    });

    const response = await axios.post(
      "https://apis.truemoneyservices.com/utils/v1/transfer-link-generator",
      {
        mobile_number: webWallet.accountNumber,
        amount: amount.toString(),
        message: "",
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.TW_GEN_LINK_SECRET}`,
          "Content-Type": "application/json",
        },
      }
    );

    return res.json({ url: response.data.data.url });
  } catch (err) {
    console.error("❌ /truewallet/gen/link error:", err);
    res.status(500).json({ success: false, message: "something_wrong" });
  }
});

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

    if (!topup.isAuto)
      return res
        .status(500)
        .json({ success: false, message: "auto_mode_disabled" });

    const user = await User.findOne({
      bankAccounts: { $elemMatch: { accountNumber: sender_mobile } },
    });

    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "user_not_found" });

    const added = amount / 100;
    const newBalance = await user.addBalance(added);

    // ✅ Record transaction

    console.log(user._id);
    await Transaction.create({
      userId: user._id,
      method: "truewallet",
      amount: added,
      currency: "THB",
      status: "completed",
    });

    console.log(
      `✅ TrueWallet Deposit: ${user.username} +${added} THB → ${newBalance}`
    );

    return res.json({
      success: true,
      method: "truewallet",
      username: user.username,
      amount: added,
      balance: newBalance,
    });
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
    const { message, secret } = req.body;
    if (!message || !secret)
      return res
        .status(400)
        .json({ success: false, message: "missing_parameters" });

    const regex =
      /(\d{2})\/(\d{2})@(\d{2}):(\d{2})\s+([\d,]+\.\d{2})\s+จาก([A-Z]+)\/x(\d+).*เข้าx(\d+)/;
    const match = message.match(regex);
    if (!match)
      return res
        .status(400)
        .json({ success: false, message: "invalid_message_format" });

    const [
      ,
      day,
      month,
      hour,
      minute,
      amountStr,
      ,
      senderLast6,
      receiverLast6,
    ] = match;
    const year = new Date().getFullYear();
    const timestamp = new Date(
      `${year}-${month}-${day}T${hour}:${minute}:00+07:00`
    );
    const amount = parseFloat(amountStr.replace(/,/g, ""));
    const senderDigits = senderLast6.trim();
    const receiverDigits = receiverLast6.trim();

    const topup = await Topup.findOne({
      type: "DEPOSIT",
      accountCode: "scb",
      accountNumber: new RegExp(`${receiverDigits}$`),
      isActive: true,
      isSMS: true,
    }).lean();

    if (!topup)
      return res
        .status(404)
        .json({ success: false, message: "account_not_found" });

    if (secret !== topup.secret)
      return res.status(401).json({ success: false, message: "unauthorized" });

    if (!topup.isAuto)
      return res
        .status(500)
        .json({ success: false, message: "auto_mode_disabled" });

    const user = await User.findOne({
      bankAccounts: {
        $elemMatch: { accountNumber: new RegExp(`${senderDigits}$`) },
      },
    });

    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "user_not_found" });

    const newBalance = await user.addBalance(amount);

    // ✅ Record transaction
    await Transaction.create({
      userId: user._id,
      method: "scb",
      amount,
      currency: "THB",
      status: "completed",
    });

    console.log(
      `✅ SCB Deposit: ${user.username} +${amount} THB → ${newBalance}`
    );

    return res.json({
      success: true,
      method: "scb",
      username: user.username,
      amount,
      balance: newBalance,
      timestamp,
    });
  } catch (err) {
    console.error("❌ /scb error:", err);
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

    if (!userId || !amount)
      return res
        .status(400)
        .json({ success: false, message: "missing_parameters" });

    console.log(userId, amount);

    const tx = await Transaction.findOne({
      userId,
      method: "truewallet",
      amount,
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
    } else {
      return res.json({
        success: true,
        verified: false,
        message: "ยังไม่พบรายการเติมเงินในระบบ โปรดลองอีกครั้งในอีกสักครู่",
      });
    }
  } catch (err) {
    console.error("❌ /truewallet/check error:", err);
    res.status(500).json({ success: false, message: "something_wrong" });
  }
});
