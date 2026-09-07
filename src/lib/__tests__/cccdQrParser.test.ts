import { describe, expect, it } from 'vitest';
import type { Candidate } from '../qr/types';
import {
  parseCccdQr,
  selectCccdCandidate,
  validateCccdQr,
} from '../cccdQrParser';

const payload =
  '001234567890||Nguyễn Minh An|29022000|Nữ|12 Đường Mẫu, Phường Thử|06052022';

const candidate = (text: string, engine: Candidate['engine'] = 'native'): Candidate => ({
  text,
  engine,
});

describe('validateCccdQr', () => {
  it('keeps leading zeroes and Unicode from a valid seven-field prefix', () => {
    expect(validateCccdQr(`\uFEFF  ${payload}\r\n`)).toEqual({
      status: 'valid',
      data: {
        idNumber: '001234567890',
        fullName: 'Nguyễn Minh An',
        dateOfBirth: '2000-02-29',
        gender: 'Nữ',
        permanentAddress: '12 Đường Mẫu, Phường Thử',
        idIssueDate: '2022-05-06',
        idIssuePlace: 'Cục Cảnh Sát',
      },
    });
  });

  it('accepts the verified eleven-field shape while ignoring extension meanings', () => {
    const extended = `${payload}|EXT-A|EXT-B|EXT-C|EXT-D`;
    expect(validateCccdQr(extended)).toEqual(validateCccdQr(payload));
  });

  it('accepts an empty legacy CMND field', () => {
    expect(validateCccdQr(payload).status).toBe('valid');
  });

  it.each([
    ['Male', 'Nam'],
    ['Female', 'Nữ'],
  ])('normalizes the observed %s gender value', (rawGender, expectedGender) => {
    const raw = payload.replace('|Nữ|', `|${rawGender}|`);
    const result = validateCccdQr(raw);
    expect(result.status).toBe('valid');
    if (result.status === 'valid') expect(result.data.gender).toBe(expectedGender);
  });

  it.each([
    ['non-leap February', payload.replace('29022000', '29021999')],
    ['31 February', payload.replace('29022000', '31022000')],
    ['invalid issue date', payload.replace('06052022', '31042022')],
    ['short CCCD', payload.replace('001234567890', '123456789')],
    ['CCCD with internal whitespace', payload.replace('001234567890', '001234 567890')],
    ['empty name', payload.replace('Nguyễn Minh An', '')],
    ['unknown gender', payload.replace('|Nữ|', '|Không rõ|')],
    ['URL QR', 'https://example.invalid/a|b|c|d|e|f|g'],
    ['arbitrary seven fields', '1|2|A|01012000|Nam|x|01012020'],
    ['unsupported extension length', `${payload}|UNKNOWN`],
  ])('rejects %s', (_label, raw) => {
    expect(validateCccdQr(raw).status).toBe('invalid');
  });
});

describe('selectCccdCandidate', () => {
  it('returns the only valid CCCD among unrelated QR payloads', () => {
    expect(selectCccdCandidate([
      candidate('https://example.invalid/qr'),
      candidate(payload, 'wechat'),
    ])).toEqual({ status: 'valid', data: parseCccdQr(payload) });
  });

  it('does not treat the same payload from two engines as ambiguous', () => {
    expect(selectCccdCandidate([candidate(payload), candidate(payload, 'zxing-wasm')]).status)
      .toBe('valid');
  });

  it('collapses equivalent parsed identities across supported payload shapes', () => {
    const equivalent = `${payload.replace('|Nữ|', '|Female|')}|EXT-A|EXT-B|EXT-C|EXT-D`;
    expect(selectCccdCandidate([candidate(payload), candidate(equivalent, 'wechat')])).toEqual({
      status: 'valid',
      data: parseCccdQr(payload),
    });
  });

  it('returns invalid when decoded QR candidates are not CCCD', () => {
    expect(selectCccdCandidate([candidate('https://example.invalid/qr')])).toEqual({
      status: 'invalid',
    });
  });

  it('returns ambiguous instead of choosing the first of two CCCDs', () => {
    const other = payload.replace('001234567890', '009876543210');
    expect(selectCccdCandidate([candidate(payload), candidate(other)])).toEqual({
      status: 'ambiguous',
    });
  });

  it('keeps the same ID with conflicting identity fields ambiguous', () => {
    const conflicting = payload
      .replace('Nguyễn Minh An', 'Nguyễn Minh Bình')
      .replace('29022000', '01012001')
      .replace('12 Đường Mẫu, Phường Thử', '99 Đường Khác');
    expect(selectCccdCandidate([candidate(payload), candidate(conflicting)])).toEqual({
      status: 'ambiguous',
    });
  });
});

describe('parseCccdQr compatibility', () => {
  it('returns null for absent input and throws for a non-empty invalid payload', () => {
    expect(parseCccdQr(null)).toBeNull();
    expect(parseCccdQr(undefined)).toBeNull();
    expect(parseCccdQr('   ')).toBeNull();
    expect(() => parseCccdQr('only|three|fields')).toThrow(/CCCD/);
  });
});
