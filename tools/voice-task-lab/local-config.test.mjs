import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocalConfig, loadRuntimeConfig } from './local-config.mjs';

test('capture-only mode never reads the credential vault or enables upstream calls', () => {
  let reads = 0;
  assert.equal(loadRuntimeConfig({VOICE_LAB_CAPTURE_ONLY:'1'}, () => {reads++; throw new Error('must not read');}), null);
  assert.equal(reads, 0);
});

test('uses only the lab-selected key, not historical VPS or local router credentials', () => {
  const config = parseLocalConfig({}, 'NINEROUTER_API_KEY=<key>\n- **API key local**: `sk-local`\n- **API key trên VPS**: `sk-historical`\nVOICE_LAB_NINEROUTER_API_KEY=sk-live-fixture\n');
  assert.equal(config.apiKey, 'sk-live-fixture');
  assert.equal(config.baseUrl, 'https://ai.chillhome.io.vn/v1');
});

test('explicit process configuration wins without reading a second credential file', () => {
  const config = parseLocalConfig({NINEROUTER_API_KEY:'sk-env-fixture', NINEROUTER_BASE_URL:'https://ai.chillhome.io.vn/v1/'}, '');
  assert.equal(config.apiKey, 'sk-env-fixture');
  assert.equal(config.baseUrl, 'https://ai.chillhome.io.vn/v1');
});

test('missing or ambiguous labelled credentials fail without including credential content', () => {
  assert.throws(() => parseLocalConfig({}, 'NINEROUTER_API_KEY=<key>'), /Thiếu/);
  assert.throws(() => parseLocalConfig({}, 'VOICE_LAB_NINEROUTER_API_KEY=sk-a\nVOICE_LAB_NINEROUTER_API_KEY=sk-b'), /nhiều/);
  assert.throws(() => parseLocalConfig({}, '- **API key trên VPS**: `sk-historical`'), /Thiếu/);
  assert.throws(() => parseLocalConfig({}, 'VOICE_LAB_NINEROUTER_API_KEY=<key>'), /Thiếu/);
});

test('refuses a non-HTTPS or unexpected upstream origin rather than leaking the VPS key', () => {
  for (const url of ['http://ai.chillhome.io.vn/v1', 'https://elsewhere.test/v1', 'https://ai.chillhome.io.vn/v1?token=secret']) {
    assert.throws(() => parseLocalConfig({NINEROUTER_API_KEY:'sk-fixture', NINEROUTER_BASE_URL:url}, ''), /9Router/);
  }
});

test('malformed endpoint errors never retain the raw configured URL', () => {
  let error;
  try { parseLocalConfig({NINEROUTER_API_KEY:'sk-fixture', NINEROUTER_BASE_URL:'not-a-url-with-fixture-secret'}, ''); }
  catch (cause) { error = cause; }
  assert.ok(error instanceof Error);
  assert.match(error.message, /9Router/);
  assert.equal('input' in error, false);
  assert.equal(String(error.stack).includes('fixture-secret'), false);
});
