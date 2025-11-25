import { Router } from "express";
const router = Router();

router.get("/robots.txt", (req, res) => {
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Cache-Control", "no-cache");

  const txt = `
User-agent: *
Allow: /

Sitemap: https://rtsmm-th.com/sitemap.xml
`.trim();

  return res.send(txt);
});

export default router;
