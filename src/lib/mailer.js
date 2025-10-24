// mailer.js
// ------------------------------------------------------------
// 1) Imports & Config
// ------------------------------------------------------------
import nodemailer from 'nodemailer';
import { config } from '../config.js';

// ควรมี config.mail โครงสร้างประมาณนี้
// config.mail = {
//   host, port, user, pass, from,
//   secure,                 // true/false (ถ้าไม่ได้ส่ง จะ auto จาก port)
//   poolMaxConnections: 5,
//   poolMaxMessages: 100,
//   rateLimit: 20,          // ต่อ 1 นาที (optional)
//   debug: false,
//   dkim: { domainName, keySelector, privateKey } // (optional)
// };

let transporter;

// ------------------------------------------------------------
// 2) Helper: สร้าง/คืน SMTP Transporter (singleton + pooling)
// ------------------------------------------------------------
export function getTransporter() {
  if (transporter) return transporter;

  const {
    host, port, user, pass, from,
    secure,
    poolMaxConnections = 5,
    poolMaxMessages = 100,
    rateLimit, // ต่อ 1 นาที
    debug = false,
    dkim,
  } = config.mail;

  // หมายเหตุ: secure ให้ใช้ค่าจาก config โดยตรง ถ้าไม่ใส่จะเดาจาก port
  const useSecure = typeof secure === 'boolean' ? secure : (Number(port) === 465);

  const base = {
    host,
    port: Number(port),
    secure: useSecure,
    auth: { user, pass },

    // สำคัญ: เปิด pool/keepAlive ให้เร็วขึ้น
    pool: true,
    maxConnections: poolMaxConnections,
    maxMessages: poolMaxMessages,
    keepAlive: true,

    // เสริมความนิ่ง
    greetingTimeout: 10_000, // รอ banner จาก SMTP
    connectionTimeout: 15_000,
    socketTimeout: 20_000,

    // TLS: ให้ auto อัปเกรดเป็น STARTTLS เมื่อใช้ 587
    tls: { rejectUnauthorized: true },
    logger: !!debug,
    debug: !!debug,
  };

  // ออปชัน rate limit (ป้องกันโดน throttle)
  if (rateLimit) {
    base.rateDelta = 60_000;     // 1 นาที
    base.rateLimit = Number(rateLimit);
  }

  transporter = nodemailer.createTransport(base);

  // DKIM (ถ้ามี)
  if (dkim?.domainName && dkim?.keySelector && dkim?.privateKey) {
    transporter.use('stream', nodemailer.createDkim({
      domainName: dkim.domainName,
      keySelector: dkim.keySelector,
      privateKey: dkim.privateKey,
    }));
  }

  // ตรวจสุขภาพครั้งแรก (optional แต่ดีมาก)
  transporter.verify().catch((err) => {
    console.error('[mailer] verify failed:', err?.message || err);
  });

  // ปิดอย่างสุภาพตอน process จะจบ
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, async () => {
      try { await transporter?.close?.(); } catch {}
      process.exit(0);
    });
  }

  return transporter;
}

