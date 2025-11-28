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

  // เตรียม options แยก (เผื่ออนาคตจะใส่ dbName หรือ config อื่นเพิ่ม)
  const opts = {};
  // ถ้าอยากใช้ dbName แยก collection จริง ๆ ค่อยเปิดบรรทัดนี้
  // if (dbName) opts.dbName = dbName;

  bonustimeConn = mongoose.createConnection(uri, opts);

  // bonustimeConn.on("connected", () => {
  //   console.log("🔥 Bonustime DB connected:", dbName);
  // });

  bonustimeConn.on("error", (err) => {
    console.error("❌ Bonustime DB error:", err);
  });

  return bonustimeConn;
}
