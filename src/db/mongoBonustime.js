// src/db/mongoBonustime.js
import mongoose from "mongoose";
import { config } from "../config.js";

let bonustimeConn = null;

export function getBonustimeDb() {
  if (bonustimeConn) return bonustimeConn;

  const uri = config?.bonustime?.mongoUri;
  // const dbName = config?.bonustime?.dbName || "rtautobot";

  if (!uri) {
    console.error("❌ Bonustime Mongo URI missing in config.js");
    throw new Error("Bonustime Mongo URI missing");
  }

  bonustimeConn = mongoose.createConnection(uri, {
    // dbName,
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  // bonustimeConn.on("connected", () => {
  //   console.log("🔥 Bonustime DB connected:", dbName);
  // });

  bonustimeConn.on("error", (err) => {
    console.error("❌ Bonustime DB error:", err);
  });

  return bonustimeConn;
}
