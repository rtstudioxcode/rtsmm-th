import { Router } from "express";
const router = Router();

router.get("/sitemap.xml", (req, res) => {
  res.header("Content-Type", "application/xml");

  const urls = [
    "",
    "/login",
    "/register",
    "/catalog",
    "/otp24",
    "/orders",
    "/topup",
    "/blog",
    "/terms-of-use",
    "/faq"
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    ${urls
      .map(
        (u) => `
      <url>
        <loc>https://rtsmm-th.com${u}</loc>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
      </url>
    `
      )
      .join("")}
  </urlset>`;

  res.send(xml);
});

export default router;
