// Test tuyaCrypto.ts: AES-ECB dựng từ WebCrypto đối chiếu node:crypto (aes-128/192/256-ecb) với khoá/dữ liệu ngẫu
// nhiên nhiều khối, vector NIST SP 800-38A, vector cố định cho luồng vé Tuya, lỗi đệm/độ dài, mật khẩu số ngẫu nhiên.
// Secret dùng ở đây là giá trị MẪU công khai trong tài liệu ký của Tuya (hậu tố _EXAMPLE để cửa quét secret nhận ra);
// khoá còn lại tự sinh hoặc là vector NIST công khai.
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "node:crypto";
import {
  aesEcbDecrypt,
  aesEcbEncrypt,
  decryptTicketKey,
  encryptPassword,
  generateNumericPassword,
  pkcs7Pad,
  pkcs7Unpad,
  TuyaCryptoError,
} from "./tuyaCrypto.ts";

const ACCESS_SECRET_EXAMPLE = "4OHBOnWOqaEC1mWXOpVL3yV50s0qGSRC";
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
const utf8 = (s: string) => new TextEncoder().encode(s);
const random = (n: number) => new Uint8Array(randomBytes(n));

/** Oracle: node:crypto AES-ECB; `padding` = PKCS7 tự động. */
function nodeEcb(mode: "encrypt" | "decrypt", key: Uint8Array, data: Uint8Array, padding: boolean): Uint8Array {
  const algorithm = `aes-${key.length * 8}-ecb`;
  const cipher = mode === "encrypt" ? createCipheriv(algorithm, key, null) : createDecipheriv(algorithm, key, null);
  cipher.setAutoPadding(padding);
  return new Uint8Array([...cipher.update(data), ...cipher.final()]);
}

const isCryptoError = (code: string) => (error: unknown) => {
  assert.ok(error instanceof TuyaCryptoError, String(error));
  assert.equal(error.code, code);
  return true;
};

Deno.test("ECB: vector NIST SP 800-38A F.1.1 (AES-128) và F.1.5 (AES-256), 4 khối", async () => {
  const plain = bytes(
    "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710",
  );
  const vectors = [
    {
      key: "2b7e151628aed2a6abf7158809cf4f3c",
      cipher:
        "3ad77bb40d7a3660a89ecaf32466ef97f5d3d58503b9699de785895a96fdbaaf43b1cd7f598ece23881b00e3ed0306887b0c785e27e8ad3f8223207104725dd4",
    },
    {
      key: "603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4",
      cipher:
        "f3eed1bdb5d2a03c064b5a7e3db181f8591ccb10d410ed26dc5ba74a31362870b6ed21b99ca6f4f9f153e7b1beafed1d23304b7a39f9f3ff067d8d8f9e24ecc7",
    },
  ];
  for (const v of vectors) {
    assert.equal(hex(await aesEcbEncrypt(bytes(v.key), plain)), v.cipher);
    assert.equal(hex(await aesEcbDecrypt(bytes(v.key), bytes(v.cipher))), hex(plain));
  }
});

Deno.test("ECB thô: khớp node:crypto với khoá 16/24/32 byte và 1–6 khối ngẫu nhiên (cả khối cuối toàn 0x10)", async () => {
  for (let i = 0; i < 60; i++) {
    const key = random([16, 24, 32][i % 3]);
    const data = random(16 * (1 + (i % 6)));
    if (i % 10 === 0) data.fill(0x10, data.length - 16); // khối cuối trùng khối đệm đầy
    const cipher = await aesEcbEncrypt(key, data);
    assert.equal(hex(cipher), hex(nodeEcb("encrypt", key, data, false)), `encrypt #${i}`);
    assert.equal(hex(await aesEcbDecrypt(key, cipher)), hex(data), `round-trip #${i}`);
    // Giải bản mã ngẫu nhiên (không phải do mình mã hoá) cũng phải khớp oracle.
    const foreign = random(16 * (1 + (i % 6)));
    assert.equal(hex(await aesEcbDecrypt(key, foreign)), hex(nodeEcb("decrypt", key, foreign, false)), `decrypt #${i}`);
  }
  assert.equal((await aesEcbEncrypt(random(16), new Uint8Array(0))).length, 0);
  assert.equal((await aesEcbDecrypt(random(16), new Uint8Array(0))).length, 0);
  await assert.rejects(aesEcbEncrypt(random(16), random(15)), isCryptoError("bad_input"));
  await assert.rejects(aesEcbDecrypt(random(16), random(17)), isCryptoError("bad_input"));
  await assert.rejects(aesEcbEncrypt(random(20), random(16)), isCryptoError("key_length"));
});

