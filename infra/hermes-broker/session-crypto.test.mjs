import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSessionCrypto, SessionCryptoError } from './session-crypto.mjs';

const binding = { assistantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  organizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sessionId: 'dedicated-session-1' };
const material = { accessToken: 'private-access-token', refreshToken: 'private-refresh-token', expiresAt: 2_000_000 };
const config = () => ({ activeKeyVersion: 'v1', keys: new Map([['v1', randomBytes(32)]]) });
const flip = (text) => { const bytes = Buffer.from(text, 'base64url'); bytes[0] ^= 1; return bytes.toString('base64url'); };

test('encrypted envelopes round-trip with fresh nonces and contain no raw material', () => {
  const crypto = createSessionCrypto(config());
  const a = crypto.seal(material, binding), b = crypto.seal(material, binding);
  assert.deepEqual(crypto.open(a, binding), material);
  assert.notEqual(a.nonce, b.nonce); assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(Buffer.from(a.nonce, 'base64url').length, 12);
  assert.equal(Buffer.from(a.tag, 'base64url').length, 16);
  assert.ok(!JSON.stringify(a).includes(material.accessToken));
  assert.ok(!JSON.stringify(a).includes(material.refreshToken));
});

test('AAD binds every assistant, user, company and dedicated session', () => {
  const crypto = createSessionCrypto(config()), envelope = crypto.seal(material, binding);
  for (const key of Object.keys(binding)) {
    const changed = key === 'sessionId' ? 'other-session' : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    assert.throws(() => crypto.open(envelope, { ...binding, [key]: changed }), { code: 'session_ciphertext_invalid' });
  }
});

test('strict envelope decoding rejects nonce, tag, format, ciphertext and extra fields', () => {
  const crypto = createSessionCrypto(config()), envelope = crypto.seal(material, binding);
  for (const change of [{ nonce: flip(envelope.nonce) }, { nonce: '' }, { nonce: 'a'.repeat(17) },
    { nonce: envelope.nonce + '=' }, { tag: flip(envelope.tag) }, { tag: 'abcd' },
    { ciphertext: flip(envelope.ciphertext) }, { ciphertext: '*' }, { ciphertext: '' },
    { ciphertext: 'a'.repeat(100_000) }, { algorithm: 'none' }, { v: 2 }, { extra: 'field' }]) {
    assert.throws(() => crypto.open({ ...envelope, ...change }, binding), { code: 'session_ciphertext_invalid' });
  }
});

test('rotation authenticates key version, permits explicit rewrap and fails after key retirement', () => {
  const oldKey = randomBytes(32), newKey = randomBytes(32);
  const old = createSessionCrypto({ activeKeyVersion: 'v1', keys: new Map([['v1', oldKey]]) });
  const envelope = old.seal(material, binding);
  const rotated = createSessionCrypto({ activeKeyVersion: 'v2', keys: new Map([['v1', oldKey], ['v2', newKey]]) });
  assert.deepEqual(rotated.open(envelope, binding), material);
  const next = rotated.rewrap(envelope, binding);
  assert.equal(next.keyVersion, 'v2'); assert.notEqual(next.nonce, envelope.nonce);
  const retired = createSessionCrypto({ activeKeyVersion: 'v2', keys: new Map([['v2', newKey]]) });
  assert.deepEqual(retired.open(next, binding), material);
  assert.throws(() => retired.open(envelope, binding), { code: 'session_key_unavailable' });
  assert.throws(() => rotated.open({ ...envelope, keyVersion: 'v2' }, binding), { code: 'session_ciphertext_invalid' });
  // Even two versions accidentally containing the same bytes cannot rename AAD.
  const duplicate = createSessionCrypto({ activeKeyVersion: 'v2', keys: new Map([['v1', oldKey], ['v2', oldKey]]) });
  assert.throws(() => duplicate.open({ ...envelope, keyVersion: 'v2' }, binding), { code: 'session_ciphertext_invalid' });
});

test('keyring is copied and destroyed instances fail closed without mutating the supplied secret', () => {
  const supplied = config(), saved = Buffer.from(supplied.keys.get('v1'));
  const crypto = createSessionCrypto(supplied), envelope = crypto.seal(material, binding);
  supplied.keys.get('v1').fill(0); supplied.keys.clear();
  assert.deepEqual(crypto.open(envelope, binding), material);
  crypto.destroy();
  assert.throws(() => crypto.open(envelope, binding), { code: 'session_key_unavailable' });
  assert.throws(() => crypto.seal(material, binding), { code: 'session_key_unavailable' });
  const input = new Map([['v1', saved]]), next = createSessionCrypto({ activeKeyVersion: 'v1', keys: input });
  next.destroy(); assert.ok(saved.some((byte) => byte !== 0));
});

test('invalid keyring, caps, identity and credential shapes never fall back to plaintext', () => {
  for (const extra of [{ activeKeyVersion: '' }, { activeKeyVersion: 'absent' }, { keys: {} }, { keys: new Map() },
    { keys: new Map([['v1', Buffer.alloc(31)]]) }, { keys: new Map([['v1', 'x'.repeat(32)]]) },
    { maxPlaintextBytes: 65_537 }, { maxPlaintextBytes: 0 }, { maxPlaintextBytes: 1024.5 }]) {
    assert.throws(() => createSessionCrypto({ ...config(), ...extra }), { code: 'session_crypto_config_invalid' });
  }
  const crypto = createSessionCrypto({ ...config(), maxPlaintextBytes: 1024 });
  for (const bad of [{ ...binding, userId: { toString: () => binding.userId } }, { ...binding, sessionId: 'bad\n' }, { ...binding, extra: true }]) {
    assert.throws(() => crypto.seal(material, bad), { code: 'session_binding_invalid' });
  }
  for (const bad of [{ ...material, accessToken: '' }, { ...material, refreshToken: 'has whitespace' },
    { ...material, expiresAt: Infinity }, { ...material, expiresAt: 0 }, { ...material, extra: true },
    { ...material, accessToken: 'a'.repeat(1100) }]) {
    assert.throws(() => crypto.seal(bad, binding), { code: 'session_material_invalid' });
  }
  assert.throws(() => crypto.open(material, binding), SessionCryptoError);
});
