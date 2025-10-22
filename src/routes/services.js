// /src/routes/services.js
import express from 'express';
import mongoose from 'mongoose';

// ⬇️ ปรับ path โมเดลให้ตรงโปรเจกต์จริงของคุณ
import { Service } from '../models/Service.js';
import { Category } from '../models/Category.js';
import { Subcategory } from '../models/Subcategory.js';

export const servicesRouter = express.Router();

/** เดา platform จากชื่อ (หรือ explicit platform บน category/subcategory ถ้ามี) */
function inferPlatformFromNames({ explicit, catName = '', subName = '', title = '' }) {
  if (explicit) return explicit;
  const s = `${catName} ${subName} ${title}`.toLowerCase();
  if (s.includes('tiktok')) return 'TikTok';
  if (s.includes('facebook')) return 'Facebook';
  if (s.includes('youtube')) return 'YouTube';
  if (s.includes('instagram') || s.includes('ig')) return 'Instagram';
  if (s.includes('thread')) return 'Threads';
  if (s.includes('twitter') || s.includes(' x ')) return 'X (Twitter)';
  if (s.includes('line')) return 'LINE';
  if (s.includes('telegram')) return 'Telegram';
  if (s.includes('discord')) return 'Discord';
  if (s.includes('twitch')) return 'Twitch';
  if (s.includes('spotify')) return 'Spotify';
  if (s.includes('kick')) return 'Kick';
  if (s.includes('seo')) return 'SEO';
  if (s.includes('traffic')) return 'Traffic';
  if (s.includes('shopee')) return 'Shopee';
  if (s.includes('thai')) return 'Thailand';
  return 'Other';
}

/** ทำชื่อหมวดให้อ่านง่าย: ตัด platform ที่พิมพ์นำหน้า + ลูกศร/อีโมจิที่ใช้เป็น separator ออก */
function normalizeCategoryTitle(platform, raw = '') {
  let s = String(raw || '').trim();
  // ตัด platform ที่นำหน้า เช่น "YouTube Views ► ..." -> "...", "Telegram ▸ ..." -> "..."
  if (platform) {
    const p = platform.toLowerCase();
    const low = s.toLowerCase();
    if (low.startsWith(p)) {
      s = s.slice(platform.length).trim();
      // ลอกตัวคั่นทั่วไป
      s = s.replace(/^[-–—:>»►▸•\s]+/, '').trim();
    }
  }
  // ลอกวันที่/คำว่า NEW ที่ท้ายชื่อ (ถ้ามี) เบา ๆ ไม่ aggressive
  s = s.replace(/\b(new|updated)\b.*$/i, '').trim();
  return s || raw || 'ทั่วไป';
}

servicesRouter.get('/', async (req, res) => {
  try {
    // ดึงทุกเอกสารบริการ (provider category) แล้ว join cat/sub เพื่อ explicit platform ถ้ามี
    const docs = await Service.aggregate([
      { $match: {} },
      { $lookup: {
          from: Category.collection.name,
          localField: 'category',
          foreignField: '_id',
          as: 'cat'
      }},
      { $lookup: {
          from: Subcategory.collection.name,
          localField: 'subcategory',
          foreignField: '_id',
          as: 'sub'
      }},
      { $project: {
          providerServiceId: 1,            // = id ของ "หมวดหมู่" ในผู้ให้บริการ
          name: 1,                         // = ชื่อหมวดหมู่ของแพลตฟอร์ม (หัวกลุ่ม)
          currency: { $ifNull: ['$currency', 'THB'] },
          rate: 1,                         // base ที่ root (บางอันเป็น 0)
          min: 1, max: 1, step: 1,         // บาง schema อาจไม่ใช้แล้ว
          type: 1, dripfeed: 1, refill: 1, cancel: 1,
          average_delivery: 1,
          details: 1,                      // <<<< มี services[]
          cat: { $first: '$cat' },
          sub: { $first: '$sub' },
          updatedAt: 1, createdAt: 1
      }}
    ]);

    /** แปลงเอกสารให้กลายเป็น flat items โดยแตก details.services[] ออกมาเป็นแถว ๆ */
    const flat = [];
    for (const d of docs) {
      const catName = d?.cat?.name || '';
      const subName = d?.sub?.name || '';
      const explicitPlat = d?.cat?.platform || d?.sub?.platform || null;

      const platform = inferPlatformFromNames({
        explicit: explicitPlat,
        catName,
        subName,
        title: d?.name || ''
      });

      // ชื่อหมวด (หัวกลุ่ม) = จาก d.name ตามที่ระบุมา (normalize ให้สวยขึ้น)
      const categoryTitle = normalizeCategoryTitle(platform, d?.name || '');

      // id/ชื่อหมวดจาก provider (details.id/name)
      const providerCategoryId = d?.details?.id ?? d?.providerServiceId ?? null;
      const providerCategoryName = d?.details?.name || d?.name || '';

      const servicesArr = Array.isArray(d?.details?.services) ? d.details.services : [];

      // ถ้าไม่มี services[] ก็ยังสร้างหัวว่างได้ แต่ตามสเปคใหม่เราสนใจรายการใน services[]
      for (const svc of servicesArr) {
        flat.push({
          // group keys
          platform,
          categoryName: categoryTitle,

          // provider category (หัวกลุ่ม)
          providerCategoryId,
          providerCategoryName,

          // line item (บริการย่อยจริง)
          _id: `${d._id}:${svc.id}`,                 // ทำ composite id ให้ลิงก์/ปุ่มใช้ได้
          providerServiceId: svc.id,                 // id จริงของบริการย่อย (ใน provider)
          name: svc.name || '',
          description: svc.description || '',
          rate: Number(svc.rate ?? d.rate ?? 0),
          displayRate: Number(svc.rate ?? d.rate ?? 0), // ถ้ามีสูตร markup แจ้งมา จะคำนวณตรงนี้
          currency: svc.currency || d.currency || 'THB',
          min: svc.min ?? 0,
          max: svc.max ?? 0,
          step: svc.step ?? d.step ?? 1,
          dripfeed: !!svc.dripfeed,
          refill: !!svc.refill,
          cancel: !!svc.cancel,
          average_delivery: svc.average_delivery || d.average_delivery || '',
          type: svc.type || d.type || 'Default',

          // อ้างอิงเอกสารต้นทาง (ถ้าต้องการ debug)
          sourceId: String(d._id)
        });
      }
    }

    // ส่งให้วิว /views/catalog/services.ejs ใช้เรนเดอร์ (โค้ดหน้าวิวที่คุณวางไว้รองรับ flat list นี้)
    res.render('catalog/services', {
      title: 'บริการทั้งหมด',
      servicesFlat: flat
    });
  } catch (err) {
    console.error('GET /services error:', err);
    res.status(500).send('Internal Server Error');
  }
});
