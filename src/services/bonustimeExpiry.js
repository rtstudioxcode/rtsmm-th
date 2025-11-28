// src/services/bonustimeExpiry.js
import { BonustimeUser } from "../models/BonustimeUser.js";
import { User } from "../models/User.js";
import { sendEmail } from "../lib/mailer.js";
import { config } from "../config.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SITE_URL = config?.siteUrl || "https://rtsmm-th.com";

// ---------- helper: แปลงวันที่ไทย ----------
function parseThaiDate(str) {
  if (!str) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(str).trim());
  if (!m) return null;
  let [, d, mo, y] = m;
  let year = Number(y);
  if (year > 2400) year -= 543; // พ.ศ. -> ค.ศ.
  return new Date(year, Number(mo) - 1, Number(d));
}

function formatThaiDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear() + 543;
  return `${dd}/${mm}/${yyyy}`;
}

function calcExpiry(doc) {
  const start = parseThaiDate(doc.LICENSE_START_DATE);
  const duration = Number(doc.LICENSE_DURATION_DAYS) || 0;
  if (!start || !duration) return null;
  return new Date(start.getTime() + duration * DAY_MS);
}

function calcRemainDaysFromDoc(doc) {
  const exp = calcExpiry(doc);
  if (!exp) return null;
  const now = new Date();
  const diff = exp.getTime() - now.getTime();
  return Math.ceil(diff / DAY_MS);
}

function normalizeUrl(u) {
  if (!u) return "";
  const s = String(u).trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return "https://" + s;
}

