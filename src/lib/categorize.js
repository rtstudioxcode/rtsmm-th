// แยก Platform และ ServiceType จาก payload ผู้ให้บริการ
// อ้างอิงจากชื่อ service + หมายเหตุ/หมวดที่ส่งมากับ API (ถ้ามี)

const PLATFORMS = [
  { key: 'youtube',   name: 'YouTube',   kw: [/youtube|yt\b/i] },
  { key: 'facebook',  name: 'Facebook',  kw: [/facebook|fb\b/i] },
  { key: 'instagram', name: 'Instagram', kw: [/instagram|ig\b/i] },
  { key: 'tiktok',    name: 'TikTok',    kw: [/tiktok|tt\b/i] },
  { key: 'x',         name: 'X (Twitter)', kw: /\b(x|twitter)\b/i },
  { key: 'telegram',  name: 'Telegram',  kw: /telegram/i },
  { key: 'discord',   name: 'Discord',   kw: /discord/i },
  { key: 'twitch',    name: 'Twitch',    kw: /twitch/i },
  { key: 'threads',   name: 'Threads',   kw: /threads/i },
  { key: 'spotify',   name: 'Spotify',   kw: /spotify/i },
  { key: 'kick',      name: 'Kick',      kw: /\bkick\b/i },
  { key: 'seo',       name: 'SEO',       kw: /\bseo\b|backlink|search/i },
];

const TYPES = [
  { key: 'followers', name: 'Followers / Subscribers / Members',
    kw: /follower|sub(scriber|s)?\b|member|เข้ากลุ่ม|ผู้ติดตาม|ผู้สมัคร|สมาชิก/i },
  { key: 'likes',     name: 'Likes / Reactions',
    kw: /like|reaction|ไลค์|ถูกใจ|หัวใจ/i },
  { key: 'views',     name: 'Views / Plays / Watch time',
    kw: /view|play|watch ?time|ชม|วิว/i },
  { key: 'comments',  name: 'Comments / Replies / Reviews',
    kw: /comment|reply|รีวิว|คอมเมนต์|ตอบกลับ/i },
  { key: 'shares',    name: 'Shares / Reposts',
    kw: /share|repost|แชร์/i },
  { key: 'saves',     name: 'Saves / Bookmarks',
    kw: /save|bookmark|บันทึก/i },
  { key: 'shorts',    name: 'Shorts / Reels / Stories / Live',
    kw: /shorts?|reels?|story|live|สตอรี่|ไลฟ์/i },
  { key: 'votes',     name: 'Poll / Vote',
    kw: /poll|vote|โหวต/i },
  { key: 'mentions',  name: 'Mentions / Tags',
    kw: /mention|tag|เมนชัน|แท็ก/i },
  { key: 'clicks',    name: 'Link Clicks / Traffic',
    kw: /click|traffic|คลิก|ทราฟฟิค/i },
];

function matchByKw(text, arr, fallbackName) {
  for (const it of arr) {
    const kws = Array.isArray(it.kw) ? it.kw : [it.kw];
    if (kws.some(rx => rx.test(text))) return { key: it.key, name: it.name };
  }
  return { key: 'other', name: fallbackName || 'Other' };
}

export function splitPlatformAndType(payload) {
  const raw = [
    payload.platform, payload.category, payload.name, payload.title,
    payload.description, payload.desc, payload.details
  ].filter(Boolean).join(' | ').slice(0, 500);

  const platform = matchByKw(raw, PLATFORMS, 'Other');
  const type     = matchByKw(raw, TYPES, 'General');

  return { platform, type };
}
