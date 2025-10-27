import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { jwtVerify } from "jose";
import { User } from "./models/User.js";
import { Topup } from "./models/Topup.js";

export const depositRouter = express.Router();

depositRouter.post("/truewallet", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message)
      return res
        .status(400)
        .json({ success: false, message: "missing_message" });
      return res
        .status(200)

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

    const user = await User.findOne({ username: sender_mobile });
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "user_not_found" });

    const newBalance = await user.addBalance(amount / 100);

    console.log(
      `✅ TrueWallet Deposit: user=${user.username}, amount=${
        amount / 100
      }, newBalance=${newBalance}`
    );

    return res.json({
      success: true,
      method: "truewallet",
      username: user.username,
      amount: amount / 100,
      balance: newBalance,
    });
  } catch (err) {
    console.error("❌ /truewallet error:", err);
    res.status(500).json({ success: false, message: "something_wrong" });
  }
});

depositRouter.post("/scb", async (req, res) => {
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
      accountNumber: new RegExp(`${senderDigits}$`),
    });
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "user_not_found" });

    const newBalance = await user.addBalance(amount);

    console.log(
      `✅ SCB Deposit: user=${user.username}, amount=${amount}, newBalance=${newBalance}`
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