// Mã hoá cho mật khẩu tạm của khoá cửa Tuya (password-ticket ⇒ temp-password), chỉ dùng WebCrypto.
//
//   ticket_key (hex) --AES-256-ECB giải, khoá = UTF-8 của Access Secret (đúng 32 byte), bỏ đệm PKCS7--> khoá gốc 16 byte
//   mật khẩu số      --AES-128-ECB mã hoá bằng khoá gốc, đệm PKCS7--> HEX HOA gửi cho Tuya
//
// WebCrypto không có ECB ⇒ dựng từ AES-CBC với IV = 0:
//   - Mã hoá một khối P: AES-CBC(iv=0, P) ra 32 byte (khối 2 là khối đệm WebCrypto tự thêm) ⇒ 16 byte đầu = E(P).
//   - Giải cả chuỗi C_1..C_n: CBC giải P_i = D(C_i) XOR C_{i-1} (C_0 = IV = 0) nhưng WebCrypto đòi đệm hợp lệ ở khối
//     cuối ⇒ nối thêm khối X = E(C_n XOR 0x10…) — CBC giải X ra đúng khối đệm đầy (16 × 0x10) và WebCrypto tự bỏ khối
//     đó; còn lại XOR từng khối i ≥ 2 với C_{i-1} là được D(C_i).
// Đối chiếu với node:crypto (aes-128/256-ecb) trong tuyaCrypto.test.ts.
// Không ghi log khoá hay mật khẩu.

export class TuyaCryptoError extends Error {
  /** secret_length | bad_hex | bad_padding | key_length | bad_input | bad_length | no_entropy */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TuyaCryptoError";
    this.code = code;
  }
}

const BLOCK = 16;
const ZERO_IV = new Uint8Array(BLOCK);
const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function fromHex(hex: unknown): Uint8Array<ArrayBuffer> {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(hex)) {
    throw new TuyaCryptoError("bad_hex", "ticket_key không phải chuỗi hex hợp lệ");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function checkAesKey(key: unknown): Uint8Array<ArrayBuffer> {
  if (!(key instanceof Uint8Array) || ![16, 24, 32].includes(key.length)) {
    throw new TuyaCryptoError("key_length", "Khoá AES phải 16, 24 hoặc 32 byte");
  }
  return new Uint8Array(key);
}

function checkBlocks(data: unknown): Uint8Array<ArrayBuffer> {
  if (!(data instanceof Uint8Array) || data.length % BLOCK !== 0) {
    throw new TuyaCryptoError("bad_input", "Dữ liệu ECB phải là bội số của 16 byte");
  }
  return new Uint8Array(data);
}

async function importCbcKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
}

/** E(block): 16 byte đầu của AES-CBC(iv = 0, block) — 16 byte sau là khối đệm WebCrypto tự thêm, bỏ. */
async function encryptBlock(key: CryptoKey, block: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: ZERO_IV }, key, block));
  return out.slice(0, BLOCK);
}

/** AES-ECB mã hoá thô (KHÔNG đệm): dữ liệu phải là bội số 16 byte. */
export async function aesEcbEncrypt(rawKey: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const plain = checkBlocks(data);
  const key = await importCbcKey(checkAesKey(rawKey));
  const blocks: Array<Promise<Uint8Array<ArrayBuffer>>> = [];
  for (let i = 0; i < plain.length; i += BLOCK) blocks.push(encryptBlock(key, plain.slice(i, i + BLOCK)));
  const out = new Uint8Array(plain.length);
  (await Promise.all(blocks)).forEach((block, index) => out.set(block, index * BLOCK));
  return out;
}

/** AES-ECB giải thô (KHÔNG bỏ đệm): dữ liệu phải là bội số 16 byte. */
export async function aesEcbDecrypt(rawKey: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cipher = checkBlocks(data);
  const key = await importCbcKey(checkAesKey(rawKey));
  const n = cipher.length;
  if (n === 0) return new Uint8Array(0);
  const lastXorPad = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) lastXorPad[i] = cipher[n - BLOCK + i] ^ BLOCK;
  const input = new Uint8Array(n + BLOCK);
  input.set(cipher);
  input.set(await encryptBlock(key, lastXorPad), n);
  const out = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ZERO_IV }, key, input));
  if (out.length !== n) throw new TuyaCryptoError("bad_padding", "Giải ECB lệch độ dài");
  // P_i = D(C_i) XOR C_{i-1} ⇒ D(C_i) = P_i XOR C_{i-1}; khối đầu đã XOR với IV = 0.
  for (let i = BLOCK; i < n; i++) out[i] ^= cipher[i - BLOCK];
  return out;
}

