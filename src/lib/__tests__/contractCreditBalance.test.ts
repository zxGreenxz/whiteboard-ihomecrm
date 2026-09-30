import { describe, expect, it } from 'vitest';
import { readContractCreditBalance } from '../contractCreditBalance';

describe('contract credit balance response', () => {
  it('keeps an authoritative zero', () => {
    expect(readContractCreditBalance(0)).toBe(0);
    expect(readContractCreditBalance('0')).toBe(0);
  });
  it.each([null, undefined, '', 'không rõ', Number.NaN, Number.POSITIVE_INFINITY])('rejects missing or malformed balance %s', (value) => {
    expect(() => readContractCreditBalance(value)).toThrow('Không xác nhận được số dư tiền thừa của khách');
  });
});
