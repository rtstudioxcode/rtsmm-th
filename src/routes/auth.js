import express from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';

const router = express.Router();
const parseUrlencoded = express.urlencoded({ extended: false });

// GET /login
router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  const next = typeof req.query.next === 'string' ? req.query.next : '/';
  // ✅ ชี้ไปที่ views/auth/login.ejs ตามไฟล์ที่คุณใช้อยู่
  res.render('auth/login', { title: 'เข้าสู่ระบบ', next });
});

// POST /login
router.post('/login', parseUrlencoded, async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const nextUrl  = (req.body.next && /^\/(?!\/)/.test(req.body.next)) ? req.body.next : '/';

    const user = await User.findOne({ username }).lean(false);
    if (!user) {
      return res.status(400).json({ ok: false, message: 'ไม่พบบัญชีผู้ใช้' });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(400).json({ ok: false, message: 'รหัสผ่านไม่ถูกต้อง' });
    }

    // ✅ ตั้ง session ด้วย _id + สำรอง userId ให้โค้ดเก่า
    req.session.user = {
      _id: String(user._id),
      username: user.username,
      role: user.role || 'user',
    };
    req.session.userId = String(user._id);
    await req.session.save();

    // ✅ ส่ง JSON ให้สคริปต์หน้าฟอร์ม (เพื่อโชว์โมดัลแล้ว redirect)
    return res.json({ ok: true, redirect: nextUrl });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: 'เกิดข้อผิดพลาด' });
  }
});

// GET /register
router.get('/register', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  const next = typeof req.query.next === 'string' ? req.query.next : '/';
  res.render('auth/register', { title: 'สมัครสมาชิก', next });
});

// POST /register
router.post('/register', parseUrlencoded, async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const email    = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const nextUrl  = (req.body.next && /^\/(?!\/)/.test(req.body.next)) ? req.body.next : '/';

    if (!username || !password) {
      return res.status(400).json({ ok: false, message: 'กรอกชื่อผู้ใช้และรหัสผ่าน' });
    }

    const exists = await User.findOne({ username }).lean();
    if (exists) {
      return res.status(400).json({ ok: false, message: 'ชื่อผู้ใช้ถูกใช้งานแล้ว' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // ✅ ใช้ตัวแปรชื่อเดียวตลอด (doc) และบันทึก email ด้วย
    const doc = await User.create({
      username,
      email: email || undefined,  // ค่าว่างจะไม่บันทึก
      passwordHash,
      role: 'user',
    });

    // ✅ ตั้ง session ด้วย doc
    req.session.user = {
      _id: String(doc._id),
      username: doc.username,
      role: doc.role || 'user',
    };
    req.session.userId = String(doc._id);
    await req.session.save();

    // ✅ ตอบ JSON (ให้สคริปต์แสดงโมดัลก่อน redirect)
    return res.status(201).json({ ok: true, redirect: nextUrl });
  } catch (e) {
    console.error(e);
    // duplicate key (เช่น email/username ซ้ำ)
    if (e?.code === 11000) {
      return res.status(400).json({ ok: false, message: 'ข้อมูลซ้ำ กรุณาลองชื่อ/อีเมลอื่น' });
    }
    return res.status(500).json({ ok: false, message: 'สมัครไม่สำเร็จ' });
  }
});


// POST /logout — ใช้กับปุ่มที่ยิง fetch แล้วเด้งด้วย JS
router.post('/logout', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      req.session?.destroy(err => (err ? reject(err) : resolve()));
    });
    // ชื่อคุกกี้ของ express-session ค่าเริ่มต้นคือ connect.sid
    res.clearCookie(process.env.SESSION_NAME || 'connect.sid', { path: '/' });
    return res.json({ ok: true, redirect: '/login' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: 'ออกจากระบบไม่สำเร็จ' });
  }
});

// GET /logout — เผื่อมีลิงก์ธรรมดา ให้ redirect ทันที
router.get('/logout', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      req.session?.destroy(err => (err ? reject(err) : resolve()));
    });
    res.clearCookie(process.env.SESSION_NAME || 'connect.sid', { path: '/' });
  } catch (e) {
    console.error(e);
    // แม้มี error ก็พาออกไปหน้า login เพื่อไม่ค้าง
  }
  return res.redirect('/login');
});

export default router;