export function pkcs7Pad(data: Uint8Array): Uint8Array {
  const pad = BLOCK - (data.length % BLOCK);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

export function pkcs7Unpad(data: Uint8Array): Uint8Array {
  const pad = data.length > 0 && data.length % BLOCK === 0 ? data[data.length - 1] : 0;
  if (pad < 1 || pad > BLOCK) throw new TuyaCryptoError("bad_padding", "Đệm PKCS7 không hợp lệ");
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) throw new TuyaCryptoError("bad_padding", "Đệm PKCS7 không hợp lệ");
  }
  return data.slice(0, data.length - pad);
}

/**
 * Giải `ticket_key` của Tuya ra khoá gốc 16 byte: AES-256-ECB, khoá = UTF-8 của Access Secret (đúng 32 byte),
 * bỏ đệm PKCS7 có kiểm. Secret sai thì gần như chắc chắn hỏng đệm ⇒ ném `bad_padding`.
 */
export async function decryptTicketKey(ticketKeyHex: string, accessSecret: string): Promise<Uint8Array> {
  const secret = encoder.encode(typeof accessSecret === "string" ? accessSecret : "");
  if (secret.length !== 32) throw new TuyaCryptoError("secret_length", "Access Secret phải đúng 32 byte (khoá AES-256)");
  const cipher = fromHex(ticketKeyHex);
  if (cipher.length % BLOCK !== 0) throw new TuyaCryptoError("bad_hex", "ticket_key phải là bội số của 16 byte");
  const key = pkcs7Unpad(await aesEcbDecrypt(secret, cipher));
  if (key.length !== 16) throw new TuyaCryptoError("key_length", "Khoá giải từ ticket_key phải đúng 16 byte");
  return key;
}

/** Mã hoá mật khẩu bằng khoá gốc 16 byte: AES-128-ECB, đệm PKCS7, trả HEX HOA. */
export async function encryptPassword(plain: string, key: Uint8Array): Promise<string> {
  if (typeof plain !== "string" || plain === "") throw new TuyaCryptoError("bad_input", "Mật khẩu trống");
  if (!(key instanceof Uint8Array) || key.length !== 16) {
    throw new TuyaCryptoError("key_length", "Khoá mã hoá mật khẩu phải đúng 16 byte (AES-128)");
  }
  return toHex(await aesEcbEncrypt(key, pkcs7Pad(encoder.encode(plain)))).toUpperCase();
}

export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 10;

/**
 * Mật khẩu số ngẫu nhiên 6–10 chữ số. Lấy mẫu loại bỏ: byte ≥ 250 (= 25 × 10) bị bỏ để mỗi chữ số đều xác suất 1/10
 * (lấy dư thẳng 256 % 10 sẽ lệch về 0–5). `fillRandom` chỉ để test thay nguồn ngẫu nhiên.
 */
export function generateNumericPassword(
  length: number,
  fillRandom: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => {
    crypto.getRandomValues(bytes);
  },
): string {
  if (!Number.isInteger(length) || length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new TuyaCryptoError("bad_length", `Độ dài mật khẩu phải ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} chữ số`);
  }
  const buffer = new Uint8Array(32);
  let out = "";
  // Nguồn thật cạn 64 lượt liền (xác suất ~ (6/256)^2048) là nguồn hỏng — ném thay vì lặp mãi.
  for (let round = 0; round < 64 && out.length < length; round++) {
    fillRandom(buffer);
    for (const byte of buffer) {
      if (byte >= 250) continue;
      out += String(byte % 10);
      if (out.length === length) break;
    }
  }
  if (out.length !== length) throw new TuyaCryptoError("no_entropy", "Nguồn ngẫu nhiên không cho đủ chữ số");
  return out;
}