// ---------- main ----------
export async function checkAndSendBonustimeExpiryMails(opts = {}) {
  const logPrefix = opts.logPrefix || "[BonustimeExpiry]";
  const now = new Date();

  // หา service ที่มี serial_key, ยังไม่ disabled และยังไม่เคยส่งเมลเตือน "วันนี้"
  const docs = await BonustimeUser.find({
    serial_key: { $nin: [null, ""] },
    LICENSE_DISABLED: { $ne: true },
    expiryNotifySent: {
      $ne: new Date().toISOString().slice(0, 10),
    },
  }).lean();

  const targets = [];
  for (const d of docs) {
    const remain = calcRemainDaysFromDoc(d);
    if (remain == null) continue;

    // ตรวจสอบว่าไม่เคยส่งในวันนี้
    const lastSent = d.expiryNotifySent ? new Date(d.expiryNotifySent) : null;
    const today = new Date();

    if (
      lastSent &&
      lastSent.toISOString().slice(0, 10) ===
        today.toISOString().slice(0, 10)
    ) {
      continue; // เคยส่งวันนี้แล้ว
    }

    // เงื่อนไขใหม่:
    //   เหลือ 1–3 วัน → เมลเตือนใกล้หมดอายุ
    //   เหลือ 0, -1, -2, -3 วัน → เมล "หมดอายุแล้ว"
    if (remain === 3 || remain === 2 || remain === 1 || remain === 0 || remain === -1 || remain === 2 || remain === -3) {
        targets.push({ doc: d, remainDays: remain });
    }
  }

  if (!targets.length) {
    return { ok: true, sent: 0, users: 0 };
  }

  const userCache = new Map();
  const userIdsSent = new Set();

  let sent = 0;

  for (const { doc, remainDays } of targets) {
    let user = userCache.get(doc.serial_key);
    if (user === undefined) {
      user = await User.findOne({ serial_key: doc.serial_key }).lean();
      userCache.set(doc.serial_key, user || null);
    }

    if (!user || !user.email) {
      console.warn(
        `${logPrefix} skip tenant=${doc.tenantId} serial=${doc.serial_key} (no user/email)`
      );
      continue;
    }

    const expiry = calcExpiry(doc);
    const endStr = expiry ? formatThaiDate(expiry) : "-";
    const startStr = doc.LICENSE_START_DATE || "-";

    const serviceName = doc.NAME || "ไม่ระบุชื่อ";
    const tenantLabel = doc.tenantId || "-";
    const serialKey = doc.serial_key || "-";

    const extendUrl = `${SITE_URL}/bonustime?extend=${encodeURIComponent(
      doc.tenantId || ""
    )}`;

    const loginUrl = doc.LOGIN_URL ? normalizeUrl(doc.LOGIN_URL) : "";
    const lineUrl = doc.LINE_ADMIN ? normalizeUrl(doc.LINE_ADMIN) : "";
    const webhook = doc.LINK ? normalizeUrl(doc.LINK) : "";

    const isExpiredMail = remainDays <= 0 && remainDays >= -3;
    const daysLate = Math.abs(remainDays);

    // ===== ข้อความตามสถานะ =====
    let subject;
    let statusLine;
    let introHtml;

    if (isExpiredMail) {
      // หมดอายุแล้ว (0, -1, -2, -3)
      subject = `แจ้งเตือน Service (${tenantLabel}) — ${serviceName} หมดอายุแล้ว`;
      if (remainDays === 0) {
        statusLine = "หมดอายุวันนี้";
      } else {
        statusLine = `หมดอายุมาประมาณ ${daysLate} วันแล้ว`;
      }

      introHtml = `
        <p style="margin:0 0 16px;font-size:14px;color:#9ca3af;line-height:1.6;">
          ระบบตรวจพบว่า Service (${tenantLabel}) ของคุณ<strong>หมดอายุแล้ว</strong>
          เพื่อให้การทำงานของบอทกลับมาใช้งานได้ตามปกติ แนะนำให้ต่ออายุการใช้งานโดยเร็วครับ
        </p>
      `;
    } else {
      // เหลือ 1–3 วัน (เตือนใกล้หมดอายุ)
      subject = `แจ้งเตือนการหมดอายุ Service (${tenantLabel}) — ${serviceName} (เหลืออีก ${remainDays} วัน)`;
      statusLine = `เหลือระยะเวลาใช้งานอีก ${remainDays} วัน`;

      introHtml = `
        <p style="margin:0 0 16px;font-size:14px;color:#9ca3af;line-height:1.6;">
          ระบบตรวจพบว่า Service (${tenantLabel}) - ${serviceName} ของคุณกำลังเข้าใกล้วันหมดอายุ เพื่อไม่ให้การทำงานของบอทสะดุด
          แนะนำให้ต่ออายุล่วงหน้าอย่างน้อย <strong>1 วัน</strong> ครับ
        </p>
      `;
    }

    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#020617;padding:32px 16px;color:#e5e7eb;">
  <div style="max-width:720px;margin:0 auto;">

    <div style="background:#020617;border-radius:24px;border:1px solid #111827;padding:28px 24px;">
      <div style="text-align: center; margin-bottom: 3px;">
        <img src="${SITE_URL}/static/assets/logo/logo-rtssm-th.png" alt="RTSMM-TH" style="height:200px; margin-bottom:3px;" />
      </div>

      <h1 style="margin: 4px 0 8px; font-size:20px; color:#fde68a;">
        แจ้งเตือนการหมดอายุ Service (${tenantLabel})
      </h1>

      ${introHtml}

      <div style="margin:18px 0 14px;font-size:14px;line-height:1.7;">
        <div><strong>Service:</strong> ${tenantLabel}</div>
        <div><strong>เว็บ:</strong> ${serviceName}</div>
        <div><strong>Serial Key:</strong> ${serialKey}</div>
        <div><strong>ช่วงเวลาการใช้งาน:</strong> ${startStr} – ${endStr}</div>
        <div><strong>สถานะปัจจุบัน:</strong> ${statusLine}</div>
      </div>

      <div style="text-align:center;margin:24px 0 18px;">
        <a href="${extendUrl}"
           style="display:inline-block;padding:12px 32px;border-radius:999px;
                  background:#facc15;color:#000;font-weight:600;font-size:14px;
                  text-decoration:none;">
          ต่ออายุเซิร์ฟ Bonustime
        </a>
      </div>

      <p style="margin:0 0 8px;font-size:13px;color:#9ca3af;line-height:1.6;">
        เมื่อต้องการต่ออายุ ให้คลิกปุ่ม <strong>“ต่ออายุเซิร์ฟ Bonustime”</strong> ระบบจะพาคุณไปยังหน้า
        <strong>Bonustime &gt; ประวัติการสั่งซื้อ</strong> ในเว็บ RTSMM-TH แล้วเปิดหน้าต่าง
        <strong>“ต่ออายุการใช้งาน”</strong> ของ Service นี้ให้อัตโนมัติ
      </p>
      <p style="margin:0 0 16px;font-size:13px;color:#9ca3af;line-height:1.6;">
        หากปล่อยให้เซิร์ฟหมดอายุ BOT อาจหยุดตอบลูกค้าชั่วคราว และลูกค้าอาจไม่ได้รับข้อมูลตามปกติ
        จึงแนะนำให้ต่ออายุให้เรียบร้อยเพื่อความต่อเนื่องของระบบของคุณ
      </p>

      <div style="margin-top:20px;padding-top:10px;border-top:1px dashed #1f2937;font-size:12px;color:#6b7280;">
        <div style="margin-bottom:4px;"><strong>ลิงก์ที่อยู่ใน Service นี้:</strong></div>
        ${
          loginUrl
            ? `<div><a href="${loginUrl}" style="color:#60a5fa;" target="_blank" rel="noopener">${doc.LOGIN_URL}</a></div>`
            : ""
        }
        ${
          lineUrl
            ? `<div><a href="${lineUrl}" style="color:#60a5fa;" target="_blank" rel="noopener">${doc.LINE_ADMIN}</a></div>`
            : ""
        }
        <div style="margin-bottom:4px;"><strong>ลิงก์เชื่อมต่อ Webhook ของ Service นี้:</strong></div>
        ${
          webhook
            ? `<div><a href="${webhook}" style="color:#60a5fa;" target="_blank" rel="noopener">${doc.LINK}</a></div>`
            : ""
        }
        <p style="margin-top:14px;font-size:11px;color:#4b5563;line-height:1.6;">
          อีเมลนี้เป็นการแจ้งเตือนอัตโนมัติจากระบบ RTSMM-TH หากคุณได้รับโดยไม่ได้เกี่ยวข้องกับบริการนี้
          สามารถมองข้ามอีเมลฉบับนี้ได้ครับ
        </p>
      </div>
    </div>
  </div>
</div>
    `.trim();

    const textStatus =
      isExpiredMail && remainDays < 0
        ? `หมดอายุมาประมาณ ${daysLate} วันแล้ว`
        : isExpiredMail && remainDays === 0
        ? "หมดอายุวันนี้"
        : `เหลือระยะเวลาใช้งานอีก ${remainDays} วัน`;

    const text = [
      "แจ้งเตือนการหมดอายุ Service Bonustime",
      "",
      `Service: (${tenantLabel}) — ${serviceName}`,
      `Serial Key: ${serialKey}`,
      `ช่วงเวลาการใช้งาน: ${startStr} – ${endStr}`,
      `สถานะปัจจุบัน: ${textStatus}`,
      "",
      `ต่ออายุได้ที่: ${extendUrl}`,
    ].join("\n");

    try {
      await sendEmail({
        to: user.email,
        subject,
        html,
        text,
      });

      await BonustimeUser.updateOne(
        { _id: doc._id },
        { $set: { expiryNotifySent: new Date().toISOString() } }
      );

      sent += 1;
      userIdsSent.add(String(user._id));
      console.log(
        `${logPrefix} sent to ${user.email} for tenant=${tenantLabel}, remain=${remainDays}d`
      );
    } catch (err) {
      console.error(
        `${logPrefix} failed to send email to ${user.email} for tenant=${tenantLabel}`,
        err
      );
    }
  }

  return { ok: true, sent, users: userIdsSent.size };
}

// เก่าไม่ใช้แล้วแต่เก็บไว้ก่อน
// export async function checkAndSendBonustimeExpiryMails(opts = {}) {
//   const logPrefix = opts.logPrefix || "[BonustimeExpiry]";
//   const now = new Date();

//   // หา service ที่มี serial_key, ยังไม่ disabled และยังไม่เคยส่งเมลเตือน
//   const docs = await BonustimeUser.find({
//     serial_key: { $nin: [null, ""] },
//     LICENSE_DISABLED: { $ne: true },
//     expiryNotifySent: { 
//         $ne: new Date().toISOString().slice(0, 10)
//     }
//   }).lean();

//   const targets = [];
//   for (const d of docs) {
//     const remain = calcRemainDaysFromDoc(d);
//     if (remain == null) continue;

//     // ตรวจสอบว่าไม่เคยส่งในวันนี้
//     const lastSent = d.expiryNotifySent ? new Date(d.expiryNotifySent) : null;
//     const today = new Date();

//     if (lastSent && lastSent.toISOString().slice(0, 10) === today.toISOString().slice(0, 10)) {
//         // console.log(`[BonustimeExpiry] Email already sent today for ${d.serial_key}, skipping.`);
//         continue; // ข้ามการส่ง
//     }

//     // เงื่อนไข: เหลือ 1–3 วัน
//     if (remain === 3 || remain === 2 || remain === 1 || remain === 0) {
//         targets.push({ doc: d, remainDays: remain });
//     }
//   }

//   if (!targets.length) {
//     // console.log(`${logPrefix} no expiring services (1–3 days)`);
//     return { ok: true, sent: 0, users: 0 };
//   }

//   const userCache = new Map();
//   const userIdsSent = new Set();

//   let sent = 0;

//   for (const { doc, remainDays } of targets) {
//     let user = userCache.get(doc.serial_key);
//     if (user === undefined) {
//         user = await User.findOne({ serial_key: doc.serial_key }).lean();
//         userCache.set(doc.serial_key, user || null);
//     }

//     if (!user || !user.email) {
//         console.warn(`${logPrefix} skip tenant=${doc.tenantId} serial=${doc.serial_key} (no user/email)`);
//         continue;
//     }

//     const expiry = calcExpiry(doc);
//     const endStr = expiry ? formatThaiDate(expiry) : "-";
//     const startStr = doc.LICENSE_START_DATE || "-";

//     const serviceName = doc.NAME || "ไม่ระบุชื่อ";
//     const tenantLabel = doc.tenantId || "-";
//     const serialKey = doc.serial_key || "-";

//     const extendUrl = `${SITE_URL}/bonustime?extend=${encodeURIComponent(
//       doc.tenantId || ""
//     )}`;

//     const loginUrl = doc.LOGIN_URL ? normalizeUrl(doc.LOGIN_URL) : "";
//     const lineUrl = doc.LINE_ADMIN ? normalizeUrl(doc.LINE_ADMIN) : "";
//     const webhook = doc.LINK ? normalizeUrl(doc.LINK) : "";

//     const subject = `แจ้งเตือนการหมดอายุ Service (${tenantLabel}) — ${serviceName} (เหลืออีก ${remainDays} วัน)`;

//     const html = `
// <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#020617;padding:32px 16px;color:#e5e7eb;">
//   <div style="max-width:720px;margin:0 auto;">

//     <div style="background:#020617;border-radius:24px;border:1px solid #111827;padding:28px 24px;">
//       <div style="text-align: center; margin-bottom: 3px;">
//         <img src="${SITE_URL}/static/assets/logo/logo-rtssm-th.png" alt="RTSMM-TH" style="height:200px; margin-bottom:3px;" />
//       </div>

//       <h1 style="margin: 4px 0 8px; font-size:20px; color:#fde68a;">
//         แจ้งเตือนการหมดอายุ Service (${tenantLabel})
//       </h1>

//       <p style="margin:0 0 16px;font-size:14px;color:#9ca3af;line-height:1.6;">
//         ระบบตรวจพบว่าService (${tenantLabel}) ของคุณกำลังเข้าใกล้วันหมดอายุ เพื่อไม่ให้การทำงานของบอทสะดุด
//         แนะนำให้ต่ออายุล่วงหน้าอย่างน้อย <strong>1 วัน</strong> ครับ
//       </p>

//       <div style="margin:18px 0 14px;font-size:14px;line-height:1.7;">
//         <div><strong>Service:</strong> ${tenantLabel}</div>
//         <div><strong>เว็บ:</strong> ${serviceName}</div>
//         <div><strong>Serial Key:</strong> ${serialKey}</div>
//         <div><strong>ช่วงเวลาการใช้งาน:</strong> ${startStr} – ${endStr}</div>
//         <div><strong>สถานะปัจจุบัน:</strong> เหลือระยะเวลาใช้งานอีก ${remainDays} วัน</div>
//       </div>

//       <div style="text-align:center;margin:24px 0 18px;">
//         <a href="${extendUrl}"
//            style="display:inline-block;padding:12px 32px;border-radius:999px;
//                   background:#facc15;color:#000;font-weight:600;font-size:14px;
//                   text-decoration:none;">
//           ต่ออายุเซิร์ฟ Bonustime
//         </a>
//       </div>

//       <p style="margin:0 0 8px;font-size:13px;color:#9ca3af;line-height:1.6;">
//         เมื่อต้องการต่ออายุ ให้คลิกปุ่ม <strong>“ต่ออายุเซิร์ฟ Bonustime”</strong> ระบบจะพาคุณไปยังหน้า
//         <strong>Bonustime &gt; ประวัติการสั่งซื้อ</strong> ในเว็บ RTSMM-TH แล้วเปิดหน้าต่าง
//         <strong>“ต่ออายุการใช้งาน”</strong> ของ Service นี้ให้อัตโนมัติ
//       </p>
//       <p style="margin:0 0 16px;font-size:13px;color:#9ca3af;line-height:1.6;">
//         หากปล่อยให้เซิร์ฟหมดอายุ BOT อาจหยุดตอบลูกค้าชั่วคราว และลูกค้าอาจไม่ได้รับข้อมูลตามปกติ
//         จึงแนะนำให้ต่ออายุก่อนวันหมดอายุอย่างน้อย 1 วัน เพื่อความต่อเนื่องของระบบของคุณ
//       </p>

//       <div style="margin-top:20px;padding-top:10px;border-top:1px dashed #1f2937;font-size:12px;color:#6b7280;">
//         <div style="margin-bottom:4px;"><strong>ลิงก์ที่อยู่ใน Service นี้:</strong></div>
//         ${
//           loginUrl
//             ? `<div><a href="${loginUrl}" style="color:#60a5fa;" target="_blank" rel="noopener">${doc.LOGIN_URL}</a></div>`
//             : ""
//         }
//         ${
//           lineUrl
//             ? `<div><a href="${lineUrl}" style="color:#60a5fa;" target="_blank" rel="noopener">${doc.LINE_ADMIN}</a></div>`
//             : ""
//         }
//         <div style="margin-bottom:4px;"><strong>ลิงก์เชื่อมต่อ Webhook ของ Service นี้:</strong></div>
//         ${
//           webhook
//             ? `<div><a href="${webhook}" style="color:#60a5fa;" target="_blank" rel="noopener">${doc.LINK}</a></div>`
//             : ""
//         }
//         <p style="margin-top:14px;font-size:11px;color:#4b5563;line-height:1.6;">
//         อีเมลนี้เป็นการแจ้งเตือนอัตโนมัติจากระบบ RTSMM-TH หากคุณได้รับโดยไม่ได้เกี่ยวข้องกับบริการนี้
//         สามารถมองข้ามอีเมลฉบับนี้ได้ครับ
//       </p>
//       </div>
//     </div>
//   </div>
// </div>
//     `.trim();

//     const text = [
//       "แจ้งเตือนการหมดอายุ Service Bonustime",
//       "",
//       `Service: (${tenantLabel}) — ${serviceName}`,
//       `Serial Key: ${serialKey}`,
//       `ช่วงเวลาการใช้งาน: ${startStr} – ${endStr}`,
//       `สถานะปัจจุบัน: เหลือระยะเวลาใช้งานอีก ${remainDays} วัน`,
//       "",
//       `ต่ออายุได้ที่: ${extendUrl}`,
//     ].join("\n");

//     try {
//       await sendEmail({
//         to: user.email,
//         subject,
//         html,
//         text,
//       });

//       await BonustimeUser.updateOne(
//         { _id: doc._id },
//         { $set: { expiryNotifySent: new Date().toISOString() } }
//       );

//       sent += 1;
//       userIdsSent.add(String(user._id));
//       console.log(
//         `${logPrefix} sent to ${user.email} for tenant=${tenantLabel}, remain=${remainDays}d`
//       );
//     } catch (err) {
//       console.error(
//         `${logPrefix} failed to send email to ${user.email} for tenant=${tenantLabel}`,
//         err
//       );
//     }
//   }

//   return { ok: true, sent, users: userIdsSent.size };
// }