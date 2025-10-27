// src/lib/banks.js
export const BANKS = [
  // code, label (ใส่ได้ตามรายชื่อในภาพตัวอย่าง)
  { code: "bbl", label: "ธนาคารกรุงเทพ" },
  { code: "kbank", label: "ธนาคารกสิกรไทย" },
  { code: "ktb", label: "ธนาคารกรุงไทย" },
  { code: "bay", label: "ธนาคารกรุงศรีอยุธยา" },
  { code: "scb", label: "ธนาคารไทยพาณิชย์" },
  { code: "tmb", label: "ธนาคารทหารไทยธนชาต (TTB)" },
  { code: "cimb", label: "ธนาคารซีไอเอ็มบีไทย" },
  { code: "uob", label: "ธนาคารยูโอบี" },
  { code: "gsb", label: "ธนาคารออมสิน" },
  { code: "baac", label: "ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร" },
  { code: "sme", label: "ธนาคารพัฒนาวิสาหกิจขนาดกลางและขนาดย่อมแห่งประเทศไทย" },
  { code: "tisco", label: "ธนาคารทิสโก้" },
  { code: "kkb", label: "ธนาคารเกียรตินาคินภัทร" },
  { code: "lhfg", label: "ธนาคารแลนด์ แอนด์ เฮ้าส์" },
  { code: "icbl", label: "ธนาคารไอซีบีซี (ไทย)" },
  { code: "mizuho", label: "ธนาคารมิซูโฮ คอร์ปอเรต" },
  { code: "scbt", label: "ธนาคารสแตนดาร์ดชาร์เตอร์ด (ไทย)" },
  { code: "citi", label: "ธนาคารซิตี้แบงก์ ประเทศไทย" },
  // …เติมได้ตามที่ต้องการ…
  { code: "tw", label: "TrueMoney Wallet" },
];

export const BANK_CODES = new Set(BANKS.map((b) => b.code));

/** clean และตรวจสอบรูปแบบหมายเลขตามประเภท */
export function normalizeAndValidateAccount({ accountCode, accountNumber }) {
  const code = String(accountCode || "").trim();
  const raw = String(accountNumber || "").trim();

  if (!BANK_CODES.has(code)) {
    return { ok: false, error: "รหัสธนาคารไม่ถูกต้อง" };
  }

  // ตัดขีด/ช่องว่างออก
  const digits = raw.replace(/[^\d]/g, "");

  if (code === "tw") {
    if (!/^0\d{9}$/.test(digits)) {
      return {
        ok: false,
        error: "TrueMoney Wallet ต้องเป็นเบอร์มือถือ 10 หลัก ขึ้นต้น 0",
      };
    }
    return { ok: true, code, number: digits };
  }

  // ธนาคารทั่วไป: ยอมรับ 9–12 หลัก (บางธนาคาร 10–12)
  if (!/^\d{10,15}$/.test(digits)) {
    return { ok: false, error: "เลขบัญชีธนาคารต้องเป็นตัวเลข 10-15 หลัก" };
  }
  return { ok: true, code, number: digits };
}
