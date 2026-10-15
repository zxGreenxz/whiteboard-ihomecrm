import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const DOMAIN = 'ihomecrm/hermes/user-session:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN = /^[\x21-\x7e]{1,16384}$/;
const BINDING_KEYS = ['assistantId', 'userId', 'organizationId', 'sessionId'];
const ENVELOPE_KEYS = ['v', 'algorithm', 'keyVersion', 'nonce', 'ciphertext', 'tag'];
const record = (value) => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export class SessionCryptoError extends Error {
  constructor(code = 'session_ciphertext_invalid') { super(code); this.name = 'SessionCryptoError'; this.code = code; }
}
const fail = (code) => { throw new SessionCryptoError(code); };

export function validateSessionBinding(value) {
  if (!exact(value, BINDING_KEYS) || BINDING_KEYS.slice(0, 3).some((key) => typeof value[key] !== 'string' || !UUID.test(value[key])) ||
      typeof value.sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.sessionId)) fail('session_binding_invalid');
  return Object.fromEntries(BINDING_KEYS.map((key) => [key, value[key]]));
}

export function validateSessionMaterial(value) {
  if (!exact(value, ['accessToken', 'refreshToken', 'expiresAt']) ||
      typeof value.accessToken !== 'string' || !TOKEN.test(value.accessToken) ||
      typeof value.refreshToken !== 'string' || !TOKEN.test(value.refreshToken) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1) fail('session_material_invalid');
  return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt };
}

function decode(value, length, cap) {
  if (typeof value !== 'string' || value.length < 1 || value.length > Math.ceil(cap * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || bytes.length > cap || (length !== null && bytes.length !== length)) fail();
  return bytes;
}

/** Inject decoded key material from a trusted secret loader. Never reads env or disk.
 * Keep retired keys in this bounded keyring only during the explicit rewrap window.
 * Removing a version makes its ciphertext unreadable; there is no plaintext fallback.
 */
export function createSessionCrypto({ activeKeyVersion, keys, maxPlaintextBytes = 40_000 } = {}) {
  if (typeof activeKeyVersion !== 'string' || !VERSION.test(activeKeyVersion) || !(keys instanceof Map) ||
      keys.size < 1 || keys.size > 16 || !keys.has(activeKeyVersion) ||
      !Number.isSafeInteger(maxPlaintextBytes) || maxPlaintextBytes < 1024 || maxPlaintextBytes > 65_536) fail('session_crypto_config_invalid');
  const keyring = new Map();
  for (const [version, key] of keys) {
    if (typeof version !== 'string' || !VERSION.test(version) || !(key instanceof Uint8Array) || key.byteLength !== 32) fail('session_crypto_config_invalid');
    keyring.set(version, Buffer.from(key));
  }
  let destroyed = false;
  const keyFor = (version) => {
    if (destroyed || !keyring.has(version)) fail('session_key_unavailable');
    return keyring.get(version);
  };
  const aad = (binding, version) => Buffer.from(JSON.stringify([DOMAIN, 1, 'A256GCM', version,
    binding.assistantId, binding.userId, binding.organizationId, binding.sessionId]), 'utf8');

  function seal(material, suppliedBinding) {
    const binding = validateSessionBinding(suppliedBinding);
    const plaintext = Buffer.from(JSON.stringify(validateSessionMaterial(material)), 'utf8');
    try {
      if (plaintext.length > maxPlaintextBytes) fail('session_material_invalid');
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keyFor(activeKeyVersion), nonce, { authTagLength: 16 });
      cipher.setAAD(aad(binding, activeKeyVersion));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { v: 1, algorithm: 'A256GCM', keyVersion: activeKeyVersion,
        nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
    } finally { plaintext.fill(0); }
  }

  function open(envelope, suppliedBinding) {
    const binding = validateSessionBinding(suppliedBinding);
    if (!exact(envelope, ENVELOPE_KEYS) || envelope.v !== 1 || envelope.algorithm !== 'A256GCM' ||
        typeof envelope.keyVersion !== 'string' || !VERSION.test(envelope.keyVersion)) fail();
    const key = keyFor(envelope.keyVersion);
    let plaintext;
    try {
      const nonce = decode(envelope.nonce, 12, 12);
      const tag = decode(envelope.tag, 16, 16);
      const ciphertext = decode(envelope.ciphertext, null, maxPlaintextBytes);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      decipher.setAAD(aad(binding, envelope.keyVersion)); decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return validateSessionMaterial(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
    } catch { fail(); }
    finally { plaintext?.fill(0); }
  }

  return Object.freeze({ seal, open,
    rewrap(envelope, binding) { return seal(open(envelope, binding), binding); },
    destroy() { for (const key of keyring.values()) key.fill(0); keyring.clear(); destroyed = true; },
  });
}
