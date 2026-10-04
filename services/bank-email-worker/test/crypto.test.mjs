import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { seal, open } from '../src/crypto.mjs';

test('encrypts opaque token with context and rejects wrong context or tampering', () => {
  const key = randomBytes(32);
  const ciphertext = seal('refresh-token-synthetic', key, 'connection:one');
  assert.equal(open(ciphertext, key, 'connection:one'), 'refresh-token-synthetic');
  assert.doesNotMatch(ciphertext, /refresh-token/u);
  assert.throws(() => open(ciphertext, key, 'connection:two'));
  const pieces = ciphertext.split('.');
  pieces[3] = `${pieces[3][0] === 'A' ? 'B' : 'A'}${pieces[3].slice(1)}`;
  assert.throws(() => open(pieces.join('.'), key, 'connection:one'));
});
