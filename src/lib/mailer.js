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
let lastSig = null;

function buildMailSignature() {
  const m = config.mail || {};
  // เลือกเฉพาะคีย์ที่มีผลกับการเชื่อมต่อ
  const minimal = {
    host: m.host, port: Number(m.port), user: m.user, pass: m.pass, secure: m.secure ?? (Number(m.port) === 465),
    poolMaxConnections: m.poolMaxConnections ?? 5,
    poolMaxMessages: m.poolMaxMessages ?? 100,
    rateLimit: m.rateLimit ?? undefined,
    debug: !!m.debug,
    from: m.from || 'RTSSM-TH <no-reply@rtsmm-th.com>',
    dkim: m.dkim?.domainName && m.dkim?.keySelector && m.dkim?.privateKey
      ? { domainName: m.dkim.domainName, keySelector: m.dkim.keySelector, privateKey: m.dkim.privateKey }
      : null,
  };
  return JSON.stringify(minimal);
}
// ============================================================
// 2) SMTP Transporter (singleton + pooling + DKIM + timeouts)
// ============================================================
export function getTransporter() {
  // validate ขั้นต้น
  if (!config.mail?.host || !config.mail?.port) {
    throw new Error('SMTP config ไม่ครบ (host/port)');
  }

  const sig = buildMailSignature();
  const needNew = !transporter || sig !== lastSig;

  if (!needNew) return transporter;

  // สร้างใหม่ (และปิดของเดิม)
  try { transporter?.close?.(); } catch {}
  lastSig = sig;

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
    auth: (user || pass) ? { user, pass } : undefined,

    pool: true,
    maxConnections: poolMaxConnections,
    maxMessages: poolMaxMessages,
    keepAlive: true,

    greetingTimeout: 10_000,
    connectionTimeout: 15_000,
    socketTimeout: 20_000,

    tls: { rejectUnauthorized: true },

    logger: !!debug,
    debug: !!debug,

    ...(rateLimit ? { rateDelta: 60_000, rateLimit: Number(rateLimit) } : {}),

    ...(dkim?.domainName && dkim?.keySelector && dkim?.privateKey
      ? { dkim: {
          domainName: dkim.domainName,
          keySelector: dkim.keySelector,
          privateKey: dkim.privateKey,
        } }
      : {}),
  });

  // ตรวจสอบคอนฟิก (log warning ถ้าใช้ไม่ได้)
  transporter.verify().catch(err =>
    console.error('[mailer] verify failed:', err?.message || err)
  );

  // ปิด pool เมื่อโปรเซสปิด
  for (const sigName of ['SIGINT', 'SIGTERM']) {
    // ใช้ once เพื่อไม่ผูกซ้ำ
    process.once(sigName, async () => {
      try { await transporter?.close?.(); } catch {}
      process.exit(0);
    });
  }

  return transporter;
}


export function resetMailer() {
  try { transporter?.close?.(); } catch {}
  transporter = null;
  lastSig = null;
}