Deno.test("encryptPassword: AES-128-ECB + PKCS7, HEX HOA — khớp node:crypto, kể cả nhiều khối", async () => {
  for (let i = 0; i < 40; i++) {
    const key = random(16);
    const digits = Array.from({ length: 1 + (i % 40) }, () => String(randomInt(10))).join("");
    const out = await encryptPassword(digits, key);
    assert.match(out, /^[0-9A-F]+$/);
    assert.equal(out, hex(nodeEcb("encrypt", key, utf8(digits), true)).toUpperCase(), `#${i} ${digits.length} chữ số`);
    assert.equal(new TextDecoder().decode(nodeEcb("decrypt", key, bytes(out.toLowerCase()), true)), digits);
  }
  // Đúng 16 byte ⇒ thêm nguyên một khối đệm.
  assert.equal((await encryptPassword("0123456789abcdef", random(16))).length, 64);
  await assert.rejects(encryptPassword("123456", random(32)), isCryptoError("key_length"));
  await assert.rejects(encryptPassword("", random(16)), isCryptoError("bad_input"));
});

Deno.test("decryptTicketKey: AES-256-ECB bằng Access Secret, bỏ đệm — khớp node:crypto, nhận hex hoa lẫn thường", async () => {
  for (let i = 0; i < 30; i++) {
    const secret = randomBytes(24).toString("base64"); // 32 ký tự ASCII
    const key = random(16);
    const ticket = hex(nodeEcb("encrypt", utf8(secret), key, true));
    const asGiven = i % 2 === 0 ? ticket.toUpperCase() : ticket;
    assert.equal(hex(await decryptTicketKey(asGiven, secret)), hex(key), `#${i}`);
  }
});

Deno.test("vector cố định: secret mẫu của Tuya + khoá gốc NIST ⇒ ticket_key và mật khẩu đã mã hoá", async () => {
  const ticketKey = "17998CA646016FA7F6E78C6E1FD549139173247C8D56147E406EBA159F6E577A";
  const key = await decryptTicketKey(ticketKey, ACCESS_SECRET_EXAMPLE);
  assert.equal(hex(key), "2b7e151628aed2a6abf7158809cf4f3c");
  assert.equal(await encryptPassword("123456", key), "22666CDD3EC6AD111B264031906C8233");
  assert.equal(await encryptPassword("0123456789", key), "1A387AC74E16477210EB817C3DF28CE9");
});

