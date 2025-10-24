// mailer.js
// ============================================================
// 1) Imports & Config
// ============================================================
import nodemailer from 'nodemailer';
import { config } from '../config.js';

// โครงสร้างที่คาดหวัง
// config.mail = {
//   host, port, user, pass, from,
//   secure,                     // optional (auto จาก port ถ้าไม่ระบุ)
//   poolMaxConnections: 5,      // optional
//   poolMaxMessages: 100,       // optional
//   rateLimit: 20,              // per minute (optional)
//   debug: false,               // optional
//   dkim: { domainName, keySelector, privateKey } // optional
// };
// config.brand (optional) = { url, name, logoPath } // สำหรับ helper ส่งเมลยืนยัน

let transporter;

// ============================================================
// 2) SMTP Transporter (singleton + pooling + DKIM + timeouts)
// ============================================================
export function getTransporter() {
  if (transporter) return transporter;

  const {
    host, port, user, pass, secure,
    poolMaxConnections = 5,
    poolMaxMessages = 100,
    rateLimit,
    debug = false,
    dkim,
  } = config.mail;

  const useSecure = typeof secure === 'boolean' ? secure : Number(port) === 465;

  transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    secure: useSecure,
    auth: { user, pass },

    // ใช้ connection pool ให้ส่งได้ไวและนิ่ง
    pool: true,
    maxConnections: poolMaxConnections,
    maxMessages: poolMaxMessages,
    keepAlive: true,

    // เผื่อเครือข่ายช้า
    greetingTimeout: 10_000,
    connectionTimeout: 15_000,
    socketTimeout: 20_000,

    // STARTTLS เมื่อใช้ 587
    tls: { rejectUnauthorized: true },

    // logging
    logger: !!debug,
    debug: !!debug,

    // Rate limit (ถ้าใส่มา)
    ...(rateLimit ? { rateDelta: 60_000, rateLimit: Number(rateLimit) } : {}),

    // DKIM แบบ native ของ Nodemailer (ง่ายและถูกต้องที่สุด)
    ...(dkim?.domainName && dkim?.keySelector && dkim?.privateKey
      ? { dkim: {
          domainName: dkim.domainName,
          keySelector: dkim.keySelector,
          privateKey: dkim.privateKey,
        } }
      : {}),
  });

  transporter.verify().catch(err =>
    console.error('[mailer] verify failed:', err?.message || err)
  );

  // ปิด connection pool ให้เรียบร้อยเมื่อโปรเซสจะจบ
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, async () => {
      try { await transporter?.close?.(); } catch {}
      process.exit(0);
    });
  }

  return transporter;
}

