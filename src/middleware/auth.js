// middleware/auth.js
// รวม util และ guard ไว้ที่เดียว ใช้เป็นชุดเดียวกันทั้งเว็บ

/** ผูกข้อมูล user เข้ากับ req และ res.locals */
export function attachUser(req, res, next) {
  const u = req.session?.user || null;
  if (u) {
    const minimal = {
      _id: String(u._id || u.id),
      username: u.username,
      role: u.role || "user",
    };
    req.user = minimal;
    // ✅ ถ้ามี res.locals.me อยู่แล้ว ให้ merge แทน ไม่เขียนทับ
    res.locals.me = res.locals.me
      ? { ...res.locals.me, ...minimal }
      : { ...minimal };
  }
  next();
}

/** ตรวจว่า client คาดหวัง JSON ไหม (AJAX / API) */
function wantsJSON(req) {
  const acc = req.get("Accept") || "";
  const ctype = req.get("Content-Type") || "";
  return (
    req.xhr ||
    acc.includes("application/json") ||
    ctype.includes("application/json") ||
    req.get("X-Requested-With") === "XMLHttpRequest"
  );
}

/** helper ส่ง 401/403 แบบเหมาะกับชนิดคำขอ */
function respondUnauthorized(req, res) {
  if (wantsJSON(req))
    return res.status(401).json({ ok: false, message: "Unauthenticated" });

  const nextUrl = encodeURIComponent(req.originalUrl || "/");
  // เก็บ flash ไว้ให้ layout โชว์ popup
  req.session.flash = {
    variant: "warn",
    title: "กรุณาเข้าสู่ระบบ",
    text: "คุณต้องเข้าสู่ระบบก่อนจึงจะเข้าหน้านี้ได้",
  };
  return res.redirect(`/login?next=${nextUrl}`);
}

function respondForbidden(req, res) {
  if (wantsJSON(req))
    return res.status(403).json({ ok: false, message: "Forbidden" });

  // หน้าเว็บ: เด้งกลับหน้าหลัก + popup
  req.session.flash = {
    variant: "error",
    title: "ไม่มีสิทธิ์เข้าถึง",
    text: "คุณไม่มีสิทธิ์สำหรับหน้านี้",
  };
  return res.redirect("/");
}

/** ต้องล็อกอินเท่านั้น */
export function requireAuth(req, res, next) {
  if (req.session?.user?._id) return next();

  // 👇 auto return JSON if API path (e.g. /topup, /api, /ajax)
  if (req.originalUrl.startsWith("/topup")) return next();

  return respondUnauthorized(req, res);
}

/** ต้องเป็น guest (ยังไม่ล็อกอิน) */
export function requireGuest(req, res, next) {
  if (req.session?.user?._id) {
    const to = typeof req.query?.next === "string" ? req.query.next : "/";
    return res.redirect(to);
  }
  return next();
}

/** ตรวจ role แบบทั่วไป (admin ผ่านทุกอย่าง) */
export function requireRole(role) {
  return (req, res, next) => {
    const u = req.session?.user;
    if (!u?._id) return respondUnauthorized(req, res);

    const userRole = u.role || "user";
    if (userRole === "admin" || userRole === role) return next();

    return respondForbidden(req, res);
  };
}

/** ชอร์ตคัต: ต้องเป็นแอดมิน */
export const requireAdmin = requireRole("admin");

/** (ทางเลือก) ต้องยืนยันอีเมลแล้ว */
export function requireVerified(req, res, next) {
  const u = req.session?.user;
  if (!u?._id) return respondUnauthorized(req, res);
  if (u.emailVerified) return next();

  if (wantsJSON(req))
    return res.status(403).json({ ok: false, message: "Email not verified" });

  req.session.flash = {
    variant: "warn",
    title: "ยังไม่ได้ยืนยันอีเมล",
    text: "โปรดยืนยันอีเมลของคุณก่อนใช้งานส่วนนี้",
  };
  return res.redirect("/profile"); // หรือหน้าที่ให้ยืนยัน
}
