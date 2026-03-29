// src/routes/bonustime.js
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { BonustimeUser } from "../models/BonustimeUser.js";
import { BonustimeOrder } from "../models/BonustimeOrder.js";
import { recalcUserTotals } from "../services/spend.js";
import { checkAndSendBonustimeExpiryMails } from "../services/bonustimeExpiry.js";

const router = Router();
router.use(requireAuth);

// ===== helper: วันที่แบบไทย =====
const DAY_MS = 24 * 60 * 60 * 1000;
const UPGRADE_LOTTO_PRICE = 1000;

const BT_PACKAGES = {
  normal: { // สล็อต + บาคาร่า
    days: 30,
    price: 2000,
    label: "แพ็กเกจ 1 : สล็อต + บาคาร่า",
  },
  lotto: { // สล็อต + บาคาร่า + หวย
    days: 30,
    price: 2500,
    label: "แพ็กเกจ 2 : สล็อต + บาคาร่า + หวย",
  },
};

function thaiDateString(d = new Date()) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear() + 543;
  return `${dd}/${mm}/${yyyy}`;
}

function parseThaiDate(str) {
  if (!str) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(str).trim());
  if (!m) return null;
  let [, d, mo, y] = m;
  let year = Number(y);
  if (year > 2400) year -= 543; // แปลง พ.ศ. -> ค.ศ.
  return new Date(year, Number(mo) - 1, Number(d));
}

function formatThaiDate(d) {
  const day = String(d.getDate()).padStart(2, "0");
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear() + 543;
  return `${day}/${mo}/${year}`;
}

function calcExpiry(doc) {
  const start = parseThaiDate(doc.LICENSE_START_DATE);
  const duration = Number(doc.LICENSE_DURATION_DAYS) || 0;
  if (!start || !duration) return null;
  return new Date(start.getTime() + duration * DAY_MS);
}

// ===== ราคาแพ็กเกจ (ฝั่งเซิร์ฟเวอร์) =====
// สล็อต + บาคาร่า
const PLANS_NORMAL = [
  { days: 30, price: 1500, label: "1 เดือน", discount: "0%" },
  { days: 90, price: 4050, label: "3 เดือน", discount: "-10%" },
  { days: 180, price: 7200, label: "6 เดือน", discount: "-20%" },
  { days: 365, price: 12600, label: "12 เดือน", discount: "-30%" },
  { days: 730, price: 21600, label: "24 เดือน", discount: "-40%" },
];

// สล็อต + บาคาร่า + หวย
const PLANS_LOTTO = [
  { days: 30, price: 2000, label: "1 เดือน", discount: "0%" },
  { days: 90, price: 5400, label: "3 เดือน", discount: "-10%" },
  { days: 180, price: 9600, label: "6 เดือน", discount: "-20%" },
  { days: 365, price: 16800, label: "12 เดือน", discount: "-30%" },
  { days: 730, price: 28800, label: "24 เดือน", discount: "-40%" },
];

function findPlan(days, includeLotto) {
  const daysNum = Number(days) || 0;
  const list = includeLotto ? PLANS_LOTTO : PLANS_NORMAL;
  return list.find((p) => p.days === daysNum) || null;
}


function calcRemainDaysFromDoc(doc) {
  const exp = calcExpiry(doc);
  if (!exp) return null;
  const now = new Date();
  const diff = exp.getTime() - now.getTime();
  const days = Math.ceil(diff / DAY_MS);
  return days;
}

// ===== routes =====

// หน้าเช็ค serial key ก่อน
router.get("/bonustime", async (req, res) => {
  const user = await User.findById(req.session.user._id).lean();

  res.render("bonustime/index", {
    pageTitle: "Bonustime",
    serial_key: user?.serial_key || null,
  });
});

router.post("/bonustime/register", async (req, res) => {
  const key = "BT-" + Math.random().toString(36).substring(2, 10).toUpperCase();

  await User.findByIdAndUpdate(req.session.user._id, {
    serial_key: key,
  });

  res.redirect("/bonustime");
});

