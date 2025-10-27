// src/lib/crypto.js
import crypto from 'crypto';

export function decryptAesGcm(b64, keyStr) {
  if (!b64 || !keyStr) return null;
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const key = crypto.createHash('sha256').update(String(keyStr)).digest(); // 32 bytes

  const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(tag);
  const out = Buffer.concat([dec.update(data), dec.final()]);
  return out.toString('utf8');
}
