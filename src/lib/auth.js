// lib/auth.js
export const getAuthUserId = (req) =>
  req.session?.user?._id || req.session?.userId || null;