router.get("/bonustime/history", async (req, res) => {
  const user = await User.findById(req.session.user._id).lean();
  const mySerial = user?.serial_key;

  if (!mySerial) {
    return res.json({ ok: true, records: [] });
  }

  const myRecords = await BonustimeUser.find({
    serial_key: mySerial,
  })
    .lean()
    .sort({ tenantId: 1 });

  return res.json({
    ok: true,
    records: myRecords,
  });
});

// โหลดจำนวนสินค้าที่ "ยังไม่มีเจ้าของ" ของแต่ละแพ็กเกจ
router.get("/bonustime/products", async (req, res) => {
  try {
    const baseFilter = { $or: [{ serial_key: null }, { serial_key: "" }] };

    const [normalCount, lottoCount] = await Promise.all([
      BonustimeUser.countDocuments({ ...baseFilter, LOTTO_ENABLED: false }),
      BonustimeUser.countDocuments({ ...baseFilter, LOTTO_ENABLED: true }),
    ]);

    return res.json({
      ok: true,
      packages: {
        normal: { count: normalCount, ...BT_PACKAGES.normal },
        lotto: { count: lottoCount, ...BT_PACKAGES.lotto },
      },
    });
  } catch (err) {
    console.error("GET /bonustime/products error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "ไม่สามารถโหลดข้อมูลสินค้า Bonustime ได้" });
  }
});

// เลือก tenant ที่ยังไม่มีเจ้าของตัวถัดไปของแพ็กเกจที่เลือก
router.get("/bonustime/next", async (req, res) => {
  try {
    const type = req.query.type === "lotto" ? "lotto" : "normal";
    const wantLotto = type === "lotto";

    const filter = {
      $or: [{ serial_key: null }, { serial_key: "" }],
      LOTTO_ENABLED: wantLotto,
    };

    // เดิม: sort แบบตัวอักษร ทำให้ "Server10" มาก่อน "Server7"
    // const item = await BonustimeUser.findOne(filter)
    //   .sort({ tenantId: 1, _id: 1 })
    //   .lean();

    // ใหม่: ใช้ collation แบบ numericOrdering ให้เลขหลังชื่อ server เรียงถูก
    const item = await BonustimeUser.findOne(filter)
      .collation({ locale: "en", numericOrdering: true })
      .sort({ tenantId: 1, _id: 1 })
      .lean();

    if (!item) {
      return res.json({
        ok: false,
        message: "แพ็กเกจนี้สินค้าหมดแล้ว",
      });
    }

    return res.json({
      ok: true,
      item: {
        _id: item._id,
        tenantId: item.tenantId,
      },
    });
  } catch (err) {
    console.error("GET /bonustime/next error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "ไม่สามารถดึงข้อมูล tenant ได้" });
  }
});

// สั่งซื้อแพ็กเกจ Bonustime
router.post("/bonustime/order", async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(401).json({ ok: false, message: "ไม่พบข้อมูลผู้ใช้" });
    }

    if (!user.serial_key) {
      return res.json({
        ok: false,
        message: "กรุณาลงทะเบียน Serial Key ก่อนสั่งซื้อ",
      });
    }

    const {
      bonustimeId,
      packageType,
      NAME,
      CHANNEL_ACCESS_TOKEN,
      CHANNEL_SECRET,
      LOGO,
      LOGIN_URL,
      SIGNUP_URL,
      LINE_ADMIN,
    } = req.body;

    const type = packageType === "lotto" ? "lotto" : "normal";
    const pack = BT_PACKAGES[type];
    if (!pack || !bonustimeId) {
      return res.json({ ok: false, message: "ข้อมูลคำสั่งซื้อไม่ถูกต้อง" });
    }

    const price = pack.price;

    // เช็กเงินในกระเป๋า
    if ((user.balance || 0) < price) {
      return res.json({
        ok: false,
        message: "ยอดเงินในกระเป๋าไม่เพียงพอสำหรับสั่งซื้อแพ็กเกจนี้",
      });
    }

    // ===========================
    // ใช้ server ที่ Modal แสดงจริง ๆ
    // ===========================
    const filter = {
      _id: bonustimeId,                            // ใช้เฉพาะตัวนี้
      $or: [{ serial_key: null }, { serial_key: "" }],
      LOTTO_ENABLED: type === "lotto",
    };

    const record = await BonustimeUser.findOne(filter);
    if (!record) {
      // กันเคสโดนซื้อไปก่อน / ไม่ตรงประเภท
      return res.json({
        ok: false,
        message: "รายการนี้ถูกซื้อไปแล้ว หรือไม่พร้อมใช้งาน",
      });
    }

    // ===========================
    // หัก balance ผู้ใช้
    // ===========================
    user.balance = (user.balance || 0) - price;
    await user.save();

    // ===========================
    // อัปเดตข้อมูลใน rtautobot
    // ===========================
    record.serial_key = user.serial_key;
    record.NAME = NAME || "";
    record.CHANNEL_ACCESS_TOKEN = CHANNEL_ACCESS_TOKEN || "";
    record.CHANNEL_SECRET = CHANNEL_SECRET || "";
    record.LOGO = LOGO || "";
    record.LOGIN_URL = LOGIN_URL || "";
    record.SIGNUP_URL = SIGNUP_URL || "";
    record.LINE_ADMIN = LINE_ADMIN || "";
    record.LICENSE_START_DATE = thaiDateString(new Date());
    record.LICENSE_DURATION_DAYS = pack.days;
    record.LICENSE_DISABLED = false;

    if (type === "lotto") {
      record.note = "แพ็กเกจ 2 (สล็อต+บาคาร่า+หวย)";
    } else {
      record.note = "แพ็กเกจ 1 (สล็อต+บาคาร่า)";
    }

    await record.save();

    //-------------------------------------------
    // 1) เพิ่มยอดใช้จ่าย Bonustime (ไม่ยุ่ง totalSpentRaw)
    //-------------------------------------------
    await User.updateOne(
        { _id: user._id },
        { $inc: { btSpent: price } }
    );

    //-------------------------------------------
    // 2) ค่าคอมแนะนำเพื่อน 500 บาท
    //-------------------------------------------
    let affiliateReward = 0;

    if (user.referredBy) {
        affiliateReward = 500;

        await User.updateOne(
            { _id: user.referredBy },
            {
            $inc: {
                "affiliate.earningsTHB": affiliateReward,
                "affiliate.withdrawableTHB": affiliateReward
            }
            }
        );
    }

    //-------------------------------------------
    // 3) บันทึกประวัติขาย BonustimeOrder
    //-------------------------------------------
    await BonustimeOrder.create({
        user: user._id,
        referrer: user.referredBy || null,
        serialKey: user.serial_key,
        type: "buy",
        packageType: type,
        days: pack.days,
        amountTHB: price,
        affiliateRewardTHB: affiliateReward
    });

    // อัปเดตเลเวล คะแนน และยอดใช้จ่ายทันที
    await recalcUserTotals(user._id, { force: true, fullRescan: false });

    return res.json({
      ok: true,
      plan: {
        type,
        label: pack.label,
        days: pack.days,
        price,
      },
      balance: user.balance,
      tenantId: record.tenantId || null, // เผื่ออยากโชว์ต่อ
    });
  } catch (err) {
    console.error("POST /bonustime/order error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "ไม่สามารถสั่งซื้อแพ็กเกจ Bonustime ได้" });
  }
});

