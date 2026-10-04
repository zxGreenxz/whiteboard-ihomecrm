import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function assertInputs(key, context) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof context !== 'string' || context.length < 3) {
    throw new TypeError('Invalid encryption context');
  }
}

export function seal(plaintext, key, context) {
  assertInputs(key, context);
  if (typeof plaintext !== 'string' || !plaintext || Buffer.byteLength(plaintext) > 8 * 1024) {
    throw new TypeError('Invalid plaintext');
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const bytes = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${nonce.toString('base64url')}.${bytes.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

export function open(token, key, context) {
  assertInputs(key, context);
  if (typeof token !== 'string' || token.length > 16 * 1024) throw new TypeError('Invalid ciphertext');
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new TypeError('Invalid ciphertext');
  const nonce = Buffer.from(parts[1], 'base64url');
  const bytes = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  if (nonce.length !== 12 || tag.length !== 16 || bytes.length > 8 * 1024) throw new TypeError('Invalid ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(bytes), decipher.final()]).toString('utf8');
}
