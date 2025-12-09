import jwt from "jsonwebtoken";

// ใช้ ENV หรือ fallback (กันตาย)
const SECRET = process.env.JWT_SECRET || "xb291mhs73m1hsaj182jhasj12981asj0s12";

export function signPayload(payload) {
  // อย่าสร้าง exp เอง ปล่อยให้ expiresIn จัดการ
  return jwt.sign(payload, SECRET, {
    expiresIn: "15m"  // อายุ token 15 นาที
  });
}

export function verifyPayload(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch (err) {
    return null;
  }
}
