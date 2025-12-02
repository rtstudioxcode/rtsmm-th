// lib/syncServices.js
import { getServices } from './iplusviewAdapter.js';
import { Category } from '../models/Category.js';
import { Subcategory } from '../models/Subcategory.js';
import { Service } from '../models/Service.js';
import { ProviderSettings } from '../models/ProviderSettings.js';
import { splitPlatformAndType } from './categorize.js';
import { applyRulesToOneService, applyAllPricingRules } from './pricing.js';
import { ChangeLog } from '../models/ChangeLog.js';

const pick  = (o, ks, d) => { for (const k of ks) if (o?.[k] !== undefined) return o[k]; return d; };
const toNum = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const toBool = v => {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  const s = String(v ?? '').toLowerCase();
  if (['1','true','yes','on','open','opened','enabled','active'].includes(s)) return true;
  if (['0','false','no','off','close','closed','disabled','inactive'].includes(s)) return false;
  return undefined;
};

// =========================
//  PLATFORM MAP ใหม่
// =========================
const PLATFORM_MAP = [
  // ✅ กลุ่มพิเศษ
  {
    key: 'premium',
    name: 'บัญชีพรีเมียม | คีย์',
    match: [
      'canva pro',
      'chatgpt business',
      'youtube premium',
      'license key',
      'ดาวน์โหลด ไฟล์ลิขสิทธิ์',
      'shutterstock',
      'envato',
      'adobestock',
      'istockphoto',
      'motion array',
    ],
  },
  {
    key: 'thailand',
    name: 'ประเทศไทย',
    match: [
      '🇹🇭',                        // มีธงไทย
      ' ประเทศไทย',                 // คำว่าประเทศไทย
      ' บัญชีไทย',                 // บัญชีไทย
      'thailand services',
      'tiktok 🎯 thailand',
      'youtube ► thailand',
      'รวมบริการยูทูป ประเทศไทย',
      'instagram ► รวมบริการไอจี ประเทศไทย',
      'facebook ► รวมบริการไทย',
      'facebook ► ถูกใจเพจ | ผู้ติดตาม [ เพจ/โปรไฟล์ ] 💎 [ บัญชีไทย ]',
      'facebook ► ไลค์โพส reactions',
      'facebook ► แชร์โพส 🔗 บัญชีไทย',
      'facebook ► คอมเม้นท์ 💬 บัญชีไทย',
      'facebook 📝 รีวิวแฟนเพจ,แนะนำเพจ บัญชีไทย',
      'x.com | twitter services ► รวมบริการประเทศไทย',
      'shopee / lazada services ► บัญชีไทย',
      'ส่วนเสริม ไลฟ์สด shopee.co.th',
      'spotify ► thailand',
    ],
  },

  // ✅ Traffic แยกออกมาต่างหาก และอยู่ก่อน SEO
  {
    key: 'traffic',
    name: 'เพิ่มคนเข้าเว็บ',
    match: [
      '➖➖➖➖➖➖➖➖➖🔻 𝐖𝐞𝐛𝐬𝐢𝐭𝐞 𝐓𝐫𝐚𝐟𝐟𝐢𝐜 + 𝐒𝐄𝐎 🔻➖➖➖➖➖➖➖➖➖',
      // ทราฟฟิก / เข้าเว็บ
      'เพิ่มทราฟฟิคเข้าเว็บไซต์',
      'website traffic',
      'mobile traffic',
      'premium traffic',
      'pop-under traffic',
      'worldwide',
      'exchange platforms (ptc)',
      'แหล่งอ้างอิง เลือกประเทศ',
      'choose geo',
      'website 💎 premium traffic packages',
      'website traffic 🇹🇭 ประเทศไทย',

      // รวมฝั่ง SEO มาด้วย
      'backlinks & website seo',
      'seo package ranking',
      'social signals',
      'best google ranking',
      'search console',
      ' seo',
    ],
  },

  // แพลตฟอร์มหลัก
  { key: 'tiktok',    name: 'TikTok',          match: ['➖➖➖➖➖➖➖➖➖🔻 𝐓𝐢𝐤𝐓𝐨𝐤 🔻➖➖➖➖➖➖➖➖➖', 'tiktok'] },
  { key: 'facebook',  name: 'Facebook',       match: ['➖➖➖➖➖➖➖➖➖🔻 รวมบริการ 𝐅𝐚𝐜𝐞𝐛𝐨𝐨𝐤 🔻➖➖➖➖➖➖➖➖➖', 'facebook'] },
  { key: 'instagram', name: 'Instagram',      match: ['➖➖➖➖➖➖➖➖➖🔻 𝐈𝐧𝐬𝐭𝐚𝐠𝐫𝐚𝐦 / 𝐓𝐡𝐫𝐞𝐚𝐝𝐬 🔻➖➖➖➖➖➖➖➖➖', 'instagram'] },
  { key: 'youtube',   name: 'YouTube',        match: ['➖➖➖➖➖🔻𝐘𝐨𝐮𝐭𝐮𝐛𝐞🔻➖➖➖➖➖', 'youtube', 'yt '] },
  { key: 'threads',   name: 'Threads',        match: ['threads'] },
  { key: 'twitter',   name: 'X (Twitter)',    match: ['➖➖➖➖➖➖➖➖➖🔻 𝐗.𝐜𝐨𝐦 | 𝐓𝐰𝐢𝐭𝐭𝐞𝐫 🔻➖➖➖➖➖➖➖➖➖', 'x (twitter)', 'twitter', 'tw '] },
  { key: 'line',      name: 'Line Official',  match: ['➖➖➖➖➖➖➖➖➖🔻 𝐋𝐢𝐧𝐞 𝐎𝐟𝐟𝐢𝐜𝐢𝐚𝐥 🔻➖➖➖➖➖➖➖➖➖', 'Line Official Account ', 'Line OpenChat', 'Line Voom '] },
  { key: 'telegram',  name: 'Telegram',       match: ['➖➖➖➖➖➖➖➖➖🔻 𝐓𝐞𝐥𝐞𝐠𝐫𝐚𝐦 🔻➖➖➖➖➖➖➖➖➖', 'telegram'] },
  { key: 'discord',   name: 'Discord',        match: ['➖➖➖➖➖➖➖➖➖🔻 𝐃𝐢𝐬𝐜𝐨𝐫𝐝 🔻➖➖➖➖➖➖➖➖➖', 'discord'] },
  { key: 'twitch',    name: 'Twitch',         match: ['➖➖➖➖➖➖➖➖➖🔻 𝐓𝐰𝐢𝐭𝐜𝐡 🔻➖➖➖➖➖➖➖➖➖', 'twitch'] },
  { key: 'spotify',   name: 'Spotify',        match: ['➖➖➖➖➖➖➖➖➖🔻 𝐒𝐩𝐨𝐭𝐢𝐟𝐲 🔻➖➖➖➖➖➖➖➖➖', 'spotify'] },
  { key: 'kick',      name: 'Kick',           match: ['➖➖➖➖➖➖➖➖➖🔻 𝐊𝐢𝐜𝐤.𝐜𝐨𝐦 🔻➖➖➖➖➖➖➖➖➖', 'Kick.com'] },
  { key: 'shopee', name: 'ไลฟ์สด Shopee', match: ['➖➖➖➖➖➖➖➖➖🔻 𝐒𝐡𝐨𝐩𝐞𝐞 🔻➖➖➖➖➖➖➖➖➖', 'shopee', 'shp '] },
  // { key: 'other',  
  //   name: 'อื่นๆ', 
  //   match: [
  //     '🆓【﻿𝗙𝗿𝗲𝗲 𝗧𝗿𝗶𝗮𝗹】บริการทดลองฟรี ⏱ วันละ 1 ครั้ง',
  //     '💝 โปรโมชั่นประจำปี 2025 — บริการส่งเสริมการขาย ✖️ ไม่มีรับประกัน ⛔️ ไม่มียกเลิก',
  //     '➖➖➖➖➖➖➖➖➖🔻 บริการมาใหม่ 🔻➖➖➖➖➖➖➖➖➖',
  //     '✅Canva Pro 🖌️ ปล็ดล๊อกทุกฟังก์ชั่น ถูกที่สุด',
  //     '✅ChatGPT Business ✨ Google AI Ultra VEO3',
  //     '✅Disney+ 🔴 Amazon Prime 🔴 Youtube Premium',
  //     '✅License Key 🔑  Microsoft Office, Windows Key ✈️ บริการพิเศษจากเรา 📧 ใส่อีเมล์เพื่อสั่งซื้อ',
  //     '✅License Key 🔑 Adobe, AutoDesk, Steam, Kaspersky, Grammarly, Duolingo, อื่นๆ 📧 ใส่อีเมล์เพื่อสั่งซื้อ',
  //     '✅ดาวน์โหลด ไฟล์ลิขสิทธิ์ 📷 ShutterStock, Freepik, Flaticon, Envato, SketchUp, AdobeStock, iStockPhoto, Motion Array',
  //     '✅🇹🇭 Meta.ai Ⓜ️ เมต้า บัญชีไทย - ไลค์ / ผู้ติดตาม',
  //     '✅🇹🇭 Zepeto 🦹 เซเปโต้ บัญชีไทย',
  //     '✅🇹🇭 Lemon8 🍋 เลมอน8 บัญชีไทย - ไลค์ / ผู้ติดตาม / เซฟ',
  //     '✅🇹🇭 CapCut 📽️ แคปคัท บัญชีไทย - ไลค์วิดีโอ / ผู้ติดตาม',
  //     '✅🇹🇭 Joylada 📖 จอยลดา บัญชีไทย - ไลค์ / ผู้ติดตาม / อ่าน',
  //     '✅BiliBili 📺 ไลค์ / ผู้ติดตาม / วิววิดีโอ',
  //     '➖➖➖➖➖➖➖➖➖🔻 𝐓𝐢𝐤𝐓𝐨𝐤 🔻➖➖➖➖➖➖➖➖➖',
  //     '✅TikTok 🎯 Thailand 🇹🇭 Services – รวมบริการประเทศไทย 🚫 ไม่มีรับประกัน',
  //     '✅TikTok 🎯 All Services – รวมบริการทางเลือก 🪅 𝐒𝐯.𝐢𝐒𝐞𝐞',
  //     '✅TikTok 👁️ Video Views – วิววิดีโอ',
  //     'TikTok 👤 Followers – ผู้ติดตา',
  //     '⚠️ คำสั่งซื้อหนาแน่น ✅TikTok ❤️️ Likes – ไลค์ • จัดส่งเงียบ ซ่อนโปรไฟล์ 🫣 ทำงานไว',
  //     'TikTok ❤️️ Likes',
  //     'TikTok 💾 Saves',
  //     'TikTok 🔗 Shares',
  //     'TikTok 👀 Story Services',
  //     'TikTok 💬 Comments',
  //     'TikTok ❤️️ Comment Likes',
  //     'TikTok 🔴 Live Stream',
  //     'TikTok 💬 Live Comments',
  //     'TikTok ❤️️ Live Likes',
  //     '✅TikTok 🥊 PK Battle Points',
  //     '✅TikTok 💔 Not Interested',
  //     '✅Douyin',
  //     '➖➖➖➖➖🔻𝐘𝐨𝐮𝐭𝐮𝐛𝐞🔻➖➖➖➖➖',
  //     'YouTube Views',
  //     'YouTube รวมบริการ',
  //     'YouTube 🔎 CTR Search Views',
  //     '✅🇹🇭 Youtube',
  //     '✅Youtube ► เพิ่มชั่วโมงช่อง',
  //     '✅Youtube Adword Views [Google Ads - Display Ads] 🤑 การดูจากโฆษณาผ่าน Display Ads',
  //     '✅YouTube ► Shorts Services',
  //     '✅YouTube Shorts Views',
  //     'YouTube 👍 Likes',
  //     'YouTube 👎 Dislikes',
  //     '✅Youtube 👍💬 ถูกใจ คอมเม้นท์',
  //     'Youtube Subscribers',
  //     '✅YouTube ► แชร์ไปโซเชียลมีเดีย',
  //     'Youtube 🔴 Live Stream',
  //     'Youtube 🔴 Like For Live Stream',
  //     'Youtube 🔴 Reaction For Live Stream',
  //     'Youtube 🔴 Live Chat Comments',
  //     '🪚 YouTube Split',
  //     '➖➖➖➖➖➖➖➖➖🔻 𝐈𝐧𝐬𝐭𝐚𝐠𝐫𝐚𝐦 / 𝐓𝐡𝐫𝐞𝐚𝐝𝐬 🔻➖➖➖➖➖➖➖➖➖',
  //     '✅Threads',
  //     'Instagram',
  //     '🪚 Instagram Split',
  //     '➖➖➖➖➖➖➖➖➖🔻 รวมบริการ 𝐅𝐚𝐜𝐞𝐛𝐨𝐨𝐤 🔻➖➖➖➖➖➖➖➖➖',
  //     '✅🇹🇭 Facebook',
  //     '✅Facebook Services',
  //     '✅Facebook ► ผู้ติดตามแฟนเพจ',
  //     '✅Facebook ► ถูกใจแฟนเพจ',
  //     '✅Facebook ► ไลค์โพส',
  //     '✅🅰️Facebook ► ออโต้ไลค์โพส',
  //     '✅Facebook ► วิววิดีโอ',
  //     '✅Facebook 60K Minutes',
  //     '✅Facebook 120K Minutes',
  //     '✅Facebook 180K Minutes',
  //     '✅Facebook 600K Minutes',
  //     '✅Facebook ► ดูสตอรี่',
  //     '✅Facebook ► กดอิโมจิสตอรี่',
  //     '✅Facebook ► ซ่อนคอมเม้นท์ ในโพสต์',
  //     '✅Facebook ► คอมเม้นท์ / สุ่มอิโมจิ',
  //     '✅Facebook ► Saves บันทึกโพสต์',
  //     '✅Facebook ► Shares แชร์',
  //     '✅Facebook ► แชร์โพส แชร์รูป พิมพ์ข้อความที่อยากแชร์',
  //     '✅Facebook ► ไลค์คอมเม้นท์',
  //     '✅Facebook ► ตอบกลับคอมเม้นท์',
  //     '✅Facebook ► เพิ่มเพื่อนบัญชีเฟสบุ๊คส่วนตัว',
  //     '✅Facebook ► เพิ่มคนเข้ากลุ่ม | รีวิวเพจ | อีเว้นท์ | โพลโหวต',
  //     '✅Facebook 🔴 Live Stream',
  //     '✅🅰️Facebook 🔴 Auto Live Stream',
  //     'Facebook Brazil',
  //     'Facebook Pakistan',
  //     ' Facebook Split',
  //     '➖➖➖➖➖➖➖➖➖🔻 𝐗.𝐜𝐨𝐦 | 𝐓𝐰𝐢𝐭𝐭𝐞𝐫 🔻➖➖➖➖➖➖➖➖➖',
  //     'X.com | Twitter',
  //     '➖➖➖➖➖➖➖➖➖🔻 𝐒𝐡𝐨𝐩𝐞𝐞 🔻➖➖➖➖➖➖➖➖➖',
  //     'Shopee',
  //     '✅🇹🇭 ส่วนเสริม ไลฟ์สด Shopee.co.th',
  //     '➖➖➖➖➖➖➖➖➖🔻 𝐋𝐢𝐧𝐞 𝐎𝐟𝐟𝐢𝐜𝐢𝐚𝐥 🔻➖➖➖➖➖➖➖➖➖',
  //     'Line',
  //     '➖➖➖➖➖➖➖➖➖🔻 𝐃𝐢𝐬𝐜𝐨𝐫𝐝 🔻➖➖➖➖➖➖➖➖➖',
  //     'Discord',
  //     '➖➖➖➖➖➖➖➖➖🔻 𝐊𝐢𝐜𝐤.𝐜𝐨𝐦 🔻➖➖➖➖➖➖➖➖➖',
  //     'Telegram',
  //     '➖➖➖➖➖➖➖➖➖🔻 𝐓𝐞𝐥𝐞𝐠𝐫𝐚𝐦 🔻➖➖➖➖➖➖➖➖➖',
  //     'Kick',
  //     '➖➖➖➖➖➖➖➖➖🔻 𝐒𝐩𝐨𝐭𝐢𝐟𝐲 🔻➖➖➖➖➖➖➖➖➖',
  //     'Spotify',
  //     '➖➖➖➖➖➖➖➖➖🔻 𝐓𝐰𝐢𝐭𝐜𝐡 🔻➖➖➖➖➖➖➖➖➖',
  //     'Twitch',
  //     '➖➖➖➖➖➖➖➖➖🔻 𝐖𝐡𝐚𝐭𝐬𝐚𝐩𝐩 🔻➖➖➖➖➖➖➖➖➖',
  //     'Whatsapp',
  //     '➖➖➖➖➖➖➖➖➖🔻 อื่นๆ 🔻➖➖➖➖➖➖➖➖➖',
  //     'SoundCloud',
  //     'Kwai',
  //     'LinkedIn',
  //     'Dailymotion',
  //     '✅Likee',
  //     '✅Pinterest',
  //     '✅Tumblr',
  //     '✅Trovo',
  //     '✅BlueSky',
  //     '✅Vimeo',
  //     '✅Sooplive',
  //     '✅Naver TV Views',
  //     '✅Naver Chzzk',
  //     '✅Audiomack',
  //     '✅Reddit',
  //     '✅Deezer',
  //     '✅Potato',
  //     'Quora.Com',
  //     '✅Napster',
  //     'Rumble',
  //     '✅Rutube',
  //     '✅DLive',
  //     'BIGO.TV Live Stream Views',
  //     '✅Bigo Live',
  //     '✅SnapChat',
  //     'GitHub',
  //     '✅Binance',
  //     '✅IMDB',
  //     '✅Mobile App Installs ► iOS / Android',
  //     '✅Apple Music',
  //     '✅Google Map',
  //     '✅Dexscreener กดอิโมจิ 🔥🚀🚩💩',
  //     '✅CoinMarketCap',
  //     '✅PUBG Mobile UC (Global)',
  //     '✅Free Fire',
  //     '✅Steam Points',
  //     '✅ส่งรายงาน ❌ Spam Report Services',
  //     '➖➖➖➖➖➖➖➖➖🔻 𝐖𝐞𝐛𝐬𝐢𝐭𝐞 𝐓𝐫𝐚𝐟𝐟𝐢𝐜 + 𝐒𝐄𝐎 🔻➖➖➖➖➖➖➖➖➖',
  //     '✅Mobile Traffic',
  //     '🌐เพิ่มทราฟฟิคเข้าเว็บไซต์',
  //     '🌐Google Search Console',
  //     '🚀Website',
  //     '🔗Backlinks',
  //     '📊Social Signals',
  //     '✅📊SEO Package Ranking',
  //     '✅🔴Premium Pop-Under Traffic',
  //     'new for test_wow',
  //     'Opensea.com',
  //     'Coingecko.com',
  //     'Superrare.com',
  //     'Crypto.com',
  //     'Rarible.com',
  //     'Youtube | Short Views - Adword [Google Ads]'
  //   ] 
  // },
  // fallback
  { key: 'other',  name: 'อื่นๆ', match: [] },
];