Deno.test("decryptTicketKey: secret sai độ dài, hex hỏng, đệm hỏng, khoá không 16 byte, secret sai ⇒ TuyaCryptoError", async () => {
  const key = random(16);
  const ticket = hex(nodeEcb("encrypt", utf8(ACCESS_SECRET_EXAMPLE), key, true));
  await assert.rejects(decryptTicketKey(ticket, ACCESS_SECRET_EXAMPLE.slice(1)), isCryptoError("secret_length"));
  await assert.rejects(decryptTicketKey(ticket, `${ACCESS_SECRET_EXAMPLE}x`), isCryptoError("secret_length"));
  // 31 ký tự nhưng 32 byte UTF-8 vẫn là khoá AES-256 hợp lệ: chỉ đếm byte.
  const unicodeSecret = `${ACCESS_SECRET_EXAMPLE.slice(0, 30)}ư`;
  const unicodeTicket = hex(nodeEcb("encrypt", utf8(unicodeSecret), key, true));
  assert.equal(hex(await decryptTicketKey(unicodeTicket, unicodeSecret)), hex(key));
  for (const bad of ["", "abc", "zz".repeat(32), ticket.slice(0, 30), `${ticket}00`]) {
    await assert.rejects(decryptTicketKey(bad, ACCESS_SECRET_EXAMPLE), isCryptoError("bad_hex"), bad);
  }
  // Khối cuối giải ra đệm sai (byte cuối 0x00, rồi 0x11, rồi đệm 0x03 không đồng nhất).
  for (const lastBlock of ["00".repeat(16), "11".repeat(16), `${"00".repeat(13)}020303`]) {
    const raw = hex(nodeEcb("encrypt", utf8(ACCESS_SECRET_EXAMPLE), bytes(`${hex(key)}${lastBlock}`), false));
    await assert.rejects(decryptTicketKey(raw, ACCESS_SECRET_EXAMPLE), isCryptoError("bad_padding"), lastBlock);
  }
  // Khoá gốc 32 byte (không phải 16) ⇒ key_length.
  const long = hex(nodeEcb("encrypt", utf8(ACCESS_SECRET_EXAMPLE), random(32), true));
  await assert.rejects(decryptTicketKey(long, ACCESS_SECRET_EXAMPLE), isCryptoError("key_length"));
  // Secret khác (đúng 32 byte) ⇒ đệm hỏng hoặc độ dài sai, không bao giờ trả khoá.
  await assert.rejects(decryptTicketKey(ticket, "X".repeat(32)), (error: unknown) => error instanceof TuyaCryptoError);
});

Deno.test("pkcs7: thêm/bỏ đệm đúng chuẩn, đệm hỏng bị chặn", () => {
  assert.equal(hex(pkcs7Pad(utf8("123456"))), `${hex(utf8("123456"))}${"0a".repeat(10)}`);
  assert.equal(hex(pkcs7Pad(new Uint8Array(16))), `${"00".repeat(16)}${"10".repeat(16)}`);
  assert.equal(hex(pkcs7Unpad(pkcs7Pad(utf8("abc")))), hex(utf8("abc")));
  for (const bad of [new Uint8Array(0), new Uint8Array(15), new Uint8Array(16), bytes(`${"00".repeat(15)}11`)]) {
    assert.throws(() => pkcs7Unpad(bad), isCryptoError("bad_padding"));
  }
});

Deno.test("generateNumericPassword: 6–10 chữ số, lấy mẫu loại bỏ byte ≥ 250, nguồn hỏng thì ném", () => {
  for (let length = 6; length <= 10; length++) {
    for (let i = 0; i < 20; i++) assert.match(generateNumericPassword(length), new RegExp(`^\\d{${length}}$`));
  }
  for (const bad of [5, 11, 6.5, Number.NaN, 0, -6]) {
    assert.throws(() => generateNumericPassword(bad), isCryptoError("bad_length"), String(bad));
  }
  // Nguồn giả: các byte 250–255 bị bỏ, byte < 250 lấy dư 10.
  const stream = [250, 255, 7, 249, 251, 10, 99, 252, 123, 0, 253, 254, 45];
  let position = 0;
  const fake = (buffer: Uint8Array) => {
    for (let i = 0; i < buffer.length; i++) buffer[i] = stream[position++ % stream.length];
  };
  assert.equal(generateNumericPassword(6, fake), "790930");
  // Nguồn chỉ cho byte ≥ 250 ⇒ không lặp mãi.
  assert.throws(() => generateNumericPassword(6, (buffer) => buffer.fill(250)), isCryptoError("no_entropy"));
  // Phân bố thô: 10 000 chữ số, mỗi chữ số trong khoảng 8–12%.
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 1000; i++) for (const digit of generateNumericPassword(10)) counts[Number(digit)]++;
  for (const count of counts) assert.ok(count > 800 && count < 1200, String(counts));
});
