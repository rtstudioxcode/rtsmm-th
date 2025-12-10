import { TgAccount } from "../models/TgAccount.js";

// ตรวจสอบสถานะของบัญชี Telegram และอัปเดตสถานะตามความเหมาะสม
export async function checkAndUpdateAccounts() {
  const accounts = await TgAccount.find().lean();

  const bulkOps = [];

  for (let acc of accounts) {
    const now = Date.now();

    // ถ้าบัญชีติดสถานะ COOLDOWN และยังไม่หมดเวลา
    if (acc.status === "COOLDOWN" && acc.cooldownUntil && acc.cooldownUntil > now) {
    //   console.log(`บัญชี ${acc.phone} อยู่ในสถานะ COOLDOWN`);
      continue;  // ไม่ต้องอัปเดตอะไรเพิ่มเติม
    }

    // ถ้าบัญชีติดสถานะ COOLDOWN แต่หมดเวลาแล้ว
    if (acc.status === "COOLDOWN" && acc.cooldownUntil && acc.cooldownUntil <= now) {
      bulkOps.push({
        updateOne: {
          filter: { _id: acc._id },
          update: { status: "READY", cooldownUntil: null }
        }
      });
    //   console.log(`บัญชี ${acc.phone} จะเปลี่ยนสถานะเป็น READY`);
    }

    // ถ้าบัญชีสถานะ READY แต่ยังค้างอยู่ในสถานะ COOLDOWN
    // ถ้าบัญชีไม่มีสถานะ COOLDOWN แต่ฟิลด์ cooldownUntil ยังไม่เป็น null, อัปเดตให้เป็น READY
    if (acc.status !== "COOLDOWN" && acc.cooldownUntil && acc.cooldownUntil <= now) {
      bulkOps.push({
        updateOne: {
          filter: { _id: acc._id },
          update: { status: "READY", cooldownUntil: null }
        }
      });
    //   console.log(`บัญชี ${acc.phone} เปลี่ยนสถานะเป็น READY`);
    }

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

    // ถ้าบัญชีติดสถานะ LOCKED และถึงเวลาที่จะปลดล็อก
    if (acc.status === "LOCKED" && acc.lockUntil && acc.lockUntil <= now) {
      bulkOps.push({
        updateOne: {
          filter: { _id: acc._id },
          update: { status: "READY", lockUntil: null }
        }
      });
    //   console.log(`บัญชี ${acc.phone} จะเปลี่ยนสถานะเป็น READY`);
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
}, 60000);  // 1000 ms = 1 วินาที (กรณีต้องการทดสอบให้เร็วขึ้น)