// ===== ระบบหา Platform และ Subcategory =====
function detectPlatformAndType(service) {
  const name = (service?.name || '');
  const desc = service?.description || service?.details || '';
  const raw  = (name + ' ' + desc).toLowerCase();

  // --- หา platform: ไล่ตาม PLATFORM_MAP (ตอนนี้ premium/thailand มาก่อนแล้ว) ---
  let platform = PLATFORM_MAP.find(p =>
    p.match.some((m) => raw.includes(m.toLowerCase()))
  );
  if (!platform) {
    platform = PLATFORM_MAP.find(p => p.key === 'other');
  }

  // --- หา subcategory แบบง่าย ๆ ตาม keyword ---
  let typeName = 'อื่นๆ';

  if (raw.includes('follow'))       typeName = 'Followers';
  else if (raw.includes('subscr'))  typeName = 'Subscribers';
  else if (raw.includes('like'))    typeName = 'Likes';
  else if (raw.includes('view'))    typeName = 'Views';
  else if (raw.includes('comment')) typeName = 'Comments';
  else if (raw.includes('share'))   typeName = 'Shares';
  else if (raw.includes('member'))  typeName = 'Members';
  else if (raw.includes('traffic')) typeName = 'Website Traffic';
  else if (raw.includes('vote'))    typeName = 'Votes';

  // คืนเป็น object ให้ใช้กับ upsertSubcategory ได้ถูก
  const type = {
    key: typeName.toLowerCase().replace(/\s+/g, '-'),
    name: typeName,
  };

  return { platform, type };
}

