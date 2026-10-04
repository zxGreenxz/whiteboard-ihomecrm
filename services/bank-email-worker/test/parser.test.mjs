import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAcbEmail, AcbParseError } from '../src/parser.mjs';

const description = 'NGUYEN VAN A CHUYEN FT26000123456789 GD FAKEACB123456 041026-14:42:55';
const vietnamese = `ACB trân trọng thông báo tài khoản 12345678 của Quý khách đã thay đổi số dư như sau:\nSố dư mới của tài khoản trên là: 25,900,396.00 VND tính đến 04/10/2026.\nGiao dịch mới nhất:Ghi có +2,445,000.00 VND.\nNội dung giao dịch: ${description}.`;
const english = `ACB respectfully updates your 12345678 account balance, as follows:\nUpdated account balance: 25,900,396.00 VND up to 04/10/2026.\nLatest transaction: Credit +2,445,000.00 VND.\nContent: ${description}.`;

test('parses one matching Vietnamese and English credit, excluding balance from amount', () => {
  assert.deepEqual(parseAcbEmail(`${vietnamese}\n\n${english}`), {
    account: '12345678', amount: 2445000, balance: 25900396,
    currency: 'VND', direction: 'CREDIT', occurredAt: '2026-10-04T07:42:55.000Z',
    bankReference: 'GD:FAKEACB123456:041026-14:42:55', description,
  });
});

test('parses a debit as debit and never infers credit from positive balance', () => {
  const body = `${vietnamese.replace('Ghi có +2,445,000.00', 'Ghi nợ -2,445,000.00')}\n${english.replace('Credit +2,445,000.00', 'Debit -2,445,000.00')}`;
  assert.equal(parseAcbEmail(body).direction, 'DEBIT');
});

test('rejects mismatched bilingual amount and account', () => {
  assert.throws(() => parseAcbEmail(`${vietnamese}\n${english.replace('Credit +2,445,000.00', 'Credit +2,445,001.00')}`), AcbParseError);
  assert.throws(() => parseAcbEmail(`${vietnamese}\n${english.replace('your 12345678', 'your 87654321')}`), AcbParseError);
});

test('rejects missing GD suffix, multiple account announcements, and malformed monetary separators', () => {
  assert.throws(() => parseAcbEmail(`${vietnamese.replace('GD FAKEACB123456 ', '')}\n${english.replace('GD FAKEACB123456 ', '')}`), AcbParseError);
  assert.throws(() => parseAcbEmail(`${vietnamese}\n${english}\n${vietnamese.replace('12345678', '87654321')}`), AcbParseError);
  assert.throws(() => parseAcbEmail(`${vietnamese.replace('2,445,000.00', '2,44,5000.00')}\n${english}`), AcbParseError);
});

test('uses distinct GD identity when different bank events share the same FT in description', () => {
  const first = parseAcbEmail(vietnamese);
  const second = parseAcbEmail(vietnamese.replace('GD FAKEACB123456', 'GD FAKEACB654321'));
  assert.notEqual(first.bankReference, second.bankReference);
  assert.throws(() => parseAcbEmail(`${vietnamese}\n${english.replace('GD FAKEACB123456', 'GD FAKEACB654321')}`), AcbParseError);
});

test('accepts one language but rejects huge or unrelated text', () => {
  assert.equal(parseAcbEmail(vietnamese).amount, 2445000);
  assert.throws(() => parseAcbEmail('hello'), AcbParseError);
  assert.throws(() => parseAcbEmail('x'.repeat(200_000)), AcbParseError);
});

test('accepts Vietnamese thousands and decimal separators while rejecting invalid calendar dates', () => {
  const localized = vietnamese.replace('25,900,396.00', '25.900.396,00').replace('2,445,000.00', '2.445.000,00');
  assert.equal(parseAcbEmail(localized).amount, 2445000);
  assert.throws(() => parseAcbEmail(vietnamese.replaceAll('04/10/2026', '31/02/2026').replace('041026-', '310226-')), AcbParseError);
});
