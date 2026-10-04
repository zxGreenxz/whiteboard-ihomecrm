import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import { verifyAcbMessage, MessageVerificationError } from '../src/message.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const keyRecord = `v=DKIM1; k=rsa; p=${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`;
const resolver = async (name, type) => {
  assert.equal(name, 'test._domainkey.acb.com.vn');
  assert.equal(type, 'TXT');
  return [[keyRecord]];
};
const body = 'ACB trân trọng thông báo tài khoản 12345678 của Quý khách đã thay đổi số dư như sau:\r\nSố dư mới của tài khoản trên là: 25,900,396.00 VND tính đến 04/10/2026.\r\nGiao dịch mới nhất:Ghi có +2,445,000.00 VND.\r\nNội dung giao dịch: NGUYEN VAN A CHUYEN FT26000123456789 GD FAKEACB123456 041026-14:42:55.\r\n';
const base = `From: ACB <mailalert@acb.com.vn>\r\nTo: customer@example.test\r\nSubject: Synthetic ACB notice\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`;
async function signed(source = base, options = {}) {
  const signature = await dkimSign(source, {
    strict: true,
    headerList: ['from', 'to', 'subject', 'mime-version', 'content-type', 'content-transfer-encoding'],
    signatureData: [{ signingDomain: 'acb.com.vn', selector: 'test', privateKey: privatePem, ...options }],
  });
  assert.deepEqual(signature.errors, []);
  return Buffer.from(signature.signatures + source);
}
async function signedMany(count) {
  const signature = await dkimSign(base, {
    strict: true,
    headerList: ['from', 'to', 'subject', 'mime-version', 'content-type', 'content-transfer-encoding'],
    signatureData: Array.from({ length: count }, (_, index) => ({
      signingDomain: 'acb.com.vn', selector: `test${index}`, privateKey: privatePem,
    })),
  });
  assert.deepEqual(signature.errors, []);
  return Buffer.from(signature.signatures + base);
}

test('accepts a synthetic raw ACB signature covering the entire body and MIME headers', async () => {
  const result = await verifyAcbMessage(await signed(), { resolver });
  assert.equal(result.parsed.amount, 2445000);
  assert.equal(result.parsed.account, '12345678');
});

test('rejects tampered body and forged Authentication-Results', async () => {
  const raw = await signed();
  const tampered = Buffer.from(raw.toString().replace('+2,445,000.00', '+9,445,000.00'));
  await assert.rejects(verifyAcbMessage(tampered, { resolver }), MessageVerificationError);
  const forged = Buffer.from(`Authentication-Results: mx.google.com; dkim=pass header.i=@acb.com.vn\r\n${base}`);
  await assert.rejects(verifyAcbMessage(forged, { resolver }), MessageVerificationError);
});

test('rejects DKIM l= partial body and unsigned MIME content type', async () => {
  await assert.rejects(verifyAcbMessage(await signed(base, { maxBodyLength: 64 }), { resolver }), MessageVerificationError);
  const signature = await dkimSign(base, {
    strict: true, headerList: ['from', 'to', 'subject'],
    signatureData: [{ signingDomain: 'acb.com.vn', selector: 'test', privateKey: privatePem }],
  });
  await assert.rejects(verifyAcbMessage(Buffer.from(signature.signatures + base), { resolver }), MessageVerificationError);
});

test('rejects multiple From addresses and a signed lookalike sender', async () => {
  await assert.rejects(verifyAcbMessage(await signed(base.replace('mailalert@acb.com.vn', 'alert@acb.com.vn')), { resolver }), MessageVerificationError);
  await assert.rejects(verifyAcbMessage(await signed(base.replace('From: ACB <mailalert@acb.com.vn>', 'From: ACB <mailalert@acb.com.vn>, Other <other@example.test>')), { resolver }), MessageVerificationError);
});

test('parses signed HTML without fetching links or images', async () => {
  const html = `<html><body><p>ACB trân trọng thông báo tài khoản 12345678 của Quý khách đã thay đổi số dư như sau:</p><p>Số dư mới của tài khoản trên là: 25,900,396.00 VND tính đến 04/10/2026.</p><p>Giao dịch mới nhất:Ghi có +2,445,000.00 VND.</p><p>Nội dung giao dịch: NGUYEN VAN A CHUYEN FT26000123456789 GD FAKEACB123456 041026-14:42:55.</p><img src="https://evil.example.test/track"></body></html>`;
  const source = base.replace('Content-Type: text/plain; charset=utf-8', 'Content-Type: text/html; charset=utf-8').replace(body, html);
  const result = await verifyAcbMessage(await signed(source), { resolver });
  assert.equal(result.parsed.amount, 2445000);
});

test('accepts default 7bit encoding when the optional top-level transfer header is absent', async () => {
  const source = base.replace('Content-Transfer-Encoding: 8bit\r\n', '');
  const result = await verifyAcbMessage(await signed(source), { resolver });
  assert.equal(result.parsed.account, '12345678');
});

test('DNS verification has a bounded wait when the DKIM lookup stalls', async () => {
  await assert.rejects(verifyAcbMessage(await signed(), { resolver: () => new Promise(() => {}), dnsTimeoutMs: 10 }), MessageVerificationError);
});

test('multiple slow DKIM lookups exhaust one verification budget, then stop new DNS lookups', async () => {
  let resolverCalls = 0;
  const delayedResolver = async () => {
    resolverCalls++;
    await new Promise(resolve => setTimeout(resolve, 40));
    return [[keyRecord]];
  };
  const started = Date.now();
  await assert.rejects(verifyAcbMessage(await signedMany(3), {
    resolver: delayedResolver, dnsTimeoutMs: 100, verificationTimeoutMs: 65,
  }), error => error instanceof MessageVerificationError && error.code === 'DKIM_VERIFY_TIMEOUT');
  assert.ok(Date.now() - started < 200);
  assert.ok(resolverCalls <= 2);
});

test('too many DKIM signatures are rejected before DNS verification', async () => {
  let resolverCalls = 0;
  await assert.rejects(verifyAcbMessage(await signedMany(5), {
    resolver: async () => { resolverCalls++; return [[keyRecord]]; },
  }), error => error instanceof MessageVerificationError && error.code === 'DKIM_SIGNATURE_LIMIT');
  assert.equal(resolverCalls, 0);
});