function inferStatus({ raw, mapped, prev }) {
  const maybe =
    toBool(raw?.status) ?? toBool(raw?.state) ?? toBool(raw?.enabled) ??
    toBool(raw?.is_active) ?? toBool(raw?.available);
  if (maybe !== undefined) return maybe ? 'open' : 'close';
  if (Number.isFinite(mapped?.rate) && mapped.rate <= 0) return 'close';
  if (prev && (prev.disabled || prev.hidden)) return 'close';
  return 'open';
}

async function upsertCategory(platform) {
  const slug = platform.key;
  return Category.findOneAndUpdate(
    { slug },
    { $set: { name: platform.name, slug } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}
async function upsertSubcategory(categoryId, type) {
  const slug = type.key;
  return Subcategory.findOneAndUpdate(
    { category: categoryId, slug },
    { $set: { category: categoryId, name: type.name, slug } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

export async function syncServicesFromProvider() {
  // กันกดซ้ำ: ตั้งธง (option เสริม แต่ไม่บังคับ)
  const ps0 = await ProviderSettings.findOne() || new ProviderSettings();
  if (ps0.syncInProgress) {
    return { ok:false, message: 'sync is running, try again later' };
  }
  ps0.syncInProgress = true;
  await ps0.save();

  try {
    const rawList = await getServices();
    if (!Array.isArray(rawList)) throw new Error('Provider returned non-array for services');

    // เก็บของเก่าไว้ทำ changeLogs: removed
    const prevList = await Service.find(
      {},
      { providerServiceId:1, name:1, rate:1, disabled:1, hidden:1 }
    ).lean();

    // 1) ล้างทั้งหมดก่อน (FULL REPLACE) — ไม่มี transaction
    await Service.deleteMany({});

    // 2) อัปเดตหมวดหมู่และเตรียมรายการใหม่
    const platformCache = new Map();
    const typeCache = new Map();

    const docs = [];
    const changeLogs = [];
    let created = 0, skipped = 0;

    for (const s of rawList) {
      const providerId = String(pick(s, ['id','service_id','sid','service'], '')).trim();
      if (!providerId) { skipped++; continue; }

      const { platform, type } = detectPlatformAndType(s);

      let plat = platformCache.get(platform.name);
      if (!plat) {
        plat = await upsertCategory(platform);
        platformCache.set(platform.name, plat);
      }

      const typeKey = `${plat._id.toString()}::${type.name}`;
      let sub = typeCache.get(typeKey);
      if (!sub) {
        sub = await upsertSubcategory(plat._id, type);
        typeCache.set(typeKey, sub);
      }

      const mapped = {
        name:        pick(s, ['name','title','service_name'], `Service #${providerId}`),
        description: pick(s, ['description','desc','details','note','notes','instruction','instructions'], ''),
        currency:    pick(s, ['currency','curr'], 'THB'),
        rate:        toNum(pick(s, ['rate','price','cost','price_per_1000','price_per_k','pricePerK','per1000','per_1k'], 0)),
        min:         toNum(pick(s, ['min','min_qty','min_qnt','minimum'], 0)),
        max:         toNum(pick(s, ['max','max_qty','max_qnt','maximum'], 0)),
        step:        toNum(pick(s, ['step','step_size','step_qty'], 1)),
        type:        pick(s, ['type','mode','kind'], 'default'),
        dripfeed:    !!pick(s, ['dripfeed','drip','drip_feed'], false),
        refill:      !!pick(s, ['refill'], false),
        cancel:      !!pick(s, ['cancel','cancellable'], false),
        average_delivery: pick(s, ['average_delivery','avg_delivery','delivery_time'], '')
      };

      const status = inferStatus({ raw: s, mapped, prev: null });

      docs.push({
        providerServiceId: providerId,
        category: plat._id,
        subcategory: sub._id,
        name: mapped.name,
        description: mapped.description,
        currency: mapped.currency,
        rate: mapped.rate,
        min: mapped.min,
        max: mapped.max,
        step: mapped.step,
        type: mapped.type,
        dripfeed: mapped.dripfeed,
        refill: mapped.refill,
        cancel: mapped.cancel,
        average_delivery: mapped.average_delivery,
        details: s,
        disabled: status === 'close',
        hidden: status === 'close',
      });

      changeLogs.push({
        ts: new Date(),
        target: 'service',
        diff: 'new',
        providerServiceId: providerId,
        platform: platform.name,
        categoryName: type.name,
        serviceName: mapped.name,
        oldStatus: undefined,
        newStatus: status,
        isBootstrap: true,
      });

      created++;
    }

    if (docs.length) await Service.insertMany(docs, { ordered: false });

    // removed logs
    const newPidSet = new Set(docs.map(d => String(d.providerServiceId)));
    for (const prev of prevList) {
      const pid = String(prev.providerServiceId);
      if (!newPidSet.has(pid)) {
        changeLogs.push({
          ts: new Date(),
          target: 'service',
          diff: 'removed',
          providerServiceId: pid,
          platform: undefined,
          categoryName: undefined,
          serviceName: prev.name || `Service #${pid}`,
          oldStatus: inferStatus({ raw:{}, mapped:{ rate: prev.rate }, prev }),
          newStatus: 'close',
          isBootstrap: false,
        });
      }
    }

    // save provider settings + logs
    const ps = await ProviderSettings.findOne() || new ProviderSettings();
    ps.lastSyncAt = new Date();
    await ps.save();

    if (changeLogs.length) {
      try {
        await ChangeLog.insertMany(changeLogs, { ordered: false });
      } catch (e) {
        console.warn('changeLogs insert warning:', e?.writeErrors?.length || e?.message || e);
      }
    }

    // 3) apply pricing rules (นอก “ล้าง–ใส่ใหม่” เพื่อเบา DB)
    const totalInserted = await Service.countDocuments();
    if (totalInserted <= 500) {
      const ids = (await Service.find({}, { _id: 1 }).lean()).map(d => d._id);
      for (const id of ids) await applyRulesToOneService(id);
    } else {
      await applyAllPricingRules();
    }

    console.log(`✅ FULL REPLACE (no transaction): synced ${created} items; skipped: ${skipped}; total: ${await Service.countDocuments()}; logs: ${changeLogs.length}`);
    return { ok:true, count: created, skipped, logs: changeLogs.length, mode: 'full-replace' };

  } finally {
    // ปลดธงกันซ้ำ
    const ps1 = await ProviderSettings.findOne() || new ProviderSettings();
    ps1.syncInProgress = false;
    await ps1.save();
  }
}