// ------------------------------------------------------------
// 3) Helper: ส่งเมลพร้อม Retry แบบ Backoff
// ------------------------------------------------------------
const RETRYABLE_CODES = new Set([
  'ETIMEDOUT', 'ECONNECTION', 'EAI_AGAIN', 'ESOCKET', 'ETEMPFAIL'
]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * ส่งเมลพร้อม retry สูงสุด 3 ครั้ง (0 + 2 รีไทร)
 */
export async function sendEmail({ to, subject, html, text, headers } = {}) {
  const tx = getTransporter();

  const plainText = text ?? (html ? html.replace(/<[^>]+>/g, ' ') : '');
  const payload = {
    from: config.mail.from, // ควรเป็น `"Your App" <no-reply@domain.com>`
    to,
    subject,
    text: plainText,
    html,
    headers,
  };

  const MAX_ATTEMPTS = 3;
  let attempt = 0;
  let lastErr;

  while (attempt < MAX_ATTEMPTS) {
    try {
      const info = await tx.sendMail(payload);
      return info; // สำเร็จ
    } catch (err) {
      lastErr = err;
      const code = err?.code || err?.responseCode;
      const retryable =
        RETRYABLE_CODES.has(code) ||
        (typeof code === 'number' && code >= 400 && code < 500); // บาง 4xx เป็นชั่วคราว

      attempt += 1;
      if (!retryable || attempt >= MAX_ATTEMPTS) break;

      // exponential backoff: 500ms, 1500ms …
      const wait = 500 * Math.pow(3, attempt - 1);
      if (config.mail?.debug) {
        console.warn(`[mailer] send fail (attempt ${attempt}) -> retry in ${wait}ms:`, code, err?.message);
      }
      await sleep(wait);
    }
  }

  // โยน error ออกไปให้ฝั่ง caller จัดการ
  throw lastErr || new Error('sendEmail failed');
}

// ------------------------------------------------------------
// 4) ตัวอย่างฟังก์ชันส่งอีเมลยืนยัน (เผื่ออยากเรียกใช้ตรง ๆ )
// ------------------------------------------------------------
// สร้าง HTML สำหรับอีเมลยืนยัน
export function buildVerifyEmailHTML({
  verifyUrl,
  brandUrl = 'https://rtsmm-th.com',
  brandLogo = 'https://rtsmm-th.com/static/assets/logo/logo-rtssm-th.png',
  productName = 'RTSMM-TH',
  year = new Date().getFullYear(),
  supportUrl = 'mailto:support@rtsmm-th.com'
} = {}) {
  const esc = s => String(s ?? '').replace(/"/g, '&quot;');
  const BRAND_URL  = esc(brandUrl);
  const BRAND_LOGO = esc(brandLogo);
  const VERIFY_URL = esc(verifyUrl);
  const PRODUCT    = esc(productName);

  return `
<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta http-equiv="x-ua-compatible" content="ie=edge">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>ยืนยันอีเมล • ${PRODUCT}</title>
  <!--[if mso]>
    <style>
      * { font-family: Arial, sans-serif !important; }
    </style>
  <![endif]-->
  <style>
    /* รีเซ็ตเล็กน้อยสำหรับไคลเอนต์ส่วนใหญ่ */
    html,body{margin:0!important;padding:0!important;background:#f4f6f8!important}
    img{border:0;line-height:100%;outline:none;text-decoration:none}
    table,td{border-collapse:collapse!important}
    a{color:#2563eb}
    /* mobile */
    @media (max-width:600px){
      .container{width:100%!important}
      .px{padding-left:16px!important;padding-right:16px!important}
    }
    /* ส่วนหัว/ปุ่มแนว brand */
    .btn{
      background:#111827;border-radius:8px;color:#ffffff!important;
      display:inline-block;font-weight:700;text-decoration:none;
      padding:12px 22px;
    }
    /* dark mode (รองรับใน Apple Mail/บางคลายเอนต์) */
    @media (prefers-color-scheme: dark) {
      body{background:#0b0f1a!important}
      .card{background:#0f1422!important;border-color:#1f2a3a!important}
      .muted{color:#9aa4b2!important}
      .title{color:#f4f6fb!important}
      .btn{background:#334155!important}
      .head{background:#0b0f1a!important}
      a{color:#8ab4ff}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;">
  <!-- preheader (ซ่อน) -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">
    คลิกปุ่มเพื่อยืนยันอีเมลและเปิดใช้งานบัญชีของคุณ
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 0;font-family:system-ui,-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial,sans-serif;">
    <tr>
      <td align="center">
        <table role="presentation" class="container" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;border:1px solid #e6e8eb;overflow:hidden;" >
          <!-- Header -->
          <tr>
            <td class="head" style="background:#0b0f1a;padding:24px;text-align:center">
              <a href="${BRAND_URL}" target="_blank" style="text-decoration:none">
                <img src="${BRAND_LOGO}" alt="${PRODUCT}" height="42" style="display:inline-block;vertical-align:middle;max-width:100%;height:42px">
              </a>
            </td>
          </tr>

          <!-- Title + Intro -->
          <tr>
            <td class="px" style="padding:28px 24px 8px;color:#111827;">
              <h2 class="title" style="margin:0 0 6px;font-size:20px;line-height:1.3;font-weight:800">ยืนยันการสมัคร ${PRODUCT}</h2>
              <p class="muted" style="margin:0;color:#6b7280;font-size:14px;line-height:1.6">
                คลิกปุ่มด้านล่างเพื่อยืนยันอีเมลและเปิดใช้งานบัญชีของคุณ
              </p>
            </td>
          </tr>

          <!-- CTA Button (Bulletproof: มี VML สำหรับ Outlook) -->
          <tr>
            <td align="center" style="padding:16px 24px 24px">
              <!--[if mso]>
                <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${VERIFY_URL}" style="height:44px;v-text-anchor:middle;width:230px;" arcsize="12%" stroke="f" fillcolor="#111827">
                  <w:anchorlock/>
                  <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:700;">
                    ยืนยันอีเมลของฉัน
                  </center>
                </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- -->
              <a class="btn" href="${VERIFY_URL}" target="_blank">ยืนยันอีเมลของฉัน</a>
              <!--<![endif]-->
            </td>
          </tr>

          <!-- Fallback Link -->
          <tr>
            <td class="px" style="padding:0 24px 24px;color:#6b7280;font-size:12px;line-height:1.6">
              หากปุ่มกดไม่ได้ ให้คัดลอกลิงก์นี้ไปวางในเบราว์เซอร์ของคุณ:<br>
              <a href="${VERIFY_URL}" style="word-break:break-all;color:#2563eb">${VERIFY_URL}</a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;color:#9ca3af;padding:16px 24px;text-align:center;font-size:12px;line-height:1.6">
              © ${year} ${PRODUCT} • <a href="${supportUrl}" style="color:#9ca3af;text-decoration:underline">ติดต่อทีมงาน</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

