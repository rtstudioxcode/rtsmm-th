import { TgAccount } from "../models/TgAccount.js";

// ตรวจสอบสถานะของบัญชี Telegram และอัปเดตสถานะตามความเหมาะสม
export async function checkAndUpdateAccounts() {
  const accounts = await TgAccount.find().lean();

  const bulkOps = [];

  for (let acc of accounts) {
    const now = Date.now();

    // เพิ่มเงื่อนไขใหม่:
    // ถ้าบัญชีเป็น READY แต่มีเวลาติด COOLDOWN (มี cooldownUntil) ให้เปลี่ยนสถานะเป็น COOLDOWN
    if (acc.status === "READY" && acc.cooldownUntil && acc.cooldownUntil > now) {
      bulkOps.push({
        updateOne: {
          filter: { _id: acc._id },
          update: { status: "COOLDOWN" }
        }
      });
    //   console.log(`บัญชี ${acc.phone} จะเปลี่ยนสถานะเป็น COOLDOWN`);
    }

    // ===== 1) LOCKED ก่อนเสมอ =====
    if (acc.lockUntil) {
      const lockDue = toTs(acc.lockUntil) <= now;

      if (!lockDue) {
        // (1) ยังไม่หมดเวลา → บังคับเป็น LOCKED
        if (acc.status !== "LOCKED") {
          bulkOps.push({
            updateOne: {
              filter: { _id: acc._id, status: { $ne: "LOCKED" } },
              update: { $set: { status: "LOCKED" } }
            }
          });
        }
      } else {
        if (acc.status === "LOCKED") {
          // (2) หมดเวลา & อยู่ใน LOCKED → กลับ READY + ล้างฟิลด์
          bulkOps.push({
            updateOne: {
              filter: { _id: acc._id, status: "LOCKED" },
              update: { $set: { status: "READY" }, $unset: { lockUntil: "", lastError: "" } }
            }
          });
        } else {
          // (3) ไม่ได้อยู่ LOCKED แต่ lockUntil ค้าง & หมดเวลา → ล้างทิ้งเฉย ๆ
          bulkOps.push({
            updateOne: {
              filter: { _id: acc._id, status: { $ne: "LOCKED" } },
              update: { $unset: { lockUntil: "", lastError: "" } }
            }
          });
        }
      }
    }

    // ===== 2) COOLDOWN รองลงมา =====
    if (acc.cooldownUntil) {
      const cdDue = toTs(acc.cooldownUntil) <= now;

      if (!cdDue) {
        // (1) ยังไม่หมดเวลา → บังคับเป็น COOLDOWN
        if (acc.status !== "COOLDOWN" && acc.status !== "LOCKED") { // อย่าไปทับ LOCKED
          bulkOps.push({
            updateOne: {
              filter: { _id: acc._id, status: { $nin: ["COOLDOWN", "LOCKED"] } },
              update: { $set: { status: "COOLDOWN" } }
            }
          });
        }
      } else {
        if (acc.status === "COOLDOWN") {
          // (2) หมดเวลา & อยู่ใน COOLDOWN → กลับ READY + ล้างฟิลด์
          bulkOps.push({
            updateOne: {
              filter: { _id: acc._id, status: "COOLDOWN" },
              update: { $set: { status: "READY" }, $unset: { cooldownUntil: "", lastError: "" } }
            }
          });
        } else {
          // (3) ไม่ได้อยู่ COOLDOWN แต่ cooldownUntil ค้าง & หมดเวลา → ล้างทิ้งเฉย ๆ
          bulkOps.push({
            updateOne: {
              filter: { _id: acc._id, status: { $ne: "COOLDOWN" } },
              update: { $unset: { cooldownUntil: "", lastError: "" } }
            }
          });
        }
      }
    }
  }

  // ใช้ bulkWrite เพื่อประสิทธิภาพที่ดีขึ้นในการอัปเดตหลายๆ บัญชีพร้อมกัน
  if (bulkOps.length > 0) {
    try {
      await TgAccount.bulkWrite(bulkOps);
      console.log(`อัปเดตสถานะบัญชีทั้งหมดที่ต้องการ`);
    } catch (err) {
      console.error("เกิดข้อผิดพลาดในการอัปเดตบัญชี:", err);
    }
  }
}

// เรียกใช้ฟังก์ชันนี้ทุกๆ 1 นาที
setInterval(() => {
  checkAndUpdateAccounts();
}, 5000);  // 1000 ms = 1 วินาที (กรณีต้องการทดสอบให้เร็วขึ้น)
