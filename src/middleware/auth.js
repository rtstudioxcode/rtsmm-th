// middleware/auth.js
export function attachUser(req, res, next) {
  const u = req.session?.user || null;
  if (u) { req.user = u; res.locals.me = u; }
  return next();
}

function wantsJSON(req) {
  return (
    req.xhr ||
    req.get('Accept')?.includes('application/json') ||
    req.get('Content-Type')?.includes('application/json') ||
    req.get('X-Requested-With') === 'XMLHttpRequest'
  );
}

export function requireAuth(req, res, next) {
  if (req.session?.user?._id) return next();
  if (wantsJSON(req)) return res.status(401).json({ error: 'Unauthorized' });
  const nextUrl = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?next=${nextUrl}`);
}

export function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  if (wantsJSON(req)) return res.status(403).json({ error: 'Forbidden' });
  return res.status(403).send('Forbidden');
}

export function requireGuest(req, res, next) {
  if (req.session?.user?._id) {
    const to = req.query?.next || '/';
    return res.redirect(to);
  }
  return next();
}
