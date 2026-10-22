import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Ba lỗi báo cáo BĐS (18/10/2026): cột khách luôn "N/A" vì nhúng `tenants` cũ, báo cáo
// khuyến mại luôn giảm 0 vì đọc khoá `amount`/`value` không tồn tại, và bộ lọc ngày lệch
// một ngày vì so bằng `toISOString()` (ngày UTC). Mốc giờ trong file đều ghi kèm +07:00
// để kết quả giống hệt dưới mọi múi giờ máy (gate check-timezone-stability).

type Op = [string, unknown[]];
const mocks = vi.hoisted(() => ({ results: [] as unknown[], calls: [] as { table: string; ops: Op[] }[] }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => options }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      const ops: Op[] = [];
      mocks.calls.push({ table, ops });
      const result = mocks.results.shift();
      const chain: object = new Proxy({}, {
        get: (_, name) => name === 'then'
          ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject)
          : (...args: unknown[]) => { ops.push([String(name), args]); return chain; },
      });
      return chain;
    },
  },
}));

import {
  useExpiringContractsReport,
  useNewLeasesReport,
  usePromotionsReport,
  useTerminationsReport,
} from '../realEstateReports';

const run = <T,>(query: unknown) => (query as { queryFn: () => Promise<T> }).queryFn();
const opsOf = (i = 0) => mocks.calls[i].ops;
const filter = (op: string, column: string, i = 0) =>
  opsOf(i).find(([name, args]) => name === op && args[0] === column)?.[1][1];
const selectOf = (i = 0) => String(opsOf(i).find(([name]) => name === 'select')?.[1][0] ?? '');
// So với cột DATE, Postgres chỉ lấy phần ngày của chuỗi gửi lên — so đúng phần đó, để ca
// sau 07:00 VN (bản cũ vốn đúng) là ca đối chứng chứ không đỏ vì khác định dạng.
const dayOf = (value: unknown) => String(value).slice(0, 10);

// Hai khách, khách đại diện đứng SAU để chắc không lấy nhầm khách đầu mảng.
const customers = [
  { is_representative: false, customer: { full_name: 'Khách Ở Ghép', phone: '0900000002', email: null } },
  { is_representative: true, customer: { full_name: 'Khách Đại Diện', phone: '0900000001', email: 'dai.dien@example.test' } },
];
const room = { id: 'r1', name: 'P101', floor: 1, building_id: 'b1', buildings: { id: 'b1', name: 'Toà Thử' } };
const contract = (extra: Record<string, unknown> = {}) => ({
  id: 'c1', contract_number: 'HD-001', rent_price: 5_000_000, status: 'ACTIVE',
  start_date: '2026-04-01', end_date: '2026-10-20', signed_date: '2026-10-05',
  tenants: null, contract_customers: customers, rooms: room, ...extra,
});

beforeEach(() => { mocks.results = []; mocks.calls = []; });
afterEach(() => { vi.useRealTimers(); });

describe('cột khách lấy khách đại diện từ contract_customers', () => {
  const cases: [string, () => unknown, () => unknown[]][] = [
    ['HĐ sắp hết hạn', () => useExpiringContractsReport(30), () => [{ data: [contract()] }]],
    ['khuyến mại', () => usePromotionsReport(), () => [{ data: [contract({ discounts: { months: 2, amount_per_month: 300_000 } })] }]],
    ['HĐ mới', () => useNewLeasesReport(), () => [{ data: [contract()] }]],
  ];
  it.each(cases)('%s: tên/SĐT/email khách đại diện, không nhúng tenants', async (_, hook, results) => {
    mocks.results = results();
    const rows = await run<{ customer: { full_name: string; phone: string; email: string | null } | null }[]>(hook());
    expect(rows[0].customer).toEqual({ full_name: 'Khách Đại Diện', phone: '0900000001', email: 'dai.dien@example.test' });
    expect(selectOf()).toContain('contract_customers!contract_customers_contract_id_fkey');
    expect(selectOf()).toContain('customer:customers!contract_customers_customer_id_fkey');
    expect(selectOf()).not.toMatch(/tenants/);
  });

  it('thanh lý HĐ: tên khách đại diện', async () => {
    mocks.results = [
      { data: [contract({ status: 'TERMINATED', actual_end_date: '2026-10-10' })] },
      { data: [] },
      { count: 10, error: null },
    ];
    const report = await run<{ items: { customer: { full_name: string } | null }[] }>(useTerminationsReport());
    expect(report.items[0].customer?.full_name).toBe('Khách Đại Diện');
    expect(selectOf()).not.toMatch(/tenants/);
  });

  it('HĐ chưa gắn khách: customer null để trang hiện "N/A", không nổ', async () => {
    mocks.results = [{ data: [contract({ contract_customers: [] })] }];
    const rows = await run<{ customer: unknown }[]>(useNewLeasesReport());
    expect(rows[0].customer).toBeNull();
  });
});

