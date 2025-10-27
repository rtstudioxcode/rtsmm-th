// src/lib/banks.js
export const BANKS = [
  // code, label (ใส่ได้ตามรายชื่อในภาพตัวอย่าง)
  { code:'BBL',  label:'ธนาคารกรุงเทพ' },
  { code:'KBANK',label:'ธนาคารกสิกรไทย' },
  { code:'KTB',  label:'ธนาคารกรุงไทย' },
  { code:'BAY',  label:'ธนาคารกรุงศรีอยุธยา' },
  { code:'SCB',  label:'ธนาคารไทยพาณิชย์' },
  { code:'TMB',  label:'ธนาคารทหารไทยธนชาต (TTB)' },
  { code:'CIMB', label:'ธนาคารซีไอเอ็มบีไทย' },
  { code:'UOB',  label:'ธนาคารยูโอบี' },
  { code:'GSB',  label:'ธนาคารออมสิน' },
  { code:'BAAC', label:'ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร' },
  { code:'SME',  label:'ธนาคารพัฒนาวิสาหกิจขนาดกลางและขนาดย่อมแห่งประเทศไทย' },
  { code:'TISCO',label:'ธนาคารทิสโก้' },
  { code:'KKB',  label:'ธนาคารเกียรตินาคินภัทร' },
  { code:'LHFG', label:'ธนาคารแลนด์ แอนด์ เฮ้าส์' },
  { code:'ICBC', label:'ธนาคารไอซีบีซี (ไทย)' },
  { code:'MIZUHO',label:'ธนาคารมิซูโฮ คอร์ปอเรต' },
  { code:'SCBT', label:'ธนาคารสแตนดาร์ดชาร์เตอร์ด (ไทย)' },
  { code:'CITI', label:'ธนาคารซิตี้แบงก์ ประเทศไทย' },
  // …เติมได้ตามที่ต้องการ…
  { code:'TRUEWALLET', label:'TrueMoney Wallet' },
];

export const BANK_CODES = new Set(BANKS.map(b=>b.code));

/** clean และตรวจสอบรูปแบบหมายเลขตามประเภท */
export function normalizeAndValidateAccount({ accountCode, accountNumber }) {
  const code = String(accountCode || '').trim().toUpperCase();
  const raw  = String(accountNumber || '').trim();

  if (!BANK_CODES.has(code)) {
    return { ok:false, error:'รหัสธนาคารไม่ถูกต้อง' };
  }

  // ตัดขีด/ช่องว่างออก
  const digits = raw.replace(/[^\d]/g, '');

  if (code === 'TRUEWALLET') {
    if (!/^0\d{9}$/.test(digits)) {
      return { ok:false, error:'TrueMoney Wallet ต้องเป็นเบอร์มือถือ 10 หลัก ขึ้นต้น 0' };
    }
    return { ok:true, code, number:digits };
  }

  // ธนาคารทั่วไป: ยอมรับ 9–12 หลัก (บางธนาคาร 10–12)
  if (!/^\d{9,12}$/.test(digits)) {
    return { ok:false, error:'เลขบัญชีธนาคารต้องเป็นตัวเลข 9–12 หลัก' };
  }
  return { ok:true, code, number:digits };
}
