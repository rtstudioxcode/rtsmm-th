// src/services/bonustimeExpiry.js
import { User } from "../models/User.js";
import { BonustimeUser } from "../models/BonustimeUser.js";
import { sendEmail } from "../lib/mailer.js";
import { config } from "../config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function parseThaiDate(str) {
  if (!str) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(str).trim());
  if (!m) return null;
  let [, d, mo, y] = m;
  let year = Number(y);
  if (year > 2400) year -= 543; // พ.ศ. → ค.ศ.
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

function calcRemainDays(doc) {
  const exp = calcExpiry(doc);
  if (!exp) return null;
  const now = new Date();
  const diff = exp.getTime() - now.getTime();
  return Math.ceil(diff / DAY_MS);
}

/**
 * เช็ก Bonustime ที่ใกล้หมดอายุแล้วส่งอีเมลแจ้งเตือน
 * เงื่อนไข:
 *   - serial_key มีค่า
 *   - ไม่ disabled
 *   - เหลือ 1–3 วัน
 *   - expiryNotifySent != true (ยังไม่เคยส่ง)
 */
export async function checkAndSendBonustimeExpiryMails(options = {}) {
  const { logPrefix = "[BonustimeExpiry]" } = options;

  const baseUrl = (config.publicBaseUrl || "https://rtsmm-th.com").replace(
    /\/+$/,
    ""
  );
  const brandName = config.brandName || "RTSMM-TH";

  // ดึง service ที่มี serial_key และยังไม่ถูก mark ว่าส่งเมลแล้ว
  const docs = await BonustimeUser.find({
    serial_key: { $nin: [null, ""] },
    LICENSE_DISABLED: { $ne: true },
    $or: [{ expiryNotifySent: { $exists: false } }, { expiryNotifySent: false }],
  }).lean();

  if (!docs.length) {
    return { sent: 0, users: 0 };
  }

  // กรองเฉพาะตัวที่เหลือ 1–3 วัน
  const bySerial = new Map(); // serial_key => [docs...]
  for (const doc of docs) {
    const remain = calcRemainDays(doc);
    if (remain == null) continue;
    if (remain < 1 || remain > 3) continue;

    if (!bySerial.has(doc.serial_key)) bySerial.set(doc.serial_key, []);
    bySerial.get(doc.serial_key).push({ doc, remain });
  }

  if (!bySerial.size) {
    return { sent: 0, users: 0 };
  }

  // หา user ตาม serial_key
  const serialKeys = [...bySerial.keys()];
  const users = await User.find({
    serial_key: { $in: serialKeys },
    email: { $exists: true, $ne: "" },
  }).lean();

  const userBySerial = new Map();
  for (const u of users) userBySerial.set(u.serial_key, u);

  let totalSent = 0;
  const docsToMark = [];

  for (const [serial, list] of bySerial.entries()) {
    const user = userBySerial.get(serial);
    if (!user || !user.email) continue;

    // สร้าง rows + เก็บ doc._id สำหรับ mark ส่งแล้ว
    let rowsHtml = "";
    for (const { doc, remain } of list) {
      const exp = calcExpiry(doc);
      const expStr = exp ? formatThaiDate(exp) : "-";

      const serviceName = doc.NAME || doc.tenantId || "-";
      const extendTarget =
        doc.tenantId || (doc._id ? String(doc._id) : "");

      const extendUrl = `${baseUrl}/bonustime?extend=${encodeURIComponent(
        extendTarget
      )}`;

      rowsHtml += `
        <tr>
          <td style="padding:6px 10px; border:1px solid #e5e7eb;">${serviceName}</td>
          <td style="padding:6px 10px; border:1px solid #e5e7eb; text-align:center;">${remain} วัน</td>
          <td style="padding:6px 10px; border:1px solid #e5e7eb; text-align:center;">${expStr}</td>
          <td style="padding:6px 10px; border:1px solid #e5e7eb; text-align:center;">
            <a href="${extendUrl}"
               style="display:inline-block; padding:6px 12px; border-radius:999px;
                      background:#facc15; color:#111827; font-size:13px; font-weight:600;
                      text-decoration:none;">
              ต่ออายุการใช้งาน
            </a>
          </td>
        </tr>
      `;

      docsToMark.push(doc._id);
    }

    if (!rowsHtml) continue;

    const html = `
      <div style="font-family:system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size:14px; color:#111827;">
        <p>สวัสดีคุณ ${user.displayName || user.username || user.email},</p>
        <p>
          ระบบตรวจพบว่า Service Bonustime ของคุณบางส่วนกำลังจะหมดอายุในไม่กี่วันนี้
          กรุณาตรวจสอบรายละเอียดด้านล่าง และต่ออายุก่อนหมดอายุเพื่อให้บอททำงานได้อย่างต่อเนื่อง:
        </p>

        <table style="border-collapse:collapse; margin:12px 0; width:100%; max-width:640px;">
          <thead>
            <tr style="background:#f3f4f6;">
              <th style="padding:6px 10px; border:1px solid #e5e7eb; text-align:left;">Service</th>
              <th style="padding:6px 10px; border:1px solid #e5e7eb; text-align:center;">เหลืออีก (วัน)</th>
              <th style="padding:6px 10px; border:1px solid #e5e7eb; text-align:center;">วันหมดอายุ (โดยประมาณ)</th>
              <th style="padding:6px 10px; border:1px solid #e5e7eb; text-align:center;">ดำเนินการ</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>

        <p style="margin-top:16px;">
          คุณสามารถต่ออายุได้ที่หน้า <strong>Bonustime &gt; ประวัติการสั่งซื้อ</strong> โดยปุ่ม
          <strong>“ต่ออายุการใช้งาน”</strong> ของแต่ละ Service
        </p>

        <p style="font-size:12px; color:#6b7280; margin-top:24px;">
          อีเมลนี้เป็นการแจ้งเตือนอัตโนมัติจากระบบ ${brandName} หากคุณต่ออายุเรียบร้อยแล้ว สามารถมองข้ามอีเมลฉบับนี้ได้
        </p>
      </div>
    `;

    try {
      await sendEmail({
        to: user.email,
        subject: `แจ้งเตือน Service Bonustime ใกล้หมดอายุ`,
        html,
      });
      totalSent++;
      console.log(`${logPrefix} sent expiry mail to ${user.email}`);
    } catch (err) {
      console.error(`${logPrefix} sendEmail error to ${user.email}:`, err);
    }
  }

  // mark ว่าส่งแล้ว
  if (docsToMark.length) {
    await BonustimeUser.updateMany(
      { _id: { $in: docsToMark } },
      {
        $set: {
          expiryNotifySent: true,
          expiryNotifyLastSentAt: new Date(),
        },
      }
    );
  }

  return { sent: totalSent, users: userBySerial.size };
}
