// // /src/routes/services.js
import express from 'express';
import mongoose from 'mongoose';
import { Service } from '../models/Service.js';
import { Category } from '../models/Category.js';
import { Subcategory } from '../models/Subcategory.js';

// ✅ ใช้ตัวคำนวณราคาตามกฎแบบ per-user (ไม่แตะ DB)
import { computeEffectiveRate } from '../lib/pricing.js';

export const servicesRouter = express.Router();

// ---- speed helpers ----
function pLimit(concurrency){
  const q = [];
  let active = 0;
  const next = () => {
    if (!q.length || active >= concurrency) return;
    active++;
    const {fn, resolve, reject} = q.shift();
    Promise.resolve().then(fn).then(
      (v)=>{active--; resolve(v); next();},
      (e)=>{active--; reject(e); next();}
    );
  };
  return (fn)=> new Promise((resolve,reject)=>{ q.push({fn,resolve,reject}); next(); });
}

// in-process page cache (per user) 60s
const PAGE_CACHE = new Map(); // key -> {t,data}
const CACHE_TTL = 60_000;
function getCache(key){
  const v = PAGE_CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.t > CACHE_TTL) { PAGE_CACHE.delete(key); return null; }
  return v.data;
}
function setCache(key, data){
  PAGE_CACHE.set(key, { t: Date.now(), data });
}

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
  if (platform) {
    const p = platform.toLowerCase();
    const low = s.toLowerCase();
    if (low.startsWith(p)) {
      s = s.slice(platform.length).trim();
      s = s.replace(/^[-–—:>»►▸•\s]+/, '').trim();
    }
  }
  s = s.replace(/\b(new|updated)\b.*$/i, '').trim();
  return s || raw || 'ทั่วไป';
}

servicesRouter.get('/', async (req, res) => {
  try {
    const me = req.user || res.locals.me || req.session?.user || null;
    const userId = me?._id ? String(me._id) : null;

    // ---- page cache per user ----
    const cacheKey = `services:flat:${userId || 'guest'}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.render('catalog/services', {
        title: 'บริการทั้งหมด',
        servicesFlat: cached
      });
    }

    // ✅ ทำงานหนักใน MongoDB: แตก services[] เป็นแถวด้วย $unwind แทนลูป JS
    const rows = await Service.aggregate([
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
      { $addFields: {
          cat: { $first: '$cat' },
          sub: { $first: '$sub' },
          currency: { $ifNull: ['$currency', 'THB'] }
      }},
      // แตก services เป็นแถว
      { $unwind: {
          path: '$details.services',
          preserveNullAndEmptyArrays: false
      }},
      // เลือกเฉพาะฟิลด์ที่ต้องใช้จริง ลด payload
      { $project: {
          _id: 1,
          name: 1,
          category: 1,
          subcategory: 1,
          rate: 1,
          step: 1,
          type: 1,
          average_delivery: 1,
          currency: 1,
          'cat.name': 1, 'cat.platform': 1,
          'sub.name': 1, 'sub.platform': 1,
          'details.id': 1, 'details.name': 1,
          'details.services.id': 1,
          'details.services.name': 1,
          'details.services.description': 1,
          'details.services.currency': 1,
          'details.services.rate': 1,
          'details.services.min': 1,
          'details.services.max': 1,
          'details.services.step': 1,
          'details.services.dripfeed': 1,
          'details.services.refill': 1,
          'details.services.cancel': 1,
          'details.services.average_delivery': 1,
          'details.services.type': 1
      }}
    ]).allowDiskUse(true); // ✅ กันเมมล้นสำหรับข้อมูลเยอะ

    // ---- เตรียม limit concurrency สำหรับ computeEffectiveRate ----
    const limit = pLimit(8); // ปรับ 6-12 ตามสเปคเครื่อง/จำนวนคอร์

    // ---- คำนวณและแม็ปเป็น flat พร้อมกันแบบจำกัดจำนวน ----
    const flat = await Promise.all(rows.map(r => limit(async () => {
      const catName = r?.cat?.name || '';
      const subName = r?.sub?.name || '';
      const explicitPlat = r?.cat?.platform || r?.sub?.platform || null;

      const platform = inferPlatformFromNames({
        explicit: explicitPlat,
        catName,
        subName,
        title: r?.name || ''
      });

      const categoryTitle = normalizeCategoryTitle(platform, r?.name || '');
      const providerCategoryId = r?.details?.id ?? null;
      const providerCategoryName = r?.details?.name || r?.name || '';

      const svc = r.details?.services || {};
      const baseRate = Number(svc.rate ?? r.rate ?? 0);

      let effectiveRate = baseRate;
      try {
        effectiveRate = await computeEffectiveRate({
          service: r,               // ใช้แถวที่มี field พอเพียงแล้ว
          childId: svc.id,
          userId,
          baseRate
        });
      } catch {
        // ใช้ baseRate ต่อ
      }

      return {
        // group keys
        platform,
        categoryName: categoryTitle,

        // provider category (หัวกลุ่ม)
        providerCategoryId,
        providerCategoryName,

        // line item (บริการย่อยจริง)
        _id: `${r._id}:${svc.id}`,
        providerServiceId: svc.id,
        name: svc.name || '',
        description: svc.description || '',

        baseRate,
        rate: effectiveRate,
        displayRate: effectiveRate,
        currency: svc.currency || r.currency || 'THB',

        min: svc.min ?? 0,
        max: svc.max ?? 0,
        step: svc.step ?? r.step ?? 1,
        dripfeed: !!svc.dripfeed,
        refill: !!svc.refill,
        cancel: !!svc.cancel,
        average_delivery: svc.average_delivery || r.average_delivery || '',
        type: svc.type || r.type || 'Default',

        sourceId: String(r._id)
      };
    })));

    // ---- เก็บ cache 60 วิ ----
    setCache(cacheKey, flat);

    return res.render('catalog/services', {
      title: 'บริการทั้งหมด',
      servicesFlat: flat
    });
  } catch (err) {
    console.error('GET /services error:', err);
    res.status(500).send('Internal Server Error');
  }
});
