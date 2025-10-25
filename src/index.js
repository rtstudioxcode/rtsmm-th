// src/index.js ตัวรันหลัก
import mongoose from 'mongoose';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import { connectMongo } from './db/mongo.js';
import { User } from './models/User.js';
import { config } from './config.js';
import expressLayouts from 'express-ejs-layouts';
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import orderRoutes from './routes/orders.js';
import adminRoutes from './routes/admin.js';
import adminPricingRoutes from './routes/admin-pricing.js';
import walletRoutes from './routes/wallet.js';
import newOrderRoutes from './routes/newOrder.js';
import { syncServicesFromProvider } from './lib/syncServices.js';
import { Category } from './models/Category.js';
import { servicesRouter } from './routes/services.js';
import changesRoute from './routes/changes.js';
import { initDailyChangeSync } from './jobs/dailyChangeSync.js';
import accountRouter from './routes/account.js';
import resetPasswordRoutes from './routes/reset-password.js';
import dashboardRouter from './routes/dashboard.js';
import otpRouter from './routes/otp.js';
import { attachUser, requireAuth, requireAdmin } from './middleware/auth.js';
import { Order } from './models/Order.js'
import apiPricingRouter from './routes/api-pricing.js';
import compression from 'compression';
import { startSpendAutoRecalc } from './services/spendWatcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// เชื่อมต่อ Mongo
await connectMongo();

let stopSpendWatcher = null;
mongoose.connection.once('open', () => {
  if (!stopSpendWatcher) {
    stopSpendWatcher = startSpendAutoRecalc(mongoose.connection);
    console.log('[spendWatcher] started');
  }
});

for (const sig of ['SIGINT','SIGTERM']) {
  process.on(sig, () => {
    try { stopSpendWatcher?.(); } catch {}
    process.exit(0);
  });
}

try {
  if (process.env.SYNC_INDEXES !== '0') {
    await Order.syncIndexes();
    console.log('✅ Order indexes synced');
  }
} catch (e) {
  console.warn('⚠️ syncIndexes failed:', e?.message || e);
}

const app = express();

// View engine + Layouts
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.set('trust proxy', 1);

// Static & parsers
app.set('etag', 'strong');
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads'), { maxAge: '7d' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(compression({ level: 6 }));

// Session
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: config.mongoUri }),
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 }
}));

app.use(attachUser);



app.use((req, res, next) => {
  // defaults
  res.locals.flash = null;
  res.locals.resetAllowed = false;
  res.locals.resetEmail = null;

  // flash one-shot from session
  if (req.session) {
    if (req.session.flash) {
      res.locals.flash = req.session.flash;
      req.session.flash = null;
    }
    const g = req.session.resetGrant;
    if (g && g.email && g.tokenId) {
      res.locals.resetAllowed = true;
      res.locals.resetEmail = g.email;
    }
  }
  next();
});

// Inject user to views
app.use(async (req, res, next) => {
  res.locals.me = res.locals.me || null;
  res.locals.balanceText = null;

  const sid = req.session?.user;
  const uid = req.user?._id || sid?._id || sid?.id;
  if (!uid) return next();

  try {
    const user = await User.findById(uid)
      .select('username role balance currency avatarUrl avatar name level totalSpent updatedAt')
      .lean(false);

    if (user) {
      if (typeof user.balance !== 'number') user.balance = config.initialBalance ?? 0;
      if (!user.currency) user.currency = config.currency || 'THB';
      if (user.isModified()) await user.save();

      // base URL จาก request ปัจจุบัน
      const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
      const base  = `${proto}://${req.get('host')}`;

      // สร้าง URL รูป
      let raw = (user.avatarUrl ?? user.avatar ?? '').toString().trim();
      let avatarUrl;
      if (/^https?:\/\//i.test(raw)) {
        avatarUrl = raw;
      } else if (raw) {
        raw = '/' + raw.replace(/^\/+/, '');
        if (!raw.startsWith('/uploads/')) raw = '/uploads/' + raw.replace(/^\/+/, '');
        avatarUrl = `${base}${raw}`;
      } else {
        avatarUrl = `${base}/static/assets/img/user-blue.png`;
      }

      res.locals.me = {
        ...(res.locals.me || {}),
        _id: user._id,
        username: user.username,
        role: user.role,
        balance: user.balance,
        currency: user.currency,
        name: user.name || null,
        level: user.level || '1',
        totalSpent: typeof user.totalSpent === 'number' ? user.totalSpent : 0,
        avatarUrl,
        avatarVer: user.updatedAt ? user.updatedAt.getTime() : Date.now(),
      };

      res.locals.balanceText =
        `${Number(user.balance || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${user.currency || 'THB'}`;
    }
  } catch (e) {
    // เงียบ ๆ
  }
  next();
});

// Routes
app.use(authRoutes);
app.use(resetPasswordRoutes);
app.use(catalogRoutes);
app.use(requireAuth, orderRoutes);
app.use('/', requireAuth, requireAdmin, adminRoutes);
app.use('/admin', requireAuth, requireAdmin, adminPricingRoutes);
app.use(newOrderRoutes);
app.use(requireAuth, walletRoutes);
app.use('/services', servicesRouter);
app.use(requireAuth, changesRoute);
app.use(requireAuth, accountRouter);  
app.use('/', requireAuth, dashboardRouter);
app.use('/otp', otpRouter);
app.use('/api', apiPricingRouter);

