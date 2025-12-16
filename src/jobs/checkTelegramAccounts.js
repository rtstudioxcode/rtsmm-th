import { TgAccount } from "../models/TgAccount.js";

// แปลง Date / string / number -> timestamp (ms)
function toTs(v) {
  if (!v) return NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

// ตรวจสอบสถานะของบัญชี Telegram และอัปเดตสถานะตามความเหมาะสม
export async function checkAndUpdateAccounts() {
  const accounts = await TgAccount.find().lean();
  const bulkOps = [];
  const now = Date.now();

  for (let acc of accounts) {
    // เพิ่มเงื่อนไขใหม่:
    // ถ้าบัญชีเป็น READY แต่มีเวลาติด COOLDOWN (มี cooldownUntil) ให้เปลี่ยนสถานะเป็น COOLDOWN
    if (acc.status === "READY" && acc.cooldownUntil && toTs(acc.cooldownUntil) > now) {
      bulkOps.push({
        updateOne: {
          filter: { _id: acc._id, status: "READY" },
          update: { $set: { status: "COOLDOWN" } } // ✅ ต้อง $set
        }
      });
    }

    // ===== 1) LOCKED ก่อนเสมอ =====
    if (acc.lockUntil) {
      const lockTs = toTs(acc.lockUntil);
      const lockDue = Number.isFinite(lockTs) ? (lockTs <= now) : true; // ถ้าเพี้ยน ให้ถือว่าหมดเวลาเพื่อเคลียร์

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
              update: { $set: { status: "READY" }, $unset: { lockUntil: "", lastError: "", invitesToday: ""  } }
            }
          });
        } else {
          // (3) ไม่ได้อยู่ LOCKED แต่ lockUntil ค้าง & หมดเวลา → ล้างทิ้งเฉย ๆ
          bulkOps.push({
            updateOne: {
              filter: { _id: acc._id, status: { $ne: "LOCKED" } },
              update: { $unset: { lockUntil: "", lastError: "", invitesToday: "" } }
            }
          });
        }
      }
    }

    // ===== 2) COOLDOWN รองลงมา =====
    if (acc.cooldownUntil) {
      const cdTs = toTs(acc.cooldownUntil);
      const cdDue = Number.isFinite(cdTs) ? (cdTs <= now) : true; // ถ้าเพี้ยน ให้ถือว่าหมดเวลาเพื่อเคลียร์

      if (!cdDue) {
        // (1) ยังไม่หมดเวลา → บังคับเป็น COOLDOWN (อย่าไปทับ LOCKED)
        if (acc.status !== "COOLDOWN" && acc.status !== "LOCKED") {
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
              update: { $set: { status: "READY" }, $unset: { cooldownUntil: "", lastError: "", invitesToday: "" } }
            }
          });
        } else {
          // (3) ไม่ได้อยู่ COOLDOWN แต่ cooldownUntil ค้าง & หมดเวลา → ล้างทิ้งเฉย ๆ
          bulkOps.push({
            updateOne: {
              filter: { _id: acc._id, status: { $ne: "COOLDOWN" } },
              update: { $unset: { cooldownUntil: "", lastError: "", invitesToday: "" } }
            }
          });
        }
      }
    }
  }

  if (bulkOps.length > 0) {
    try {
      await TgAccount.bulkWrite(bulkOps);
      console.log(`อัปเดตสถานะบัญชีทั้งหมดที่ต้องการ (${bulkOps.length})`);
    } catch (err) {
      console.error("เกิดข้อผิดพลาดในการอัปเดตบัญชี:", err);
    }
  }
}

// ตั้งใจ 1 นาทีให้ใช้ 60000
setInterval(() => {
  checkAndUpdateAccounts();
}, 5000);

// ถ้าจะเทสต์เร็ว ค่อยชั่วคราวเป็น 5000 แบบเดิม