// ============================================================
// 3) Generic sendEmail (มี Retry + แนบไฟล์ได้ + headers ได้)
// ============================================================
const RETRYABLE_CODES = new Set(['ETIMEDOUT','ECONNECTION','EAI_AGAIN','ESOCKET','ETEMPFAIL']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function sendEmail({
  to, subject, html, text, headers, attachments
} = {}) {
  const tx = getTransporter();

  const payload = {
    from: config.mail.from,
    to,
    subject,
    text: text ?? (html ? html.replace(/<[^>]+>/g, ' ') : ''),
    html,
    headers,
    attachments, // รองรับแนบไฟล์ (รวมถึง cid)
  };

  const MAX_ATTEMPTS = 3;
  let attempt = 0, lastErr;

  while (attempt < MAX_ATTEMPTS) {
    try {
      return await tx.sendMail(payload);
    } catch (err) {
      lastErr = err;
      const code = err?.code || err?.responseCode;
      const retryable =
        RETRYABLE_CODES.has(code) ||
        (typeof code === 'number' && code >= 400 && code < 500);

      attempt += 1;
      if (!retryable || attempt >= MAX_ATTEMPTS) break;

      const wait = 500 * Math.pow(3, attempt - 1); // 500, 1500 ms
      if (config.mail?.debug) {
        console.warn(`[mailer] send fail (attempt ${attempt}) -> retry in ${wait}ms:`, code, err?.message);
      }
      await sleep(wait);
    }
  }
  throw lastErr || new Error('sendEmail failed');
}

// ============================================================
// 4) Email Template: Verify (รองรับโลโก้เป็น CID หรือ URL)
// ============================================================
export function buildVerifyEmailHTML({
  verifyUrl,
  brandUrl = config.brand?.url || 'https://rtsmm-th.com',
  // ถ้าใช้ CID ให้ส่งเป็น 'cid:brandlogo' (ดู helper ข้อ 5)
  brandLogo = 'cid:brandlogo',
  productName = config.brand?.name || 'RTSMM-TH',
  year = new Date().getFullYear(),
  supportUrl = 'mailto:support@rtsmm-th.com',
} = {}) {
  const esc = s => String(s ?? '').replace(/"/g, '&quot;');
  const BRAND_URL  = esc(brandUrl);
  const BRAND_LOGO = esc(brandLogo);
  const VERIFY_URL = esc(verifyUrl);
  const PRODUCT    = esc(productName);

  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>ยืนยันอีเมล • ${PRODUCT}</title>
  <!--[if mso]><style>*{font-family:Arial,sans-serif!important}</style><![endif]-->
  <style>
    html,body{margin:0!important;padding:0!important;background:#f4f6f8!important}
    img{border:0;line-height:100%;outline:none;text-decoration:none}
    table,td{border-collapse:collapse!important}
    a{color:#2563eb}
    @media(max-width:600px){.container{width:100%!important}.px{padding-left:16px!important;padding-right:16px!important}}
    .btn{background:#111827;border-radius:8px;color:#fff!important;display:inline-block;font-weight:700;text-decoration:none;padding:12px 22px}
    @media(prefers-color-scheme:dark){
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
<body style="margin:0;padding:0;background:#f4f6f8">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">
    คลิกปุ่มเพื่อยืนยันอีเมลและเปิดใช้งานบัญชีของคุณ
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 0;font-family:system-ui,-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial,sans-serif">
    <tr>
      <td align="center">
        <table role="presentation" class="container" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;border:1px solid #e6e8eb;overflow:hidden">
          <tr>
            <td class="head" style="background:#0b0f1a;padding:24px;text-align:center">
              <a href="${BRAND_URL}" target="_blank" style="text-decoration:none">
                <img src="${BRAND_LOGO}" alt="${PRODUCT}" width="160" height="42"
                     style="display:inline-block;vertical-align:middle;width:160px;height:42px">
              </a>
            </td>
          </tr>

          <tr>
            <td class="px" style="padding:28px 24px 8px;color:#111827">
              <h2 class="title" style="margin:0 0 6px;font-size:20px;line-height:1.3;font-weight:800">ยืนยันการสมัคร ${PRODUCT}</h2>
              <p class="muted" style="margin:0;color:#6b7280;font-size:14px;line-height:1.6">
                คลิกปุ่มด้านล่างเพื่อยืนยันอีเมลและเปิดใช้งานบัญชีของคุณ
              </p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:16px 24px 24px">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${VERIFY_URL}" style="height:44px;v-text-anchor:middle;width:230px" arcsize="12%" stroke="f" fillcolor="#111827">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:700">ยืนยันอีเมลของฉัน</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- -->
              <a class="btn" href="${VERIFY_URL}" target="_blank">ยืนยันอีเมลของฉัน</a>
              <!--<![endif]-->
            </td>
          </tr>

          <tr>
            <td class="px" style="padding:0 24px 24px;color:#6b7280;font-size:12px;line-height:1.6">
              หากปุ่มกดไม่ได้ ให้คัดลอกลิงก์นี้ไปวางในเบราว์เซอร์ของคุณ:<br>
              <a href="${VERIFY_URL}" style="word-break:break-all;color:#2563eb">${VERIFY_URL}</a>
            </td>
          </tr>

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
</html>`;
}

// ============================================================
// 5) Helper ส่ง “อีเมลยืนยัน” แบบแนบโลโก้ด้วย CID
//    - รูปจะแสดงได้แม้ Outlook / Gmail ปิดโหลดรูปภายนอก
// ============================================================
export async function sendVerifyEmail({
  to,
  verifyUrl,
  // ถ้าระบุ path จะใช้เป็น CID; ถ้าไม่ระบุจะ fallback ไปใช้ URL ภายนอก (ถ้ามีใน config.brand.logoPath/URL)
  brandLogoPath = config.brand?.logoPath, // แนะนำ: PNG/JPG
  brandUrl = config.brand?.url || 'https://rtsmm-th.com',
  productName = config.brand?.name || 'RTSMM-TH',
}) {
  const useCid = !!brandLogoPath;
  const html = buildVerifyEmailHTML({
    verifyUrl,
    brandUrl,
    productName,
    brandLogo: useCid ? 'cid:brandlogo' : (config.brand?.logoUrl || 'cid:brandlogo'),
  });

  return sendEmail({
    to,
    subject: `ยืนยันอีเมล • ${productName}`,
    html,
    // แนบไฟล์เมื่อมี path (จะแสดงผ่าน <img src="cid:brandlogo">)
    attachments: useCid ? [{
      filename: 'logo.png',
      path: brandLogoPath,
      cid: 'brandlogo',
    }] : undefined,
  });
}