// Healthcheck (optional)
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/faq', (req, res) => {
  // ถ้า layout ของคุณมี navbar และคุณไม่อยากให้แสดงในหน้านี้
  // ส่ง flag ไปให้ layout เช็คซ่อน
  res.render('faq', {
    pageTitle: 'คำถามที่พบบ่อย (FAQ)',
    hideNavbar: true        // ใช้ใน layout.ejs: <% if (!hideNavbar) { ...navbar... } %>
  });
});

app.get('/blog', (req, res) => {
  const posts = [
    {
      slug: 'tiktok-fyp',
      title: 'การเพิ่มยอดวิว TikTok: เทคนิคปั้นวิดีโอให้ไวรัลแบบมือโปร',
      dateText: 'March 15, 2019',
      author: 'RTSMM - Thailand',
      thumbnail: '/static/assets/thumbnails/blog1.png',
      excerpt: 'การเพิ่มยอดวิว TikTok: เทคนิคปั้นวิดีโอให้ไวรัลแบบมือโปร ในยุคที่ TikTok...'
    },
    {
      slug: 'follower-ig',
      title: 'รวมเหตุผลที่การ ปั้นไอจี ในปี 2025 ยังคงเป็นตัวเลือกที่ดีที่สุด',
      dateText: 'March 15, 2019',
      author: 'RTSMM - Thailand',
      thumbnail: '/static/assets/thumbnails/blog2.gif',
      excerpt: 'รวมเหตุผลที่การ ปั้นไอจี ในปี 2025...'
    },
    {
      slug: 'view-youtube',
      title: 'เผยอาชีพใหม่ที่ได้ค่าตอบแทนสุดคุ้มค่า เพียงปั้นช่อง Youtube ให้สำเร็จเท่านั้น',
      dateText: 'March 15, 2019',
      author: 'RTSMM - Thailand',
      thumbnail: '/static/assets/thumbnails/blog3.gif',
      excerpt: 'เผยอาชีพใหม่ที่ได้ค่าตอบแทนสุดคุ้มค่า...'
    },
    {
      slug: 'likefanpage-facebook',
      title: 'แชร์เทคนิคการปั้นเฟสบุ๊ก ทำอย่างไรให้หาเงินได้จากแพลตฟอร์มนี้',
      dateText: 'March 15, 2019',
      author: 'RTSMM - Thailand',
      thumbnail: '/static/assets/thumbnails/blog4.gif',
      excerpt: 'แชร์เทคนิคการปั้นเฟสบุ๊ก ทำอย่างไรให้หาเงินได้...'
    },
    {
      slug: 'pumview',
      title: 'วิธีปั๊มวิวง่าย ๆ แต่เป็นอะไรที่ใช้ได้จริง',
      dateText: 'March 15, 2019',
      author: 'RTSMM - Thailand',
      thumbnail: '/static/assets/thumbnails/blog5.gif',
      excerpt: 'วิธีปั๊มวิวง่าย ๆ แต่เป็นอะไรที่ใช้ได้จริง...'
    },
    {
      slug: 'pro-pumlike',
      title: 'ปั๊มไลค์แบบนี้มืออาชีพเขาทำกัน',
      dateText: 'March 15, 2019',
      author: 'RTSMM - Thailand',
      thumbnail: '/static/assets/thumbnails/blog6.gif',
      excerpt: 'ปั๊มไลค์แบบนี้ มืออาชีพเขาทำกัน...'
    }
  ];

  res.render('blog', {
    layout: true,   
    pageTitle: 'บทความ | RTSMM-TH',
    posts
  });
});

app.get('/page/terms-of-use', (req, res) => {
  res.render('terms-of-use', {
    layout: true,                     // ✅ ใช้ layout.ejs
    title: 'เงื่อนไขและข้อตกลง | RTSMM-TH.COM',
    pageTitle: 'Terms of Use',
    bodyClass: 'page-terms'           // (ออปชัน) เอาไว้เผื่อสไตล์เฉพาะหน้านี้
  });
});

// 404 (optional)
app.use((req, res) => res.status(404).send('Not found'));

// 🔁 Auto-sync services เมื่อ DB ยังว่าง (ทำครั้งเดียวตอนบูต)
(async () => {
  try {
    const count = await Category.countDocuments();
    if (!count) {
      const r = await syncServicesFromProvider();
      console.log(`✅ Boot sync done: ${r.count} services`);
    } else {
      console.log(`ℹ️ Categories already present: ${count}`);
    }
  } catch (e) {
    console.error('❌ Boot sync failed (will try again on first visit):',
      e?.response?.data || e.message || e);
  }
})();

(async () => {
  try {
    const r = await User.updateMany(
      { $or: [ { balance: { $exists: false } }, { currency: { $exists: false } } ] },
      { $set: { balance: config.initialBalance ?? 0, currency: config.currency || 'THB' } }
    );
    if (r.modifiedCount) {
      console.log(`✅ Migrated balances for ${r.modifiedCount} user(s).`);
    }
  } catch (e) {
    console.error('❌ Balance migration failed:', e?.message || e);
  }
})();

(async () => {
  try {
    const r = await User.updateMany(
      { $or: [
        { points: { $exists: false } },
        { pointsAccrued: { $exists: false } },
        { pointsRedeemed: { $exists: false } }
      ]},
      { $set: { points: 0, pointsAccrued: 0, pointsRedeemed: 0 } }
    );
    if (r.modifiedCount) {
      console.log(`✅ Initialized points for ${r.modifiedCount} user(s).`);
    }
  } catch (e) {
    console.error('❌ Points init failed:', e?.message || e);
  }
})()

initDailyChangeSync();

const PORT = Number(process.env.PORT || config.port || 3000);
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`🚀 RTSMM-TH listening on 0.0.0.0:${PORT}`);
});