// === บันทึกการแก้ไขข้อมูล (อัปเดต rtautobot.users ของ tenantId นั้น) ===
router.post("/bonustime/:id/update", async (req, res) => {
  try {
    const { id } = req.params;

    const doc = await BonustimeUser.findById(id);
    if (!doc) {
      return res.status(404).json({ ok: false, message: "ไม่พบข้อมูล Bonustime" });
    }

    // whitelist fields ที่อนุญาตให้แก้
    const payload = req.body || {};
    const fields = [
      "NAME",
      "CHANNEL_ACCESS_TOKEN",
      "CHANNEL_SECRET",
      "LOGO",
      "LOGIN_URL",
      "SIGNUP_URL",
      "LINE_ADMIN",
    ];

    for (const f of fields) {
      if (payload[f] !== undefined) {
        doc[f] = payload[f];
      }
    }

    await doc.save(); // ✅ save ตรง BonustimeUser = อัปเดต rtautobot.users ของ tenant นั้นโดยตรงแล้ว

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /bonustime/:id/update error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "เกิดข้อผิดพลาดระหว่างอัปเดตข้อมูล" });
  }
});

// === อัปเกรดเพิ่มหวย (LOTTO_ENABLED = true) ===
router.post("/bonustime/:id/upgrade-lotto", async (req, res) => {
  try {
    const { id } = req.params;

    const [doc, user] = await Promise.all([
      BonustimeUser.findById(id),
      User.findById(req.session.user._id),
    ]);

    if (!doc) {
      return res.status(404).json({ ok: false, message: "ไม่พบข้อมูล Bonustime" });
    }
    if (!user) {
      return res.status(404).json({ ok: false, message: "ไม่พบผู้ใช้" });
    }

    if (doc.LOTTO_ENABLED) {
      return res.json({ ok: false, message: "แพ็กเกจนี้เปิดใช้งานหวยอยู่แล้ว" });
    }

    const price = UPGRADE_LOTTO_PRICE; // fixed 1000
    const balance = Number(user.balance || 0);

    if (balance < price) {
      return res.json({
        ok: false,
        message: "ยอดเงินคงเหลือไม่เพียงพอสำหรับอัปเกรด",
      });
    }

    // หักเงินใน RTSMM-TH
    user.balance = balance - price;

    // อัปเดต LOTTO_ENABLED ใน rtautobot.users (BonustimeUser)
    doc.LOTTO_ENABLED = true;

    await Promise.all([user.save(), doc.save()]);

    //-------------------------------------------
    // เพิ่มยอดใช้จ่าย Bonustime (เฉพาะอัปเกรด)
    //-------------------------------------------
    await User.updateOne(
        { _id: user._id },
        { $inc: { btSpent: price } }
    );

    //-------------------------------------------
    // ค่าคอมแนะนำเพื่อน 250 บาทตอนอัปเกรด
    //-------------------------------------------
    let affiliateReward = 0;
    if (user.referredBy) {
        affiliateReward = 250;
        await User.updateOne(
            { _id: user.referredBy },
            {
            $inc: {
                "affiliate.earningsTHB": affiliateReward,
                "affiliate.withdrawableTHB": affiliateReward
            }
            }
        );
    }

    //-------------------------------------------
    // บันทึก BonustimeOrder
    //-------------------------------------------
    await BonustimeOrder.create({
        user: user._id,
        referrer: user.referredBy || null,
        serialKey: user.serial_key,
        type: "upgrade",
        packageType: "lotto",
        days: 0,
        amountTHB: price,
        affiliateRewardTHB: affiliateReward
    });

    // อัปเดตเลเวล คะแนน และยอดใช้จ่ายทันที
    await recalcUserTotals(user._id, { force: true, fullRescan: false });

    return res.json({
      ok: true,
      balance: user.balance,
    });
  } catch (err) {
    console.error("POST /bonustime/:id/upgrade-lotto error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "ไม่สามารถอัปเกรดแพ็กเกจได้" });
  }
});

// === ต่ออายุการใช้งาน + หัก balance user ===
router.post("/bonustime/:id/extend", async (req, res) => {
  try {
    const { id } = req.params;
    const { days, includeLotto } = req.body || {};

    const includeLottoBool =
      includeLotto === true ||
      includeLotto === "true" ||
      includeLotto === "1";

    const plan = findPlan(days, includeLottoBool);
    if (!plan) {
      return res
        .status(400)
        .json({ ok: false, message: "แพ็กเกจไม่ถูกต้อง" });
    }

    const [doc, user] = await Promise.all([
      BonustimeUser.findById(id),
      User.findById(req.session.user._id),
    ]);

    if (!doc) {
      return res.status(404).json({ ok: false, message: "ไม่พบข้อมูล Bonustime" });
    }
    if (!user) {
      return res.status(404).json({ ok: false, message: "ไม่พบผู้ใช้" });
    }

    const price = Number(plan.price) || 0;
    const currentBalance = Number(user.balance || 0);

    if (currentBalance < price) {
      return res
        .status(400)
        .json({ ok: false, message: "ยอดเงินคงเหลือไม่เพียงพอ" });
    }

    // ---- 1) หัก balance ของ user (RTSMM-TH) ----
    user.balance = currentBalance - price;
    await user.save();

    // ---- 2) ต่ออายุ license ใน rtautobot.users ----
    const now = new Date();

    // ถ้าไม่มีวันเริ่มต้นเลย ให้ตั้งต้นใหม่จากวันนี้
    if (!doc.LICENSE_START_DATE || !doc.LICENSE_DURATION_DAYS) {
      doc.LICENSE_START_DATE = formatThaiDate(now);
      doc.LICENSE_DURATION_DAYS = Number(plan.days);
      doc.LICENSE_DISABLED = false;
    } else {
      const start = parseThaiDate(doc.LICENSE_START_DATE) || now;
      const currentExpire = calcExpiry(doc) || now;

      // ถ้าหมดอายุแล้วให้เริ่มต่อจากวันนี้, ถ้ายังไม่หมดต่อจากวันหมดเดิม
      const base =
        currentExpire.getTime() > now.getTime() ? currentExpire : now;
      const newExpire = new Date(base.getTime() + Number(plan.days) * DAY_MS);

      const newDurationDays = Math.ceil(
        (newExpire.getTime() - start.getTime()) / DAY_MS
      );

      doc.LICENSE_DURATION_DAYS = newDurationDays;
      doc.LICENSE_DISABLED = false;
    }

    await doc.save();

    //-------------------------------------------
    // 1) อัปเดตยอดใช้จ่าย
    //-------------------------------------------
    await User.updateOne(
        { _id: user._id },
        { $inc: { btSpent: price } }
    );

    //-------------------------------------------
    // 2) คอมมิชชั่นแนะนำเพื่อน 200 บาท
    //-------------------------------------------
    let affiliateReward = 0;
    if (user.referredBy) {
        affiliateReward = 200;
        await User.updateOne(
            { _id: user.referredBy },
            {
            $inc: {
                "affiliate.earningsTHB": affiliateReward,
                "affiliate.withdrawableTHB": affiliateReward
            }
            }
        );
    }

    //-------------------------------------------
    // 3) บันทึก BonustimeOrder
    //-------------------------------------------
    await BonustimeOrder.create({
        user: user._id,
        referrer: user.referredBy || null,
        serialKey: user.serial_key,
        type: "renew",
        packageType: includeLottoBool ? "lotto" : "normal",
        days: plan.days,
        amountTHB: price,
        affiliateRewardTHB: affiliateReward
    });

    // อัปเดตเลเวล คะแนน และยอดใช้จ่ายทันที
    await recalcUserTotals(user._id, { force: true, fullRescan: false });

    return res.json({
      ok: true,
      balance: user.balance,
      plan: {
        days: plan.days,
        price: plan.price,
        label: plan.label,
        discount: plan.discount,
      },
    });
  } catch (err) {
    console.error("POST /bonustime/:id/extend error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "เกิดข้อผิดพลาดระหว่างต่ออายุ" });
  }
});

// === ส่งเมลแจ้งเตือน service ใกล้หมดอายุ ===
// เงื่อนไข: เหลือ 1–3 วัน และยังไม่เคยส่งเมลเตือน (expiryNotifySent != true)
router.post("/bonustime/check-expiry-mail", async (req, res) => {
  try {
    const result = await checkAndSendBonustimeExpiryMails({
      logPrefix: "[BonustimeExpiryRoute]",
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("POST /bonustime/check-expiry-mail error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "ไม่สามารถเช็กและส่งเมลแจ้งเตือนได้" });
  }
});

// ===== ส่วนเชื่อมต่อ Railway API (ฉบับแก้ไข Error 400 และ Path 404) =====
import axios from "axios";

const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';
const RAILWAY_TOKEN = process.env.RAILWAY_API_TOKEN || "bafd63e9-6c18-4760-8c40-1251592552c2";
const PROJECT_ID = "6676f236-5084-43a0-bdc6-6902c088ac4d";

async function railwayQuery(query, variables = {}) {
    try {
        const response = await axios.post(RAILWAY_API_URL, { query, variables }, {
            headers: {
                'Authorization': `Bearer ${RAILWAY_TOKEN}`,
                'Content-Type': 'application/json',
            }
        });
        return response.data;
    } catch (error) {
        console.error('[Railway API Error]:', error.response?.data || error.message);
        throw error;
    }
}

// 1. ดึงข้อมูล Service Info (ระวังเรื่อง Path /bonustime นำหน้า)
router.get('/railway/service-info/:tenantId', async (req, res) => {
    try {
        const { tenantId } = req.params;
        console.log(`[Railway] Searching for Tenant: ${tenantId}`);

        // ดึงรายชื่อ Service ทั้งหมด
        const listQuery = `query { project(id: "${PROJECT_ID}") { services { edges { node { id name } } } } }`;
        const listRes = await railwayQuery(listQuery);
        const services = listRes.data?.project?.services?.edges || [];

        let targetServiceId = null;

        // วนลูปเช็ค Variables ทีละตัวเพื่อความชัวร์ (แก้ปัญหา Error 400)
        for (const edge of services) {
            const sId = edge.node.id;
            const varQuery = `query { variables(serviceId: "${sId}") }`;
            const varRes = await railwayQuery(varQuery);
            const vars = varRes.data?.variables || {};

            if (vars.TENANTID === tenantId) {
                targetServiceId = sId;
                break;
            }
        }

        if (!targetServiceId) return res.status(404).json({ ok: false, message: "Service not found" });

        // ดึง Deployment และ Environment ID
        const deployQuery = `query { service(id: "${targetServiceId}") { 
            serviceInstances { edges { node { environmentId } } }
            deployments(first: 1) { edges { node { id status } } } 
        } }`;
        const dRes = await railwayQuery(deployQuery);
        const node = dRes.data?.service;
        
        return res.json({
            ok: true,
            serviceId: targetServiceId,
            environmentId: node?.serviceInstances?.edges[0]?.node?.environmentId,
            deploymentId: node?.deployments?.edges[0]?.node?.id,
            status: node?.deployments?.edges[0]?.node?.status
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// 2. ดึง Logs
router.get('/railway/logs/deploy/:deploymentId', async (req, res) => {
    try {
        const query = `query { deploymentLogs(deploymentId: "${req.params.deploymentId}", limit: 150) { message timestamp } }`;
        const result = await railwayQuery(query);
        res.json({ ok: true, logs: result.data?.deploymentLogs || [] });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// 3. Restart
router.post('/railway/restart', async (req, res) => {
    try {
        const { serviceId, environmentId } = req.body;
        const mutation = `mutation { serviceInstanceRedeploy(serviceId: "${serviceId}", environmentId: "${environmentId}") }`;
        const result = await railwayQuery(mutation);
        res.json({ ok: true, data: result.data });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

export default router;
