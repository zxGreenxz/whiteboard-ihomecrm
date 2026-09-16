/**
 * Rà soát 15/09/2026 — plan con H1 mục 3.
 *
 * Từ bản vá này, `create_invoice_v1` / `update_invoice_v1` KHÔNG tin `p_subtotal`
 * client gửi nữa: server cộng lại `p_items` theo đúng công thức nó dùng để ghi
 * `invoice_items.amount` (amount client gửi, vắng thì đơn giá × số lượng × hệ số)
 * rồi từ chối nếu lệch ≥ 0,01.
 *
 * Bài này canh phía đối diện của hợp đồng đó: màn nhập liệu phải gửi `p_subtotal`
 * ĐÚNG BẰNG tổng các dòng nó gửi kèm. Nếu ai đó đổi `computeEntryTotals` hoặc
 * `buildInvoiceItems` cho lệch nhau, người dùng sẽ gặp lỗi "Tạm tính client khác
 * tổng hạng mục server cộng lại" ngay trên màn hình — bài này bắt trước điều đó,
 * ở tầng rẻ nhất.
 *
 * KHÔNG dùng số thực ngẫu nhiên tuỳ tiện: tiền trong hệ này luôn là số nguyên
 * đồng và hệ số là bội 0,1; sinh double bất kỳ chỉ đo lại phép cộng dấu phẩy
 * động của JavaScript chứ không đo luật nghiệp vụ nào.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildInvoiceItems,
  computeEntryTotals,
  makeEntryValues,
  type EntryCustomItem,
  type InvoiceEntryValues,
} from '@/lib/invoiceEntry';

const CTX = {
  elecServiceId: 'svc-elec',
  waterServiceId: 'svc-water',
  pdvServiceId: 'svc-pdv',
  rentDescription: 'Tiền phòng',
};

const tien = (max = 20_000_000) => fc.integer({ min: 0, max });

const dongThem: fc.Arbitrary<EntryCustomItem> = fc.record({
  type: fc.constantFrom('SERVICE', 'PENALTY', 'OTHER', 'DISCOUNT'),
  accounting_class: fc.constantFrom('REVENUE', 'DEPOSIT', 'NON_PNL'),
  description: fc.constantFrom('Gửi xe', 'Tiền cọc', 'Phạt', 'Internet'),
  unit_price: tien(5_000_000),
  quantity: fc.integer({ min: 1, max: 12 }),
  coefficient: fc.integer({ min: 1, max: 30 }).map((n) => n / 10),
}) as fc.Arbitrary<EntryCustomItem>;

const form: fc.Arbitrary<InvoiceEntryValues> = fc
  .record({
    rent_price: tien(),
    electric_amount: tien(3_000_000),
    water_amount: tien(2_000_000),
    pdv_amount: tien(2_000_000),
    custom_items: fc.array(dongThem, { maxLength: 6 }),
    prorate: fc.boolean(),
  })
  .map(({ prorate, ...v }) =>
    makeEntryValues({
      billing_month: '2026-09',
      issue_date: '2026-09-01',
      due_date: '2026-09-10',
      occupants: 2,
      prev_reading: 100,
      current_reading: 150,
      // Kỳ lẻ ngày là nơi tạm tính và dòng hạng mục dễ lệch nhau nhất: cả hai
      // đều phải prorate, và phải prorate y hệt nhau.
      period_start_date: prorate ? '2026-09-06' : null,
      period_end_date: prorate ? '2026-09-30' : null,
      ...v,
    }),
  );

/** Công thức SERVER dùng để cộng lại p_items (chép từ migration H1). */
function serverResum(items: ReturnType<typeof buildInvoiceItems>): number {
  return items.reduce(
    (sum, it) => sum + it.unit_price * it.quantity * (it.coefficient ?? 1),
    0,
  );
}

describe('H1.3 — tạm tính client gửi phải bằng tổng hạng mục server cộng lại', () => {
  it('mọi bộ giá trị màn nhập liệu đều khớp trong ngưỡng 0,01', () => {
    fc.assert(
      fc.property(form, (v) => {
        const { subtotal } = computeEntryTotals(v);
        expect(Math.abs(serverResum(buildInvoiceItems(v, CTX)) - subtotal)).toBeLessThan(0.01);
      }),
      { numRuns: 400 },
    );
  });

  it('dòng cọc chuẩn cũng nằm trong tạm tính, không bị bỏ ra ngoài', () => {
    const v = makeEntryValues({
      billing_month: '2026-09',
      rent_price: 3_000_000,
      custom_items: [
        {
          type: 'OTHER',
          accounting_class: 'DEPOSIT',
          description: 'Tiền cọc',
          unit_price: 3_000_000,
          quantity: 1,
          coefficient: 1,
        },
      ],
    });
    const { subtotal, deposit } = computeEntryTotals(v);
    expect(deposit).toBe(3_000_000);
    expect(serverResum(buildInvoiceItems(v, CTX))).toBe(subtotal);
  });

  it('hoá đơn chỉ có nợ cũ gửi tạm tính 0 và không hạng mục nào', () => {
    // Nhánh này là lý do luật server phải là "lệch ≥ 0,01 thì từ chối" chứ không
    // phải "phải có ít nhất một hạng mục": hoá đơn thuần nợ cũ là hợp lệ.
    const v = makeEntryValues({ billing_month: '2026-09', previous_debt: 500_000 });
    expect(computeEntryTotals(v).subtotal).toBe(0);
    expect(serverResum(buildInvoiceItems(v, CTX))).toBe(0);
  });
});
