// =============================================================
// session-store.js — lưu phiên Zalo MÃ HOÁ at-rest (AES-256-GCM).
//
// Trước đây cookie phiên nằm PLAINTEXT trong worker/sessions/<id>.json —
// một lần lộ file là lộ nick Zalo của công ty. Giờ:
//   • Envelope versioned {v:1, alg:'aes-256-gcm', iv, tag, data} (base64).
//   • Key 32 byte từ env ZALO_SESSION_KEY (64 ký tự hex). Sinh key:
//       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//   • FAIL-CLOSED: thiếu key → worker TỪ CHỐI chạy (index.js chặn từ boot);
//     decrypt hỏng (đổi key/hỏng file) → trả {corrupt:true}, KHÔNG xoá file,
//     KHÔNG fallback plaintext.
//   • CHỐNG DOUBLE-WRAP (bài học WEB2 §13.10): encrypt từ chối input đã là
//     envelope — mã hoá 2 lần → decrypt ra string thay vì object → restore fail.
//   • File plaintext CŨ được tự migrate tại chỗ (đọc → mã hoá → ghi atomic
//     tmp + rename) ngay lần load đầu tiên.
//
// Payload bên trong envelope: { creds: {imei, userAgent, cookie},
//                               savedAt: epoch_ms, expectedUid: string|null }
// savedAt phục vụ proactive re-login (zpw_sek ~7 ngày); expectedUid phục vụ
// guard WRONG_ACCOUNT khi re-login.
// =============================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SESSION_DIR, ZALO_SESSION_KEY, log } from './ctx.js';

const sessFile = (id) => path.join(SESSION_DIR, `${id}.json`);

let KEY = null;
export function sessionKeyReady() {
  if (KEY) return true;
  const hex = String(ZALO_SESSION_KEY || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  KEY = Buffer.from(hex, 'hex');
  return true;
}

function isEnvelope(o) {
  return !!(o && typeof o === 'object' && o.v === 1 && o.alg === 'aes-256-gcm' && o.data && o.iv && o.tag);
}

function encrypt(payload) {
  if (isEnvelope(payload)) {
    // Chống double-wrap: input đã là envelope thì trả nguyên, không bọc lần 2.
    return payload;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    v: 1, alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decrypt(envelope) {
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

// Ghi ATOMIC: tmp + rename — không bao giờ để lại file nửa vời.
function writeAtomic(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

export function saveSession(accountId, payload) {
  if (!sessionKeyReady()) {
    log('saveSession TỪ CHỐI (thiếu ZALO_SESSION_KEY) —', accountId);
    return false;
  }
  try {
    writeAtomic(sessFile(accountId), JSON.stringify(encrypt(payload)));
    return true;
  } catch (e) {
    log('saveSession error', accountId, e.message);
    return false;
  }
}

// Trả về: null (không có file) | {corrupt:true} (không giải mã được — fail-closed)
//        | {creds, savedAt, expectedUid}
export function loadSession(accountId) {
  let raw;
  try { raw = fs.readFileSync(sessFile(accountId), 'utf8'); } catch { return null; }
  let obj;
  try { obj = JSON.parse(raw); } catch { return { corrupt: true }; }

  if (isEnvelope(obj)) {
    if (!sessionKeyReady()) return { corrupt: true };
    try {
      const payload = decrypt(obj);
      // Format cũ hơn (chỉ creds trần bên trong envelope) → chuẩn hoá.
      if (payload && payload.cookie && !payload.creds) {
        return { creds: payload, savedAt: fileMtime(accountId), expectedUid: null };
      }
      return payload;
    } catch {
      return { corrupt: true };
    }
  }

  // File PLAINTEXT legacy {imei, userAgent, cookie} → migrate tại chỗ.
  if (obj && obj.cookie) {
    const payload = { creds: obj, savedAt: fileMtime(accountId), expectedUid: null };
    if (saveSession(accountId, payload)) {
      log('đã mã hoá file phiên plaintext cũ →', accountId);
    }
    return payload;
  }
  return { corrupt: true };
}

function fileMtime(accountId) {
  try { return fs.statSync(sessFile(accountId)).mtimeMs; } catch { return Date.now(); }
}

export function deleteSession(accountId) {
  try { fs.unlinkSync(sessFile(accountId)); } catch { /* không có cũng được */ }
}