// ============================================================
// 3) Generic sendEmail (มี Retry + แนบไฟล์ได้ + headers ได้)
// ============================================================
const RETRYABLE_CODES = new Set(['ETIMEDOUT','ECONNECTION','EAI_AGAIN','ESOCKET']);
const RETRYABLE_SMTP = new Set([421, 450, 451, 452, 471]); // temporary failures

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function sendEmail({ to, subject, html, text, headers, attachments } = {}) {
  // ⬇️ ถ้ายังไม่มี SMTP config ให้ลองดึงจาก DB แบบ lazy
  if (!config.mail?.host || !config.mail?.port) {
    try {
      const { refreshConfigFromDB } = await import('../config.js');
      await refreshConfigFromDB();
    } catch (e) {
      // เงียบ ๆ ให้ไปตกที่ getTransporter อีกที
    }
  }
  
  const tx = getTransporter();

  const payload = {
    from: config.mail?.from || 'RTSSM-TH <no-reply@rtsmm-th.com>',
    to, subject,
    text: text ?? (html ? html.replace(/<[^>]+>/g, ' ') : ''),
    html, headers, attachments,
  };

  const MAX_ATTEMPTS = 3;
  let attempt = 0, lastErr;

  while (attempt < MAX_ATTEMPTS) {
    try {
      return await tx.sendMail(payload);
    } catch (err) {
      lastErr = err;
      const code = err?.code;
      const smtp = Number(err?.responseCode);
      const retryable = RETRYABLE_CODES.has(code) || RETRYABLE_SMTP.has(smtp);

      attempt += 1;
      if (!retryable || attempt >= MAX_ATTEMPTS) break;

      const wait = 500 * Math.pow(3, attempt - 1); // 500, 1500 ms
      if (config.mail?.debug) {
        console.warn(`[mailer] send fail (attempt ${attempt}) -> retry in ${wait}ms:`,
          code ?? smtp, err?.message);
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
  brandLogo = 'cid:brandlogo',               // ใช้ CID หรือ URL ก็ได้
  productName = config.brand?.name || 'RTSMM-TH',
  year = new Date().getFullYear(),
  supportUrl = 'mailto:support@rtsmm-th.com',

  // ปรับขนาดโลโก้ได้ตามต้องการ
  logoWidthDesktop = 220,    // 180–240 กำลังสวย
  logoWidthMobile  = 180,
} = {}) {
  const esc = s => String(s ?? '').replace(/"/g, '&quot;');
  const BRAND_URL  = esc(brandUrl);
  const BRAND_LOGO = esc(brandLogo);
  const VERIFY_URL = esc(verifyUrl);
  const PRODUCT    = esc(productName);

  const css = `
    html,body{margin:0!important;padding:0!important;background:#f4f6f8!important}
    img{border:0;line-height:100%;outline:none;text-decoration:none}
    table,td{border-collapse:collapse!important}
    a{color:#2563eb}
    .brand-logo{width:${logoWidthDesktop}px;height:auto;max-width:100%}
    @media(max-width:600px){
      .container{width:100%!important}
      .px{padding-left:16px!important;padding-right:16px!important}
      .brand-logo{width:${logoWidthMobile}px!important}
    }
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
  `;

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
  <style>${css}</style>
</head>
<body style="margin:0;padding:0;background:#f4f6f8">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">
    คลิกปุ่มเพื่อยืนยันอีเมลและเปิดใช้งานบัญชีของคุณ
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 0;font-family:system-ui,-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial,sans-serif">
    <tr>
      <td align="center">
        <table role="presentation" class="container" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;border:1px solid #e6e8eb;overflow:hidden">
          <!-- Header -->
          <tr>
            <td class="head" style="background:#0b0f1a;padding:24px;text-align:center">
              <a href="${BRAND_URL}" target="_blank" style="text-decoration:none">
                <!-- ใส่ทั้ง attribute width และ CSS; ไม่ใส่ height เพื่อรักษาสัดส่วน -->
                <img src="${BRAND_LOGO}" alt="${PRODUCT}" class="brand-logo"
                     width="${logoWidthDesktop}"
                     style="display:inline-block;vertical-align:middle;height:auto;max-width:100%;border:0;outline:0;text-decoration:none">
              </a>
            </td>
          </tr>

          <!-- Title + Intro -->
          <tr>
            <td class="px" style="padding:28px 24px 8px;color:#111827">
              <h2 class="title" style="margin:0 0 6px;font-size:20px;line-height:1.3;font-weight:800">ยืนยันการสมัคร ${PRODUCT}</h2>
              <p class="muted" style="margin:0;color:#6b7280;font-size:14px;line-height:1.6">
                คลิกปุ่มด้านล่างเพื่อยืนยันอีเมลและเปิดใช้งานบัญชีของคุณ
              </p>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td align="center" style="padding:16px 24px 24px">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${VERIFY_URL}" style="height:44px;v-text-anchor:middle;width:230px" arcsize="12%" stroke="f" fillcolor="#111827">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:700">ยืนยันอีเมลของฉัน</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-- --><a class="btn" href="${VERIFY_URL}" target="_blank">ยืนยันอีเมลของฉัน</a><!--<![endif]-->
            </td>
          </tr>

          <!-- Fallback link -->
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
</html>`;
}

// ============================================================
// 5) Helper ส่ง “อีเมลยืนยัน” แบบแนบโลโก้ด้วย CID
//    - รูปจะแสดงได้แม้ Outlook / Gmail ปิดโหลดรูปภายนอก
// ============================================================
export async function sendVerifyEmail({
  to,
  verifyUrl,
  subject,
  replyTo,
  headers,
  // ถ้าระบุ path จะใช้เป็น CID; ถ้าไม่ระบุจะ fallback ใช้ URL (config.brand.logoUrl) หรือไม่แนบ
  brandLogoPath = config.brand?.logoPath,   // แนะนำไฟล์โลโก้ PNG/JPG ในเครื่อง
  brandUrl      = config.brand?.url  || 'https://rtsmm-th.com',
  productName   = config.brand?.name || 'RTSMM-TH',
} = {}) {
  const norm    = v => (Array.isArray(v) ? v : [v]).map(s => String(s || '').trim()).filter(Boolean);
  const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

  // ✅ กรองผู้รับให้เหลือเฉพาะอีเมลถูกต้อง
  const recipients = norm(to).filter(isEmail);
  if (recipients.length === 0) {
    throw new Error('sendVerifyEmail: no valid recipient email(s)');
  }

  // ✅ เตรียม HTML (ถ้ามี brandLogoPath จะใช้ CID; ไม่งั้นพยายามใช้ URL จาก config)
  const useCid   = !!brandLogoPath;
  const logoSrc  = useCid ? 'cid:brandlogo' : (config.brand?.logoUrl || '');
  const html     = buildVerifyEmailHTML({
    verifyUrl,
    brandUrl,
    productName,
    brandLogo: logoSrc || 'cid:brandlogo', // เผื่อกรณีไม่มี URL ก็ยัง render ได้
  });

  // ✅ text fallback (กันเมลคลไคลเอนต์ที่บล็อก HTML)
  const text = [
    `ยืนยันการสมัคร ${productName}`,
    '',
    `กรุณาคลิกลิงก์เพื่อยืนยันอีเมลของคุณ:`,
    verifyUrl,
    '',
    `หากคุณไม่ได้ร้องขอ สามารถเพิกเฉยได้`
  ].join('\n');

  // ✅ attachments เฉพาะกรณีมี path (cid:brandlogo)
  const attachments = useCid ? [{
    filename: 'logo.png',
    path: brandLogoPath,
    cid: 'brandlogo',
  }] : undefined;

  // ✅ subject ใส่เองได้ หรือใช้ค่าเริ่มต้น
  const subj = subject || `ยืนยันอีเมล • ${productName}`;

  // ✅ headers เพิ่ม metadata ไว้ debug/track ได้
  const safeHeaders = {
    'X-Template': 'verify-link',
    'X-Product': productName,
    ...(headers || {}),
  };

  // ยิงจริง
  return sendEmail({
    to: recipients,
    subject: subj,
    html,
    text,
    headers: safeHeaders,
    attachments,
    ...(replyTo ? { replyTo } : {}),
  });
}
