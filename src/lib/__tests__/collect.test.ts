import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  fmtFull,
  fmtK,
  fmtShort,
  fmtBillingMonth,
  remainingOf,
  collectStatus,
  cellSubText,
  repCustomer,
  zaloUrl,
  collectedAt,
  paymentsInRange,
  latestPaymentId,
} from '../collect';
import type { InvoiceWithRelations } from '@/types/invoice';

// Factory HĐ tối giản — chỉ field các helper đụng tới.
const inv = (over: Partial<InvoiceWithRelations>): InvoiceWithRelations =>
  ({
    status: 'APPROVED',
    total_amount: 1_000_000,
    paid_amount: 0,
    remaining_amount: 1_000_000,
    payments: [],
    ...over,
  }) as InvoiceWithRelations;

describe('formatters', () => {
  it('fmtFull thêm "đ" + ngăn cách nghìn vi-VN', () => {
    expect(fmtFull(1_234_000)).toBe('1.234.000đ');
    expect(fmtFull(0)).toBe('0đ');
  });

  it('fmtK làm tròn nghìn + hậu tố K', () => {
    expect(fmtK(5_369_000)).toBe('5369K');
    expect(fmtK(500)).toBe('1K'); // 500 → round → 1K
  });

  it('fmtShort: triệu/nghìn', () => {
    expect(fmtShort(2_000_000)).toBe('2tr');
    expect(fmtShort(2_500_000)).toBe('2.5tr');
    expect(fmtShort(500_000)).toBe('500k');
    expect(fmtShort(800)).toBe('800');
  });

  it('fmtBillingMonth: YYYY-MM → ThM/YYYY', () => {
    expect(fmtBillingMonth('2026-06')).toBe('Th6/2026');
    expect(fmtBillingMonth(null)).toBe('');
  });
});

describe('collectStatus + remainingOf', () => {
  it('PAID hoặc remaining ≤ 0 → paid', () => {
    expect(collectStatus(inv({ status: 'PAID', paid_amount: 1_000_000, remaining_amount: 0 }))).toBe('paid');
    expect(collectStatus(inv({ status: 'APPROVED', remaining_amount: 0 }))).toBe('paid');
  });

  it('đã thu 1 phần → partial', () => {
    expect(
      collectStatus(inv({ status: 'PARTIAL_PAID', paid_amount: 400_000, remaining_amount: 600_000 })),
    ).toBe('partial');
    expect(collectStatus(inv({ status: 'APPROVED', paid_amount: 100_000, remaining_amount: 900_000 }))).toBe('partial');
  });

  it('chưa thu (APPROVED/OVERDUE/DRAFT) → unpaid', () => {
    expect(collectStatus(inv({ status: 'APPROVED' }))).toBe('unpaid');
    expect(collectStatus(inv({ status: 'OVERDUE' }))).toBe('unpaid');
    expect(collectStatus(inv({ status: 'DRAFT' }))).toBe('unpaid');
  });

  it('remainingOf fallback total - paid khi thiếu remaining_amount', () => {
    expect(remainingOf({ total_amount: 1000, paid_amount: 300, remaining_amount: undefined } as any)).toBe(700);
  });

  // Invariant: 3 trạng thái loại trừ nhau & paid ⇒ remaining ≤ 0 hoặc status PAID
  it('property: status hợp lệ với mọi paid_amount', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000 }), (paid) => {
        const total = 1_000_000;
        const i = inv({ status: 'APPROVED', paid_amount: paid, remaining_amount: total - paid });
        const st = collectStatus(i);
        if (paid <= 0) return st === 'unpaid';
        if (paid >= total) return st === 'paid';
        return st === 'partial';
      }),
    );
  });
});

describe('cellSubText', () => {
  it('Chưa thu / Thu thêm {K} / Thu đủ', () => {
    expect(cellSubText(inv({}))).toBe('Chưa thu');
    expect(cellSubText(inv({ status: 'PAID', remaining_amount: 0 }))).toBe('Thu đủ');
    expect(
      cellSubText(inv({ status: 'PARTIAL_PAID', paid_amount: 400_000, remaining_amount: 600_000 })),
    ).toBe('Thu thêm 600K');
  });
});

describe('repCustomer', () => {
  it('lấy khách is_representative, fallback phần tử đầu', () => {
    const i = inv({
      contract: {
        id: 'c1',
        contract_number: null,
        contract_customers: [
          { id: 'x', is_representative: false, customer: { id: 'a', full_name: 'A', phone: '0900000001' } },
          { id: 'y', is_representative: true, customer: { id: 'b', full_name: 'B', phone: '0900000002' } },
        ],
      },
    } as any);
    expect(repCustomer(i)).toEqual({ name: 'B', phone: '0900000002' });
  });

  it('không có contract → name rỗng, phone null', () => {
    expect(repCustomer(inv({}))).toEqual({ name: '', phone: null });
  });
});

describe('zaloUrl', () => {
  it('0xxx → 84xxx; 84xxx giữ nguyên', () => {
    expect(zaloUrl('0378160165')).toBe('https://zalo.me/84378160165');
    expect(zaloUrl('84378160165')).toBe('https://zalo.me/84378160165');
    expect(zaloUrl('0357 758 719')).toBe('https://zalo.me/84357758719');
  });
});

describe('payments helpers', () => {
  const pays = [
    { id: 'p1', amount: 200_000, payment_date: '2026-06-05', payment_method: 'TM' },
    { id: 'p2', amount: 300_000, payment_date: '2026-06-08', payment_method: 'TM' },
  ];

  it('collectedAt = ngày payment mới nhất', () => {
    expect(collectedAt(inv({ payments: pays as any }))).toBe('2026-06-08');
    expect(collectedAt(inv({ payments: [] }))).toBeNull();
  });

  it('paymentsInRange cộng đúng + has', () => {
    expect(paymentsInRange(inv({ payments: pays as any }), '2026-06-08', '2026-06-08')).toEqual({
      sum: 300_000,
      has: true,
    });
    expect(paymentsInRange(inv({ payments: pays as any }), '2026-07-01', '2026-07-31')).toEqual({
      sum: 0,
      has: false,
    });
  });

  it('latestPaymentId = payment ngày mới nhất', () => {
    expect(latestPaymentId(inv({ payments: pays as any }))).toBe('p2');
    expect(latestPaymentId(inv({ payments: [] }))).toBeNull();
  });
});
