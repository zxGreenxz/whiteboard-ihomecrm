// Test toán chia phiếu điện/nước theo dòng hạng mục (P1-01, audit 31/08).
// Fixture chính lấy đúng HÌNH DẠNG phiếu thật trên prod: 5916661a… —
// tổng 6.384.000 = điện 5.758.000 + nước 626.000.
import { describe, expect, it } from 'vitest';
import { splitUtilityAmounts, utilityRowParts } from '@/lib/utilityVoucherSplit';

const E1 = 'type-elec-1';
const W1 = 'type-water-1';
const elecIds = new Set([E1]);
const waterIds = new Set([W1]);

const mixedVoucherItems = [
  { income_expense_type_id: E1, amount: 5_758_000 },
  { income_expense_type_id: W1, amount: 626_000 },
];

describe('splitUtilityAmounts', () => {
  it('phiếu gộp: chia đúng phần điện / phần nước (fixture prod 5916661a)', () => {
    expect(splitUtilityAmounts(mixedVoucherItems, elecIds, waterIds)).toEqual({
      elec: 5_758_000,
      water: 626_000,
    });
  });

  it('amount dạng string từ PostgREST vẫn cộng đúng', () => {
    const items = [
      { income_expense_type_id: E1, amount: '100.50' },
      { income_expense_type_id: W1, amount: '200' },
    ];
    expect(splitUtilityAmounts(items, elecIds, waterIds)).toEqual({ elec: 100.5, water: 200 });
  });

  it('item ngoài điện/nước và amount null bị bỏ qua', () => {
    const items = [
      { income_expense_type_id: 'type-rac', amount: 999 },
      { income_expense_type_id: E1, amount: null },
      { income_expense_type_id: W1, amount: 50 },
    ];
    expect(splitUtilityAmounts(items, elecIds, waterIds)).toEqual({ elec: 0, water: 50 });
  });
});

describe('utilityRowParts', () => {
  it('phiếu gộp → HAI dòng mang đúng phần tiền, gắn cờ mixedVoucher', () => {
    expect(utilityRowParts(mixedVoucherItems, elecIds, waterIds, 6_384_000)).toEqual([
      { type: 'electric', amount: 5_758_000, mixedVoucher: true },
      { type: 'water', amount: 626_000, mixedVoucher: true },
    ]);
  });

  it('tổng hai dòng của phiếu gộp = đúng tổng phần điện nước (không đếm đôi)', () => {
    const parts = utilityRowParts(mixedVoucherItems, elecIds, waterIds, 6_384_000);
    expect(parts.reduce((s, p) => s + p.amount, 0)).toBe(6_384_000);
  });

  it('phiếu một loại → MỘT dòng, tiền là PHẦN của loại (không lấy total_amount)', () => {
    const items = [
      { income_expense_type_id: E1, amount: 1_000_000 },
      { income_expense_type_id: 'type-khac', amount: 300_000 }, // hạng mục ngoài điện/nước
    ];
    expect(utilityRowParts(items, elecIds, waterIds, 1_300_000)).toEqual([
      { type: 'electric', amount: 1_000_000, mixedVoucher: false },
    ]);
  });

  it('chỉ nước → một dòng nước', () => {
    const items = [{ income_expense_type_id: W1, amount: 777_000 }];
    expect(utilityRowParts(items, elecIds, waterIds, 777_000)).toEqual([
      { type: 'water', amount: 777_000, mixedVoucher: false },
    ]);
  });

  it('suy biến (item không mang amount) → rơi về hành vi cũ: một dòng + total_amount', () => {
    const items = [
      { income_expense_type_id: E1, amount: null },
      { income_expense_type_id: W1, amount: 0 },
    ];
    expect(utilityRowParts(items, elecIds, waterIds, 500_000)).toEqual([
      { type: 'electric', amount: 500_000, mixedVoucher: false },
    ]);
  });
});