describe('báo cáo khuyến mại đọc đúng khoá giảm giá', () => {
  it('discounts { months, amount_per_month } ⇒ giảm đúng số tiền/tháng', async () => {
    mocks.results = [{ data: [contract({ discounts: { months: 3, amount_per_month: 500_000 } })] }];
    const [row] = await run<{ discount_amount: number; savings: number; effective_rent: number; monthly_rent: number }[]>(usePromotionsReport());
    expect(row).toMatchObject({ monthly_rent: 5_000_000, discount_amount: 500_000, savings: 500_000, effective_rent: 4_500_000 });
  });

  it('lọc ở server theo khoá amount_per_month, không kéo về HĐ discounts = [] hay dấu lịch hỗ trợ v2', async () => {
    mocks.results = [{ data: [] }];
    await run(usePromotionsReport());
    expect(opsOf()).toContainEqual(['not', ['discounts->amount_per_month', 'is', null]]);
    expect(opsOf()).not.toContainEqual(['not', ['discounts', 'is', null]]);
  });
});

describe('bộ lọc ngày theo ngày giờ VN', () => {
  // 00:00, 03:00 và 06:59 giờ VN ngày 18/10 — giờ UTC vẫn là 17/10. 07:00 và 23:59 là đối chứng.
  it.each([
    ['00:00', '2026-10-18T00:00:00+07:00'],
    ['03:00', '2026-10-18T03:00:00+07:00'],
    ['06:59', '2026-10-18T06:59:59+07:00'],
    ['07:00', '2026-10-18T07:00:00+07:00'],
    ['23:59', '2026-10-18T23:59:59+07:00'],
  ])('HĐ sắp hết hạn lúc %s giờ VN: từ hôm nay 18/10 tới +30 ngày', async (_, now) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    mocks.results = [{ data: [] }];
    await run(useExpiringContractsReport(30));
    expect(dayOf(filter('gte', 'end_date'))).toBe('2026-10-18');
    expect(dayOf(filter('lte', 'end_date'))).toBe('2026-11-17');
  });

  const pickerFrom = new Date('2026-10-01T00:00:00+07:00'); // lịch trả 00:00 giờ máy (VN)
  const pickerTo = new Date('2026-10-31T00:00:00+07:00');
  it.each([
    ['khuyến mại', (from: Date, to: Date) => usePromotionsReport(from, to)],
    ['HĐ mới', (from: Date, to: Date) => useNewLeasesReport(from, to)],
  ])('%s: ngày ký 01/10–31/10 gửi đúng hai ngày đó', async (_, hook) => {
    mocks.results = [{ data: [] }];
    await run(hook(pickerFrom, pickerTo));
    expect(dayOf(filter('gte', 'signed_date'))).toBe('2026-10-01');
    expect(dayOf(filter('lte', 'signed_date'))).toBe('2026-10-31');
  });

  it('nút "Hôm nay" bấm lúc 03:00 giờ VN (from = to = lúc bấm) vẫn là 18/10', async () => {
    const pressedAt = new Date('2026-10-18T03:00:00+07:00');
    mocks.results = [{ data: [] }];
    await run(useNewLeasesReport(pressedAt, pressedAt));
    expect(dayOf(filter('gte', 'signed_date'))).toBe('2026-10-18');
    expect(dayOf(filter('lte', 'signed_date'))).toBe('2026-10-18');
  });

  it('thanh lý: giữ ngày đầu, ngày cuối khoảng và "hôm nay" trước 07:00 VN', async () => {
    const ended = (id: string, day: string) => contract({ id, status: 'TERMINATED', actual_end_date: day });
    const rows = [ended('t-0930', '2026-09-30'), ended('t-1001', '2026-10-01'), ended('t-1018', '2026-10-18'), ended('t-1031', '2026-10-31')];

    mocks.results = [{ data: rows }, { data: [] }, { count: 10, error: null }];
    const early = await run<{ items: { id: string }[] }>(
      useTerminationsReport(pickerFrom, new Date('2026-10-18T03:00:00+07:00')),
    );
    expect(early.items.map((r) => r.id)).toEqual(['t-1001', 't-1018']);

    mocks.results = [{ data: rows }, { data: [] }, { count: 10, error: null }];
    const wholeMonth = await run<{ items: { id: string }[] }>(
      useTerminationsReport(pickerFrom, pickerTo),
    );
    expect(wholeMonth.items.map((r) => r.id)).toEqual(['t-1001', 't-1018', 't-1031']);
  });
});
