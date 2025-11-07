// src/routes/blog.js
import { Router } from "express";

const router = Router();

// รายการบทความ (เผื่อขยายในอนาคต)
const ARTICLES = {
  "tiktok-fyp": {
    slug: "tiktok-fyp",
    title: "การเพิ่มยอดวิว TikTok: เทคนิคปั้นวิดีโอให้ไวรัลแบบมือโปร",
    description:
      "ระบบปั้มวิวฟรี 2025 เว็บปั้มไลค์ facebook ปั้มผู้ติดตาม ปั้มไลค์ติ๊กต๊อก ทำโฆษณา เพิ่มยอดยูทูป ปั้นเพจเเฟสบุ๊ก ปั้นไอจี ปั้มติ๊กต็อก",
    keywords:
      "ปั้มวิว,ปั้มไลค์,ปั้มผู้ติดตาม,ระบบปั้มวิว,ระบบปั้มไลค์,ระบบปั้มผู้ติดตาม,ปั้มใจtiktok,ปั้มวิวyoutube,ปั้มไลค์ฟรี,เว็บปั้มไลค์,เพิ่มผู้ติดตาม,ปั้มไลค์ facebook,ปั้มไลค์ติ๊กต๊อก,ปั้มวิวtiktok,ปั้มผู้ติดตามtiktokฟรี ล่าสุด",
    image:
      "https://iplusview-staging.s3.amazonaws.com/uploads/blog/thumbnails/7Bi1OxNoyyczBk5ZgE9u6Wl9ebtxsmmzJ9jQuTE0.png",
    author: "RTSMM-TH",
    date: "June 21, 2025",
  },
};

router.get("/tiktok-fyp", (req, res) => {
  res.render("blog/tiktok-fyp", {
    title: "การเพิ่มยอดวิว TikTok: เทคนิคปั้นวิดีโอให้ไวรัลแบบมือโปร",
    article: {
      title: "การเพิ่มยอดวิว TikTok: เทคนิคปั้นวิดีโอให้ไวรัลแบบมือโปร",
      author: "RTSMM-TH",
      date: "June 21, 2025",
      image: "https://iplusview-staging.s3.amazonaws.com/uploads/blog/thumbnails/7Bi1OxNoyyczBk5ZgE9u6Wl9ebtxsmmzJ9jQuTE0.png",
    }
  });
});

router.get("/follower-ig", (req, res) => {
  res.render('blog/follower-ig', {
    article: {
        title: 'รวมเหตุผลที่การ ปั้นไอจี ในปี 2025 ยังคงเป็นตัวเลือกที่ดีที่สุด',
        date: 'June 07, 2025',
        author: 'RTSMM-TH',
        image: 'https://iplusview-staging.s3.amazonaws.com/uploads/blog/thumbnails/hNIdmxBE3t4AbTzGXsGw7iadOb7cpLuNRc0aIkBE.gif'
    }
  });
});

router.get("/view-youtube", (req, res) => {
  res.render('blog/view-youtube', {
    article: {
        title: 'เผยอาชีพใหม่ที่ได้ค่าตอบแทนสุดคุ้มค่า เพียงปั้นช่อง YouTube ให้สำเร็จเท่านั้น',
        date: 'June 07, 2025',
        author: 'RTSMM-TH',
        image: 'https://iplusview-staging.s3.amazonaws.com/uploads/blog/thumbnails/TLduej0sNotiUTWOZzeHWJ1vm1ybxc6YkHJPd38Z.gif'
    }
  });
});

router.get("/likefanpage-facebook", (req, res) => {
  res.render('blog/likefanpage-facebook', {
    article: {
        title: 'แชร์เทคนิคการปั้นเฟสบุ๊ก ทำอย่างไรให้หาเงินได้จากแพลตฟอร์มนี้',
        date: 'June 07, 2025',
        author: 'RTSMM-TH',
        image: 'https://iplusview-staging.s3.amazonaws.com/uploads/blog/thumbnails/CIg7H9EbISACM8pU6wInmCsAoN2dsELYcK0KzDCR.gif'
    }
  });
});

router.get("/pumview", (req, res) => {
  res.render('blog/pumview', {
    article: {
        title: 'วิธีปั๊มวิวง่าย ๆ แต่เป็นอะไรที่ใช้ได้จริง',
        date: 'June 07, 2025',
        author: 'RTSMM-TH',
        image: 'https://iplusview-staging.s3.amazonaws.com/uploads/blog/thumbnails/fbGcswvTBnAQwTOBu0vHbjY0S7GVTdia9x5aScHM.gif'
    }
  });
});

router.get("/pro-pumlike", (req, res) => {
  res.render('blog/pro-pumlike', {
    article: {
        title: 'ปั๊มไลค์แบบนี้ มืออาชีพเขาทำกัน',
        date: 'June 07, 2025',
        author: 'RTSMM-TH',
        image: 'https://iplusview-staging.s3.amazonaws.com/uploads/blog/thumbnails/OabQHfTH8yxvcBmlDpzdWHmoteE6lNgIfz8t4P75.gif'
    }
  });
});

export default router;
