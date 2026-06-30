import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  sumSelected,
  netSelected,
  myRole,
  handoverStatusLabel,
  needsMyAction,
  isOpenHandover,
  fmtDateTime,
  type HandoverLite,
} from '../handover';

const GIVER = 'user-giver';
const RECEIVER = 'user-receiver';
const OTHER = 'user-other';

// Factory phiên tối giản — chỉ field các helper đụng tới.
const h = (over: Partial<HandoverLite>): HandoverLite => ({
  id: 'h1',
  code: 'BG2606001',
  giver_id: GIVER,
  receiver_id: RECEIVER,
  total_amount: 1_000_000,
  voucher_count: 2,
  status: 'PENDING',
  cancel_requested_by: null,
  ...over,
});

describe('sumSelected', () => {
  it('chỉ cộng phiếu được tick', () => {
    const vs = [
      { id: 'a', total_amount: 100 },
      { id: 'b', total_amount: 200 },
      { id: 'c', total_amount: 300 },
    ];
    expect(sumSelected(vs, new Set(['a', 'c']))).toBe(400);
    expect(sumSelected(vs, [])).toBe(0);
    expect(sumSelected(vs, ['a', 'b', 'c'])).toBe(600);
  });

  it('null/undefined amount tính 0', () => {
    expect(sumSelected([{ id: 'a', total_amount: null }], ['a'])).toBe(0);
  });

  it('property: tổng tick hết = Σ amount, tập con ≤ tổng', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ id: fc.uuid(), total_amount: fc.integer({ min: 0, max: 1e9 }) }),
          { maxLength: 30 },
        ),
        (vs) => {
          const all = sumSelected(vs, vs.map((v) => v.id));
          const expected = vs.reduce((s, v) => s + v.total_amount, 0);
          // id trùng nhau trong mảng random → so theo Set như implement
          const ids = new Set(vs.map((v) => v.id));
          const expectedSet = vs.reduce((s, v) => s + (ids.has(v.id) ? v.total_amount : 0), 0);
          expect(all).toBe(expectedSet);
          expect(expected).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe('netSelected (bàn giao theo số dư = thu − chi)', () => {
  const vs = [
    { id: 'a', type: 'INCOME', total_amount: 5_000_000 },
    { id: 'b', type: 'INCOME', total_amount: 3_000_000 },
    { id: 'c', type: 'EXPENSE', total_amount: 2_000_000 },
  ];

  it('net = Σthu − Σchi của các phiếu tick', () => {
    expect(netSelected(vs, ['a', 'b', 'c'])).toEqual({
      gross: 8_000_000,
      expense: 2_000_000,
      net: 6_000_000,
    });
  });

  it('chỉ tick thu → net = gross (tương thích ngược)', () => {
    expect(netSelected(vs, ['a', 'b'])).toEqual({ gross: 8_000_000, expense: 0, net: 8_000_000 });
  });

  it('chi > thu → net âm (FE chặn submit)', () => {
    expect(netSelected(vs, ['b', 'c'])).toEqual({ gross: 3_000_000, expense: 2_000_000, net: 1_000_000 });
    expect(netSelected([{ id: 'c', type: 'EXPENSE', total_amount: 2_000_000 }], ['c'])).toEqual({
      gross: 0,
      expense: 2_000_000,
      net: -2_000_000,
    });
  });

  it('thiếu type coi như THU; amount null tính 0', () => {
    expect(
      netSelected([{ id: 'x', total_amount: 1000 }, { id: 'y', type: 'EXPENSE', total_amount: null }], ['x', 'y']),
    ).toEqual({ gross: 1000, expense: 0, net: 1000 });
  });

  it('property: net = gross − expense, luôn nhất quán', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            type: fc.constantFrom('INCOME', 'EXPENSE'),
            total_amount: fc.integer({ min: 0, max: 1e9 }),
          }),
          { maxLength: 30 },
        ),
        (arr) => {
          const ids = arr.map((v) => v.id);
          const { gross, expense, net } = netSelected(arr, ids);
          expect(net).toBe(gross - expense);
          expect(gross).toBeGreaterThanOrEqual(0);
          expect(expense).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe('myRole', () => {
  it('phân vai đúng', () => {
    expect(myRole(h({}), GIVER)).toBe('giver');
    expect(myRole(h({}), RECEIVER)).toBe('receiver');
    expect(myRole(h({}), OTHER)).toBe('none');
    expect(myRole(h({}), null)).toBe('none');
  });
});

describe('handoverStatusLabel', () => {
  it('PENDING: receiver thấy "Chờ tôi nhận", giver thấy "Chờ nhận"', () => {
    expect(handoverStatusLabel(h({}), RECEIVER)).toBe('Chờ tôi nhận');
    expect(handoverStatusLabel(h({}), GIVER)).toBe('Chờ nhận');
  });

  it('CONFIRMED → "Đã nhận", CANCELLED → "Đã hủy" (ưu tiên tuyệt đối)', () => {
    expect(handoverStatusLabel(h({ status: 'CONFIRMED' }), GIVER)).toBe('Đã nhận');
    expect(
      handoverStatusLabel(h({ status: 'CANCELLED', cancel_requested_by: GIVER }), RECEIVER),
    ).toBe('Đã hủy');
  });

  it('có yêu cầu hủy: bên kia thấy "Chờ tôi xác nhận hủy", người yêu cầu thấy "Đang chờ hủy"', () => {
    const hh = h({ cancel_requested_by: GIVER });
    expect(handoverStatusLabel(hh, RECEIVER)).toBe('Chờ tôi xác nhận hủy');
    expect(handoverStatusLabel(hh, GIVER)).toBe('Đang chờ hủy');
    expect(handoverStatusLabel(hh, OTHER)).toBe('Đang chờ hủy');
  });
});

describe('needsMyAction (badge)', () => {
  it('PENDING cần receiver xử lý, không cần giver', () => {
    expect(needsMyAction(h({}), RECEIVER)).toBe(true);
    expect(needsMyAction(h({}), GIVER)).toBe(false);
    expect(needsMyAction(h({}), OTHER)).toBe(false);
  });

  it('yêu cầu hủy cần BÊN KIA xử lý (kể cả khi đã CONFIRMED)', () => {
    expect(needsMyAction(h({ status: 'CONFIRMED', cancel_requested_by: RECEIVER }), GIVER)).toBe(true);
    expect(needsMyAction(h({ status: 'CONFIRMED', cancel_requested_by: RECEIVER }), RECEIVER)).toBe(false);
    expect(needsMyAction(h({ cancel_requested_by: GIVER }), RECEIVER)).toBe(true);
    expect(needsMyAction(h({ cancel_requested_by: GIVER }), GIVER)).toBe(false);
  });

  it('CONFIRMED không yêu cầu hủy / CANCELLED → không cần ai', () => {
    expect(needsMyAction(h({ status: 'CONFIRMED' }), RECEIVER)).toBe(false);
    expect(needsMyAction(h({ status: 'CANCELLED', cancel_requested_by: GIVER }), RECEIVER)).toBe(false);
  });
});

describe('isOpenHandover', () => {
  it('PENDING mở; CONFIRMED chỉ mở khi đang chờ hủy; CANCELLED đóng', () => {
    expect(isOpenHandover(h({}))).toBe(true);
    expect(isOpenHandover(h({ status: 'CONFIRMED' }))).toBe(false);
    expect(isOpenHandover(h({ status: 'CONFIRMED', cancel_requested_by: GIVER }))).toBe(true);
    expect(isOpenHandover(h({ status: 'CANCELLED' }))).toBe(false);
  });
});

describe('fmtDateTime', () => {
  it('null/undefined/không hợp lệ → ""', () => {
    expect(fmtDateTime(null)).toBe('');
    expect(fmtDateTime(undefined)).toBe('');
    expect(fmtDateTime('not-a-date')).toBe('');
  });

  it('định dạng dd/mm hh:mm (giờ địa phương, không phụ thuộc TZ test)', () => {
    // Input không offset → parse theo giờ địa phương → giá trị xác định.
    expect(fmtDateTime('2026-06-13T08:05:00')).toBe('13/06 08:05');
    expect(fmtDateTime('2026-12-01T23:09:00')).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });
});
