// mapPlatforms.js
export const PLATFORM_MAP = [
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
  { key: 'tiktok',    name: 'TikTok',          match: ['tiktok'] },
  { key: 'facebook',  name: 'Facebook',       match: ['facebook'] },
  { key: 'instagram', name: 'Instagram',      match: ['instagram'] },
  { key: 'youtube',   name: 'YouTube',        match: ['youtube', 'yt '] },
  { key: 'threads',   name: 'Threads',        match: ['threads'] },
  { key: 'twitter',   name: 'X (Twitter)',    match: ['x (twitter)', ' twitter', ' tw '] },
  { key: 'line',      name: 'LINE',           match: [' line ', ' line official', 'ไลน์ '] },
  { key: 'telegram',  name: 'Telegram',       match: ['telegram'] },
  { key: 'discord',   name: 'Discord',        match: ['discord'] },
  { key: 'twitch',    name: 'Twitch',         match: ['twitch'] },
  { key: 'spotify',   name: 'Spotify',        match: ['spotify'] },
  { key: 'kick',      name: 'Kick',           match: [' kick '] },

  { key: 'shopee', name: 'ไลฟ์สด Shopee', match: ['shopee', 'shp '] },

  // fallback
  { key: 'other',  name: 'อื่นๆ', match: [] },
];
