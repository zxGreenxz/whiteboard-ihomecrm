import { describe, it, expect } from 'vitest';
import { CHUA_DU_DU_LIEU, type Lane } from '../contractLifecycle';
import {
  LIFECYCLE_EVENT_TYPES, commissionEventOf,
  type ContractMoney, type InvoiceIssuedMeta, type LifecycleContract, type LifecycleEvent, type LifecyclePayload,
  type MoneyScope, type RefundMoney,
} from '../roomLifecycle';
import {
  buildContractDetail, buildRoomYear, buildStays, daysBetween, monthsBetween,
  type ContractCard, type RoomContractExtras,
} from '../roomContractYear';

const TODAY = '2026-09-25';
const ROOM = 'room-204';

const hd = (id: string, o: Partial<LifecycleContract>): LifecycleContract => ({
  id, number: `HĐ-${id}`, status: 'ACTIVE', startDate: null, endDate: null, actualEndDate: null,
  rentPrice: 3_900_000, totalDeposit: 3_900_000, tenantName: `Khách ${id}`, ...o,
});

const seg = (contractId: string, fromDate: string | null, toDate: string | null, segIndex = 0) => ({
  contractId, contractNumber: `HĐ-${contractId}`, segIndex, fromDate, toDate,
  sourcePath: null, trusted: true, diagnostic: null,
});

const ev = (type: string, date: string, contractId: string, amount: number | null = null, meta: Record<string, unknown> | null = null): LifecycleEvent =>
  ({ type, date, contractId, amount, trusted: true, meta });

const payload = (p: Partial<LifecyclePayload>): LifecyclePayload => ({
  room: { id: ROOM, name: '204', buildingId: 'b1', buildingName: '111PVC' },
  range: { from: null, to: null }, contracts: [], segments: [], events: [], vacancies: [],
  generatedAt: '2026-09-25T00:00:00Z', ...p,
});

const lane = (contractId: string, o: Partial<Lane> = {}): Lane => ({
  contractId, contractNumber: `HĐ-${contractId}`, customer: `Khách ${contractId}`, role: '', tag: '',
  target: false, steps: [], settlementDeposit: null, isTerminated: false, terminatedAt: null,
  segment: null, trusted: true, diagnostics: [],
  deposit: {
    grossCollected: 3_900_000, offsetOut: 0, netHeld: 3_900_000, historicalIn: 0, historicalOut: 0,
    historicalNet: 0, excluded: [], hasUnverified: false,
    evidence: [{ voucherId: 'v', code: 'PT01', date: '2026-01-01', amount: 3_900_000, direction: 'IN', bucket: 'REAL_CASH', verification: 'verified' }],
  },
  invoice: { paid: 10_000_000, debt: 0 },
  termination: null,
  ...o,
});

const term = (contract_id: string, termination_type: string, refund_amount: number | null, total_deposit = 3_900_000) => ({
  id: `t-${contract_id}`, contract_id, organization_id: 'org', status: 'COMPLETED', termination_date: '2026-07-31',
  termination_type, refund_amount, outstanding_debt: 0, total_deposit,
});

const noExtras: RoomContractExtras = { transfers: [], extensions: [], customers: new Map() };

describe('tiện ích ngày', () => {
  it('đếm ngày và tháng tròn', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(monthsBetween('2026-01-05', '2026-07-31')).toBe(6);
    expect(monthsBetween('2026-01-05', '2026-07-04')).toBe(5);
  });
});

describe('buildStays', () => {
  it('gộp nhiều đoạn của một hợp đồng thành một nhịp, đoạn mở thì nhịp mở', () => {
    const p = payload({
      contracts: [hd('A', {})],
      segments: [seg('A', '2026-01-01', '2026-03-01', 0), seg('A', '2026-05-01', null, 1)],
    });
    expect(buildStays(p)).toMatchObject([{ from: '2026-01-01', to: null }]);
  });
});

describe('buildRoomYear — cách kết thúc', () => {
  const p = payload({
    contracts: [
      hd('old', { status: 'TERMINATED', startDate: '2026-01-05', endDate: '2026-07-31', actualEndDate: '2026-07-31' }),
      hd('new', { startDate: '2026-08-10', endDate: '2027-02-09' }),
    ],
    segments: [seg('old', '2026-01-05', '2026-07-31'), seg('new', '2026-08-10', null)],
    vacancies: [{ fromDate: '2026-07-31', toDate: '2026-08-10', days: 10 }],
    events: [
      ev('INVOICE_ISSUED', '2026-02-05', 'old', 3_900_000, { billingMonth: '2026-02' }),
      ev('INVOICE_COLLECTION_POSTED', '2026-02-06', 'old', 3_900_000, { billingMonth: '2026-02' }),
      ev('INVOICE_COLLECTION_POSTED', '2025-12-06', 'old', 1_000_000, { billingMonth: '2025-12' }),
      ev('TERMINATION_REQUESTED', '2026-07-31', 'old', 3_483_000, { status: 'COMPLETED', type: 'NORMAL' }),
    ],
  });

  it('đúng hạn + chưa hoàn cọc → chip đỏ chủ nhà còn nợ', () => {
    const lanes = new Map([
      ['old', lane('old', { termination: term('old', 'NORMAL', 3_483_000) })],
      ['new', lane('new')],
    ]);
    const v = buildRoomYear({ payload: p, year: 2026, todayISO: TODAY, lanes, extras: noExtras });
    const cards = v.items.filter((i) => i.type === 'contract').map((i) => (i as { card: { kind: string; chips: { text: string }[]; paidYear: number; reason: string } }).card);
    expect(cards.map((c) => c.kind)).toEqual(['ontime', 'active']);
    expect(cards[0].chips.map((c) => c.text)).toContain('Chủ nhà chưa hoàn cọc 3.483.000 đ');
    expect(cards[0].reason).toContain('khấu trừ 417.000 đ');
    // Chỉ tính kỳ hoá đơn thuộc năm đang xem.
    expect(cards[0].paidYear).toBe(3_900_000);
    const gap = v.items.find((i) => i.type === 'gap') as { text: string };
    expect(gap.text).toBe('Phòng trống 10 ngày · 31/07 → 09/08 — Thanh lý HĐ');
    expect(v.items.map((i) => i.type)).toEqual(['contract', 'gap', 'contract']);
  });

  it('bỏ cọc → nhãn Bỏ cọc, không phải hoàn', () => {
    const lanes = new Map([['old', lane('old', { termination: term('old', 'FORFEIT', 0) })], ['new', lane('new')]]);
    const v = buildRoomYear({ payload: p, year: 2026, todayISO: TODAY, lanes, extras: noExtras });
    const first = v.items[0] as { card: { kind: string; chips: { text: string }[] } };
    expect(first.card.kind).toBe('forfeit');
    expect(first.card.chips.map((c) => c.text)).toContain('Chủ nhà không phải hoàn');
    expect((v.items[1] as { text: string }).text).toContain('— Bỏ cọc');
  });

  it('trước hạn khi rời sớm hơn hạn quá 3 ngày', () => {
    const p2 = payload({
      contracts: [hd('A', { status: 'TERMINATED', startDate: '2025-08-05', endDate: '2026-08-04' })],
      segments: [seg('A', '2025-08-05', '2026-07-15')],
    });
    const v = buildRoomYear({ payload: p2, year: 2026, todayISO: TODAY, lanes: new Map(), extras: noExtras });
    const c = (v.items[0] as { card: { kind: string; reason: string } }).card;
    expect(c.kind).toBe('early');
    expect(c.reason).toContain('trước hạn 20 ngày');
  });

  it('chuyển phòng → tên phòng mới từ đọc phụ', () => {
    const p2 = payload({
      contracts: [hd('A', { startDate: '2024-12-01', endDate: '2026-11-30' })],
      segments: [seg('A', '2024-12-01', '2026-06-30')],
      events: [ev('ROOM_CHANGED_OUT', '2026-06-30', 'A')],
    });
    const extras: RoomContractExtras = {
      ...noExtras,
      transfers: [{ contractId: 'A', type: 'ROOM_CHANGE', date: '2026-06-30', oldRoomId: ROOM, newRoomId: 'r402', newRoomName: '402' }],
    };
    const v = buildRoomYear({ payload: p2, year: 2026, todayISO: TODAY, lanes: new Map([['A', lane('A')]]), extras });
    const c = (v.items[0] as { card: { kind: string; reason: string } }).card;
    expect(c.kind).toBe('room');
    expect(c.reason).toBe('Chuyển sang phòng 402 · cọc chuyển theo hợp đồng');
  });

  it('còn ở nhưng quá hạn → hết hạn chưa thanh lý', () => {
    const p2 = payload({
      contracts: [hd('A', { startDate: '2025-09-01', endDate: '2026-08-31' })],
      segments: [seg('A', '2025-09-01', null)],
    });
    const v = buildRoomYear({ payload: p2, year: 2026, todayISO: TODAY, lanes: new Map([['A', lane('A')]]), extras: noExtras });
    expect((v.items[0] as { card: { kind: string } }).card.kind).toBe('expired');
    expect(v.kpis[1].value).toBe('100%');
  });

  it('lấp đầy chỉ tính tới hôm nay', () => {
    const p2 = payload({
      contracts: [hd('A', { startDate: '2026-01-15', endDate: '2027-01-14' })],
      segments: [seg('A', '2026-01-15', null)],
    });
    const v = buildRoomYear({ payload: p2, year: 2026, todayISO: TODAY, lanes: new Map(), extras: noExtras });
    // 268 ngày đã qua, trống 14 ngày đầu năm.
    expect(v.kpis[1].value).toBe(`${Math.round((254 / 268) * 100)}%`);
  });
});

describe('không bịa số khi thiếu nguồn', () => {
  const p = payload({
    contracts: [hd('A', { startDate: '2026-01-01', endDate: '2026-12-31' })],
    segments: [seg('A', '2026-01-01', null)],
  });

  it('lane đang tải → chip "Đang tải", không có số', () => {
    const v = buildRoomYear({ payload: p, year: 2026, todayISO: TODAY, lanes: undefined, extras: null });
    const c = (v.items[0] as { card: { chips: { text: string }[] } }).card;
    expect(c.chips.map((x) => x.text)).toEqual(['Đang tải cọc & công nợ…']);
  });

  it('không có lane → Chưa đủ dữ liệu, không in 0 đ', () => {
    const d = buildContractDetail({ payload: p, todayISO: TODAY, lanes: new Map(), extras: null }, 'A')!;
    expect(d.kpis[0].value).toBe(CHUA_DU_DU_LIEU);
    expect(d.kpis[1].value).toBe(CHUA_DU_DU_LIEU);
    expect(d.balances.chips.map((x) => x.text).join(' ')).not.toContain('0 đ');
  });

  it('thiếu cọc khi đang ở → chip đỏ và khách còn nợ', () => {
    const l = lane('A', {
      deposit: { ...lane('A').deposit!, grossCollected: 2_000_000, netHeld: 2_000_000 },
      invoice: { paid: 5_000_000, debt: 500_000 },
    });
    const d = buildContractDetail({ payload: p, todayISO: TODAY, lanes: new Map([['A', l]]), extras: null }, 'A')!;
    expect(d.balances.chips[0]).toMatchObject({ tone: 'red' });
    expect(d.balances.tenantOwe).toBe(1_900_000 + 500_000);
  });
});

describe('buildContractDetail — diễn biến', () => {
  it('xếp theo ngày: cọc → nhận phòng → hoá đơn → sang nhượng → hôm nay → hết hạn', () => {
    const p = payload({
      contracts: [hd('A', { startDate: '2026-05-01', endDate: '2026-10-31' })],
      segments: [seg('A', '2026-05-01', null)],
      events: [
        ev('CONTRACT_OPENED', '2026-05-01', 'A'),
        ev('INVOICE_ISSUED', '2026-05-05', 'A', 4_000_000, { billingMonth: '2026-05', status: 'PAID' }),
        ev('INVOICE_COLLECTION_POSTED', '2026-05-06', 'A', 4_000_000, { billingMonth: '2026-05' }),
        ev('INVOICE_ISSUED', '2026-09-05', 'A', 4_000_000, { billingMonth: '2026-09', status: 'PARTIAL_PAID' }),
        ev('INVOICE_COLLECTION_POSTED', '2026-09-06', 'A', 1_000_000, { billingMonth: '2026-09' }),
      ],
    });
    const extras: RoomContractExtras = {
      transfers: [{ contractId: 'A', type: 'TENANT_CHANGE', date: '2026-06-15', oldRoomId: null, newRoomId: null, newRoomName: null }],
      extensions: [],
      customers: new Map([['A', { name: 'Lâm Bảo Ngọc', phone: '0932 781 450' }]]),
    };
    const l = lane('A', { deposit: { ...lane('A').deposit!, evidence: [{ ...lane('A').deposit!.evidence[0], date: '2026-04-25' }] } });
    const d = buildContractDetail({ payload: p, todayISO: TODAY, lanes: new Map([['A', l]]), extras }, 'A')!;
    expect(d.events.map((e) => e.title)).toEqual([
      'Thu cọc',
      'Ký hợp đồng & nhận phòng',
      'Tiền phòng tháng đầu tiên – 05/2026',
      'Sang nhượng hợp đồng',
      'Tiền phòng – 09/2026',
      'Hôm nay · đang ở',
      'Ngày hết hạn dự kiến',
    ]);
    expect(d.events[4].note).toBe('Còn thiếu 3.000.000 đ');
    expect(d.tiles[0]).toMatchObject({ value: 'Lâm Bảo Ngọc', sub: '0932 781 450' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RPC mới "vòng đời tiền một nguồn" — số và mã GIẢ (repo public).
// ═══════════════════════════════════════════════════════════════════════════

const scope = (o: Partial<MoneyScope> = {}): MoneyScope => ({
  issued: 0, paidCash: 0, offset: 0, debt: 0, overpaid: 0, invoiceCount: 0, roomCount: 1, depositOnInvoices: 0, ...o,
});
const tien = (room: Partial<MoneyScope>, o: { contract?: Partial<MoneyScope>; refund?: RefundMoney | null } = {}): ContractMoney => ({
  contract: scope({ ...room, ...o.contract }), room: scope(room), refund: o.refund ?? null,
});
const hoan = (o: Partial<RefundMoney>): RefundMoney => ({
  depositDue: null, depositPaid: 0, depositOnVouchers: 0, otherDue: 0, otherPaid: 0, owed: null, offbook: 0, warnings: [], ...o,
});
const hdon = (id: string, month: string, date: string, amount: number, meta: Partial<InvoiceIssuedMeta> = {}, contractId = 'A') =>
  ev('INVOICE_ISSUED', date, contractId, amount, {
    invoiceId: id, billingMonth: month, status: 'PAID', kind: 'MONTHLY', total: amount, carriedIn: 0, depositPart: 0,
    penalty: 0, outstanding: 0, carriedOpen: 0, carriedPaid: 0, sourceInvoiceIds: [], ...meta,
  });
const thu = (id: string, month: string, date: string, amount: number, kind = 'MONTHLY', contractId = 'A') =>
  ev('INVOICE_COLLECTION_POSTED', date, contractId, amount, { invoiceId: id, billingMonth: month, kind, depositPaid: 0 });
const can = (id: string, month: string, date: string, amount: number, o: { kind?: string; via?: string; penalty?: number } = {}) =>
  ev('INVOICE_TERMINATION_OFFSET', date, 'A', amount, {
    invoiceId: id, billingMonth: month, kind: o.kind ?? 'MONTHLY', via: o.via ?? 'MOVE_OUT', penalty: o.penalty ?? 0,
  });
const titles = (d: { events: { title: string }[] }) => d.events.map((e) => e.title);
const rowOf = (d: { events: { title: string }[] }, title: string) => {
  const r = d.events.find((e) => e.title === title);
  expect(r, `thiếu dòng ${title}`).toBeDefined();
  return r as (typeof d.events)[number] & { sub: string; note: string; amt: string; noteTone: string; kind: string };
};

/** Thanh lý trước hạn 05/10, hoá đơn thanh lý trả hết bằng cọc. */
const caThanhLy = (o: { money?: ContractMoney; extra?: LifecycleEvent[]; voucher?: number | null } = {}) => payload({
  contracts: [hd('A', {
    status: 'TERMINATED', startDate: '2026-05-01', endDate: '2027-04-30', actualEndDate: '2026-10-05',
    totalDeposit: 3_000_000, originalEndDate: null,
    money: o.money ?? tien(
      { issued: 6_500_000, paidCash: 6_000_000, offset: 500_000, invoiceCount: 4, depositOnInvoices: 3_000_000 },
      { refund: hoan({ depositDue: 2_500_000, depositOnVouchers: 2_500_000, owed: 2_500_000 }) },
    ),
  })],
  segments: [seg('A', '2026-05-01', '2026-10-05')],
  events: [
    ev('CONTRACT_OPENED', '2026-05-01', 'A'),
    // Hoá đơn chỉ có cọc: phần cọc tính ở mục cọc ⇒ ẩn.
    hdon('i0', '2026-05', '2026-05-01', 0, { depositPart: 3_000_000, total: 3_000_000 }),
    hdon('i1', '2026-05', '2026-05-01', 3_000_000), thu('i1', '2026-05', '2026-05-03', 3_000_000),
    hdon('i2', '2026-09', '2026-09-01', 3_000_000), thu('i2', '2026-09', '2026-09-10', 3_000_000),
    hdon('i3', '2026-10', '2026-10-05', 500_000, { kind: 'SETTLEMENT' }),
    can('i3', '2026-10', '2026-10-05', 500_000, { kind: 'SETTLEMENT' }),
    ev('TERMINATION_REQUESTED', '2026-10-05', 'A', 2_500_000, { status: 'APPROVED', type: 'EARLY_TENANT' }),
    ...(o.voucher === null ? [] : [ev('SETTLEMENT_OFFSET_POSTED', '2026-10-05', 'A', o.voucher ?? 500_000, { code: 'PC-GIA-02', voucherId: 'v-coc' })]),
    ev('CONTRACT_CLOSED', '2026-10-05', 'A'),
    ...(o.extra ?? []),
  ],
});
const detailA = (p: LifecyclePayload, extras: RoomContractExtras | null = null, lanes = new Map([['A', lane('A')]])) =>
  buildContractDetail({ payload: p, todayISO: TODAY, lanes, extras }, 'A')!;

describe('RPC mới — A1: hoá đơn thanh lý trả bằng cọc chỉ hiện MỘT dòng', () => {
  it('một dòng "Trừ vào cọc khi thanh lý", không còn hàng tiền phòng kỳ thanh lý; thứ tự Thanh lý → Trừ cọc → Chưa hoàn cọc', () => {
    const d = detailA(caThanhLy());
    expect(titles(d)).toEqual([
      'Thu cọc', 'Ký hợp đồng & nhận phòng',
      'Tiền phòng tháng đầu tiên – 05/2026', 'Tiền phòng tháng cuối – 09/2026',
      'Thanh lý trước hạn', 'Trừ vào cọc khi thanh lý', 'Chưa hoàn cọc cho khách',
    ]);
    const tru = rowOf(d, 'Trừ vào cọc khi thanh lý');
    expect(tru).toMatchObject({ amt: '500.000 đ', note: 'Lấy từ cọc', kind: 'offset', amtTone: 'purple' });
    expect(tru.sub).toBe('Phiếu PC-GIA-02 · trả hoá đơn thanh lý 10/2026');
    expect(d.events.filter((e) => e.amt === '500.000 đ')).toHaveLength(1);
  });

  it('KPI và bảng khách đọc money THEO PHÒNG, không đọc lane.invoice; chữ phụ ĐÃ THU mới', () => {
    const d = detailA(caThanhLy());
    expect(d.kpis[0]).toMatchObject({ value: '6.000.000 đ', sub: 'Khách đã nộp · không gồm cọc, không gồm cấn trừ' });
    expect(d.kpis[1].value).toBe('0 đ');
    expect(d.kpis[2].value).toBe('2.500.000 đ');
    expect(d.balances.tenantRows.map((r) => [r.label, r.value])).toEqual([
      ['Cọc theo HĐ', '3.000.000 đ'],
      ['Cọc đã đóng (thực thu)', '3.900.000 đ'],
      ['Hoá đơn phát sinh', '6.500.000 đ'],
      ['Khách đã nộp', '6.000.000 đ'],
      ['Cấn trừ khi thanh lý', '500.000 đ'],
      ['Khách còn nợ', '0 đ'],
    ]);
    expect(d.kpiNote).toBeNull();
  });

  it('không có phiếu cấn cọc, không chứng từ nào giải thích cấn trừ ⇒ dòng gộp vẫn cảnh báo (r của F6 tính cả khi cọc = 0)', () => {
    const d = detailA(caThanhLy({ voucher: null }));
    const r = rowOf(d, 'Cấn trừ khi thanh lý (không dùng cọc)');
    expect(r).toMatchObject({ amt: '500.000 đ', note: 'Cấn trừ vượt các phiếu quyết toán 500.000 đ', noteTone: 'amber' });
    expect(titles(d)).not.toContain('Thu thêm khi thanh lý – 10/2026');
  });

  it('không có phiếu cấn cọc: số = phần cấn trừ KHÔNG phải tiền (= hàng "Cấn trừ khi thanh lý" của bảng), khách trả thêm là tiền', () => {
    // CT 500.000 = khoản hoàn cấn nợ 200.000 + khách trả thêm 300.000 (phiếu thu, tiền thật) ⇒ money.room.offset = 200.000.
    const d = detailA(caThanhLy({
      voucher: null,
      money: tien({ issued: 6_500_000, paidCash: 6_300_000, offset: 200_000, invoiceCount: 4, depositOnInvoices: 3_000_000 },
        { refund: hoan({ depositDue: 2_500_000, depositOnVouchers: 2_500_000, owed: 2_500_000 }) }),
      extra: [
        ev('TERMINATION_REFUND_OFFSET_POSTED', '2026-10-05', 'A', 200_000, { voucherId: 'v-ro', code: 'PC-GIA-05' }),
        ev('TERMINATION_EXTRA_RECEIPT_POSTED', '2026-10-05', 'A', 300_000, { voucherId: 'v-ex', code: 'PT-GIA-06', invoiceId: 'i3', billingMonth: '2026-10' }),
      ],
    }));
    const r = rowOf(d, 'Cấn trừ khi thanh lý (không dùng cọc)');
    expect(r).toMatchObject({ amt: '200.000 đ', note: 'Cấn trừ, không phải tiền', noteTone: 'purple' });
    expect(r.sub).toBe('trả hoá đơn thanh lý 10/2026 · cấn khoản hoàn 200.000 đ · khách trả thêm 300.000 đ');
    expect(r.amt).toBe(d.balances.tenantRows.find((x) => x.label === 'Cấn trừ khi thanh lý')?.value);
  });

  it('phần cấn trừ vượt phiếu quá 5.000 ⇒ cảnh báo, không gán tên; lệch nhỏ ⇒ "lẻ"', () => {
    const vuot = rowOf(detailA(caThanhLy({ voucher: 400_000 })), 'Trừ vào cọc khi thanh lý');
    expect(vuot).toMatchObject({ note: 'Cấn trừ vượt các phiếu quyết toán 100.000 đ', noteTone: 'amber' });
    const le = rowOf(detailA(caThanhLy({ voucher: 498_000 })), 'Trừ vào cọc khi thanh lý');
    expect(le.sub).toContain('lẻ 2.000 đ');
    expect(le.note).toBe('Lấy từ cọc');
  });

  it('dòng phụ dựng từ chứng từ thật: khoản hoàn cấn nợ + khách trả thêm (dòng riêng, đã thu)', () => {
    const p = caThanhLy({
      extra: [
        can('i2', '2026-09', '2026-10-05', 400_000),
        ev('TERMINATION_REFUND_OFFSET_POSTED', '2026-10-05', 'A', 100_000, { voucherId: 'v-ro', code: 'PC-GIA-05' }),
        ev('TERMINATION_EXTRA_RECEIPT_POSTED', '2026-10-05', 'A', 300_000, { voucherId: 'v-ex', code: 'PT-GIA-06', invoiceId: 'i3', billingMonth: '2026-10' }),
      ],
    });
    const d = detailA(p);
    const tru = rowOf(d, 'Trừ vào cọc khi thanh lý');
    expect(tru.sub).toBe('Phiếu PC-GIA-02 · trả hoá đơn tiền phòng 09/2026, thanh lý 10/2026 · cấn khoản hoàn 100.000 đ · khách trả thêm 300.000 đ');
    expect(tru.note).toBe('Lấy từ cọc');
    expect(rowOf(d, 'Khách trả thêm khi thanh lý')).toMatchObject({
      sub: 'Phiếu thu PT-GIA-06 · hoá đơn kỳ 10/2026', amt: '300.000 đ', note: 'Đã thu',
    });
    expect(rowOf(d, 'Tiền phòng tháng cuối – 09/2026').note).toBe('Đã thu 3.000.000 đ · cấn trừ 400.000 đ');
  });

  it('HĐ chuyển phòng: phiếu cấn cọc gồm hoá đơn phòng khác ⇒ ghi rõ phần đó', () => {
    const p = caThanhLy({
      money: tien(
        { issued: 6_500_000, paidCash: 6_000_000, offset: 500_000, invoiceCount: 4 },
        { contract: { offset: 800_000, roomCount: 2, paidCash: 9_000_000, debt: 0 }, refund: hoan({ depositDue: 2_200_000, depositOnVouchers: 2_200_000, owed: 2_200_000 }) },
      ),
      voucher: 800_000,
    });
    const d = detailA(p);
    expect(rowOf(d, 'Trừ vào cọc khi thanh lý').sub).toContain('gồm 300.000 đ cấn hoá đơn ở phòng khác');
    // 3 số tổng THEO PHÒNG + dòng nhỏ cả HĐ (chủ chốt cách 1).
    expect(d.kpis[0].value).toBe('6.000.000 đ');
    expect(d.kpiNote).toBe('Cả HĐ (2 phòng): đã nộp 9.000.000 đ · còn nợ 0 đ');
  });

  it('phòng cũ của HĐ chuyển phòng: không dựng dòng gộp, hoá đơn được cấn ghi "Trừ vào cọc"', () => {
    const p = payload({
      contracts: [hd('A', { startDate: '2026-01-01', endDate: '2026-12-31', money: tien({ issued: 3_000_000, offset: 3_000_000, invoiceCount: 1 }) })],
      segments: [seg('A', '2026-01-01', '2026-03-31')],
      events: [
        ev('ROOM_CHANGED_OUT', '2026-03-31', 'A'),
        hdon('i1', '2026-03', '2026-03-01', 3_000_000), can('i1', '2026-03', '2026-09-30', 3_000_000),
        ev('SETTLEMENT_OFFSET_POSTED', '2026-09-30', 'A', 3_500_000, { code: 'PC-GIA-09', voucherId: 'v9' }),
      ],
    });
    const d = detailA(p);
    expect(titles(d)).not.toContain('Trừ vào cọc khi thanh lý');
    expect(titles(d)).not.toContain('Cấn cọc khi thanh lý');
    expect(rowOf(d, 'Tiền phòng tháng đầu tiên – 03/2026')).toMatchObject({ note: 'Trừ vào cọc', noteTone: 'purple' });
  });

  it('MONTHLY và SETTLEMENT cùng kỳ tách 2 dòng; tiêu đề thanh lý theo phạt; ngày thu = ngày tiền thật', () => {
    const p = caThanhLy({
      voucher: null,
      extra: [
        hdon('i4', '2026-10', '2026-10-01', 600_000), thu('i4', '2026-10', '2026-10-02', 600_000),
        hdon('i5', '2026-10', '2026-10-05', 200_000, { kind: 'SETTLEMENT', penalty: 200_000 }),
        thu('i5', '2026-10', '2026-10-06', 200_000, 'SETTLEMENT'),
      ],
    });
    const d = detailA(p);
    expect(titles(d)).toEqual(expect.arrayContaining(['Tiền phòng tháng cuối – 10/2026', 'Phí phạt thanh lý – 10/2026']));
    expect(rowOf(d, 'Tiền phòng – 09/2026').sub).toBe('Hoá đơn kỳ 09/2026 · thu ngày 10/09/2026');
    expect(rowOf(d, 'Phí phạt thanh lý – 10/2026').sub).toBe('Hoá đơn kỳ 10/2026 · thu ngày 06/10/2026');
  });

  it('hoá đơn trả hết bằng cấn trừ: có phiếu cấn cọc ⇒ "Trừ vào cọc"; không có ⇒ "Cấn trừ khi thanh lý"; dòng cọc nói ở dòng phụ', () => {
    const extra = [hdon('i6', '2026-08', '2026-08-01', 2_000_000, { depositPart: 1_000_000 }), can('i6', '2026-08', '2026-10-05', 2_000_000)];
    const coCoc = rowOf(detailA(caThanhLy({ extra })), 'Tiền phòng – 08/2026');
    expect(coCoc).toMatchObject({ note: 'Trừ vào cọc', noteTone: 'purple', kind: 'inv' });
    expect(coCoc.sub).toBe('Hoá đơn kỳ 08/2026 · kèm cọc 1.000.000 đ (tính ở mục cọc)');
    // Cấn trừ không có phiếu cọc (HĐ không cọc: khoản hoàn cấn nợ / khách trả thêm) — không được nói "Trừ vào cọc"
    // ngay trên dòng gộp "(không dùng cọc)".
    const d = detailA(caThanhLy({ voucher: null, extra }));
    expect(rowOf(d, 'Tiền phòng – 08/2026')).toMatchObject({ note: 'Cấn trừ khi thanh lý', noteTone: 'purple', kind: 'inv' });
    expect(titles(d)).toContain('Cấn trừ khi thanh lý (không dùng cọc)');
    expect(d.events.some((e) => e.note === 'Trừ vào cọc')).toBe(false);
  });
});

describe('RPC mới — B3: chuỗi nợ kéo, mỗi đồng nợ đếm một lần', () => {
  const p = (nguonDaTra: boolean) => payload({
    contracts: [hd('A', {
      startDate: '2026-05-01', endDate: '2027-04-30',
      money: tien({ issued: 2_200_000, paidCash: nguonDaTra ? 2_200_000 : 0, debt: nguonDaTra ? 0 : 2_200_000, invoiceCount: 2 }),
    })],
    segments: [seg('A', '2026-05-01', null)],
    events: [
      hdon('src', '2026-05', '2026-05-01', 1_000_000, nguonDaTra
        ? { carriedPaid: 1_000_000 }
        : { status: 'OVERDUE', outstanding: 1_000_000, carriedOpen: 1_000_000 }),
      hdon('car', '2026-06', '2026-06-01', 1_200_000, {
        status: nguonDaTra ? 'PAID' : 'PENDING_APPROVAL', total: 2_200_000, carriedIn: 1_000_000,
        outstanding: nguonDaTra ? 0 : 1_200_000, sourceInvoiceIds: ['src'],
      }),
      ...(nguonDaTra ? [thu('car', '2026-06', '2026-06-05', 2_200_000)] : []),
    ],
  });

  it('nguồn còn mở: ghi "đã cộng vào hoá đơn kỳ M", hoá đơn gánh kèm nợ cũ; còn nợ = Σ outstanding', () => {
    const d = detailA(p(false));
    expect(rowOf(d, 'Tiền phòng tháng đầu tiên – 05/2026')).toMatchObject({
      amt: '1.000.000 đ', note: 'Chưa thu · đã cộng vào hoá đơn kỳ 06/2026', kind: 'owe',
    });
    const g = rowOf(d, 'Tiền phòng – 06/2026');
    expect(g).toMatchObject({ amt: '1.200.000 đ', note: 'Chưa thu' });
    expect(g.sub).toBe('Hoá đơn kỳ 06/2026 · kèm nợ cũ 1.000.000 đ');
    expect(d.balances.tenantOwe).toBe(2_200_000);
  });

  it('nguồn đã trả nhờ hoá đơn gánh: "Đã thu cùng hoá đơn kỳ M"', () => {
    const d = detailA(p(true));
    expect(rowOf(d, 'Tiền phòng tháng đầu tiên – 05/2026').note).toBe('Đã thu cùng hoá đơn kỳ 06/2026');
    expect(rowOf(d, 'Tiền phòng – 06/2026').note).toBe('Đã thu');
  });

  it('HĐ chuyển phòng: hoá đơn gánh ở phòng khác (RPC chỉ phát hoá đơn của phòng) ⇒ nói "hoá đơn ở phòng khác"', () => {
    const chiNguon = (daTra: boolean) => ({ ...p(daTra), events: p(daTra).events.filter((e) => e.meta?.invoiceId === 'src') });
    expect(rowOf(detailA(chiNguon(false)), 'Tiền phòng tháng đầu tiên – 05/2026').note).toBe('Chưa thu · đã cộng vào hoá đơn ở phòng khác');
    expect(rowOf(detailA(chiNguon(true)), 'Tiền phòng tháng đầu tiên – 05/2026').note).toBe('Đã thu cùng hoá đơn ở phòng khác');
  });
});

describe('RPC mới — B1/B2: phòng · cả HĐ · hoàn tiền (F3)', () => {
  const daThanhLy = (refund: RefundMoney, extra: LifecycleEvent[] = []) => payload({
    contracts: [hd('A', {
      status: 'TERMINATED', startDate: '2026-01-01', endDate: '2026-06-30', actualEndDate: '2026-06-30',
      money: tien({ issued: 9_000_000, paidCash: 9_000_000, invoiceCount: 3 }, { refund }),
    })],
    segments: [seg('A', '2026-01-01', '2026-06-30')],
    events: [ev('TERMINATION_REQUESTED', '2026-06-30', 'A', refund.depositDue, { status: 'COMPLETED', type: 'NORMAL' }), ...extra],
  });

  it('đã hoàn vượt phải hoàn ⇒ không còn nợ khách', () => {
    const d = detailA(daThanhLy(hoan({ depositDue: 2_000_000, depositPaid: 2_500_000, depositOnVouchers: 2_500_000, owed: 0 })));
    expect(d.balances.chips.map((c) => c.text)).toContain('Đã hoàn cọc 2.500.000 đ');
    expect(d.balances.landOwe).toBe(0);
  });

  it('không phải hoàn cọc nhưng đã trả khách phần ngoài cọc', () => {
    const d = detailA(daThanhLy(hoan({ depositDue: -100_000, otherDue: 1_000_000, otherPaid: 1_000_000, owed: 0 })));
    expect(d.balances.chips.map((c) => c.text)).toContain('Không phải hoàn cọc · đã trả khách 1.000.000 đ');
  });

  it('quyết toán hoàn âm (khấu trừ vượt cọc) mà còn tiền thừa chưa trả ⇒ không in "Phải hoàn" âm', () => {
    const d = detailA(daThanhLy(hoan({ depositDue: -100_000, otherDue: 400_000, owed: 400_000 })));
    expect(rowOf(d, 'Chưa trả khách tiền thừa / tiền phòng')).toMatchObject({ sub: 'tiền thừa 400.000 đ, đã trả 0 đ', amt: '400.000 đ' });
    expect(d.balances.landRows.find((r) => r.label === 'Phải hoàn cọc')?.value).toBe('0 đ');
    expect(d.tiles[2].sub).toBe('Quyết toán hoàn 0 đ');
    expect(d.events.some((e) => /-\d/.test(e.sub) || /-\d/.test(e.amt))).toBe(false);
  });

  it('phiếu chờ duyệt còn tiền thừa ⇒ chủ nhà chưa trả khách, có hàng "Phải trả thêm"', () => {
    const d = detailA(daThanhLy(hoan({
      depositDue: 2_000_000, depositPaid: 2_000_000, depositOnVouchers: 2_000_000, otherDue: 500_000, owed: 500_000,
    })));
    expect(d.balances.chips.map((c) => c.text)).toContain('Chủ nhà chưa trả khách 500.000 đ');
    expect(d.balances.landRows.map((r) => [r.label, r.value])).toEqual(expect.arrayContaining([
      ['Phải hoàn cọc', '2.000.000 đ'], ['Đã hoàn cọc', '2.000.000 đ'],
      ['Phải trả thêm (tiền thừa / tiền phòng)', '500.000 đ'], ['Đã trả thêm', '0 đ'],
      ['Chủ nhà còn nợ khách', '500.000 đ'],
    ]));
    expect(rowOf(d, 'Chưa trả khách tiền thừa / tiền phòng').amt).toBe('500.000 đ');
  });

  it('phiếu hoàn lệch quyết toán ⇒ "Phải hoàn" vẫn theo quyết toán, kèm cảnh báo', () => {
    const d = detailA(daThanhLy(hoan({
      depositDue: 2_000_000, depositPaid: 2_300_000, depositOnVouchers: 2_300_000, owed: 0, warnings: ['DEPOSIT_LINE_MISMATCH'],
    })));
    expect(d.balances.landRows.find((r) => r.label === 'Phải hoàn cọc')?.value).toBe('2.000.000 đ');
    expect(d.balances.chips.find((c) => c.text.startsWith('Phiếu hoàn lệch quyết toán'))).toMatchObject({
      text: 'Phiếu hoàn lệch quyết toán: phiếu ghi cọc 2.300.000 đ, quyết toán 2.000.000 đ', tone: 'amber',
    });
  });

  it('có phiếu hoàn mà chưa có thanh lý hiệu lực ⇒ không lấy cọc đang giữ làm "chủ nhà còn nợ"', () => {
    const p = payload({
      contracts: [hd('A', {
        startDate: '2025-09-01', endDate: '2026-08-31',
        money: tien({}, { refund: hoan({ depositPaid: 1_000_000, depositOnVouchers: 1_000_000, warnings: ['NO_EFFECTIVE_TERMINATION'] }) }),
      })],
      segments: [seg('A', '2025-09-01', null)],
    });
    const d = detailA(p);
    expect(d.kind).toBe('expired');
    expect(d.balances.landOwe).toBeNull();
    expect(d.kpis[2]).toMatchObject({ value: CHUA_DU_DU_LIEU, sub: 'Có phiếu hoàn, chưa có thanh lý hiệu lực' });
    expect(d.balances.chips).toContainEqual({ text: 'Có phiếu hoàn nhưng chưa có thanh lý hiệu lực', tone: 'amber' });
    expect(d.balances.landRows.map((r) => [r.label, r.value])).toContainEqual(['Đã chi qua phiếu hoàn', '1.000.000 đ']);
  });

  it('phiếu hoàn tách dòng cọc / dòng khác; trả ngoài sổ tiền ghi rõ', () => {
    const d = detailA(daThanhLy(hoan({ depositDue: 2_000_000, depositPaid: 2_000_000, depositOnVouchers: 2_000_000, otherDue: 300_000, otherPaid: 300_000, owed: 0, offbook: 300_000 }), [
      ev('DEPOSIT_REFUND_POSTED', '2026-07-02', 'A', 2_000_000, { code: 'PC-GIA-07', voucherId: 'v7', offbook: false }),
      { ...ev('CUSTOMER_REFUND_POSTED', '2026-07-02', 'A', 300_000, { code: 'PC-GIA-08', voucherId: 'v8', offbook: true }), trusted: false },
    ]));
    expect(rowOf(d, 'Hoàn cọc cho khách')).toMatchObject({ amt: '−2.000.000 đ', note: 'Tiền đã ra két' });
    expect(rowOf(d, 'Trả khách tiền thừa / tiền phòng')).toMatchObject({ amt: '−300.000 đ', note: 'Trả ngoài sổ tiền' });
    expect(d.balances.landRows.find((r) => r.label === 'Trong đó trả ngoài sổ tiền')?.value).toBe('300.000 đ');
  });

  it('bỏ cọc: dòng "Cọc chuyển thành doanh thu" nói phần cấn hoá đơn và phạt', () => {
    const p = payload({
      contracts: [hd('A', { status: 'TERMINATED', startDate: '2026-01-01', endDate: '2026-12-31', money: tien({ issued: 1_000_000, offset: 1_000_000, invoiceCount: 1 }) })],
      segments: [seg('A', '2026-01-01', '2026-06-30')],
      events: [
        ev('TERMINATION_REQUESTED', '2026-06-30', 'A', 0, { status: 'COMPLETED', type: 'FORFEIT' }),
        hdon('i9', '2026-06', '2026-06-30', 1_000_000, { kind: 'SETTLEMENT', penalty: 500_000 }),
        can('i9', '2026-06', '2026-06-30', 1_000_000, { kind: 'SETTLEMENT', via: 'FORFEIT', penalty: 500_000 }),
        ev('DEPOSIT_FORFEIT_POSTED', '2026-06-30', 'A', 2_900_000, { code: 'PC-GIA-10', voucherId: 'v10' }),
      ],
    });
    const d = detailA(p);
    expect(d.kind).toBe('forfeit');
    expect(rowOf(d, 'Cọc chuyển thành doanh thu').sub).toBe('Phiếu PC-GIA-10 · cấn hoá đơn 1.000.000 đ (gồm phạt 500.000 đ)');
    expect(titles(d)).not.toContain('Trừ vào cọc khi thanh lý');
  });
});

describe('RPC mới — ĐÃ THU theo năm', () => {
  it('Σ paidYear mọi năm = money.room.paidCash (thu hoá đơn + khách trả thêm)', () => {
    const p = payload({
      contracts: [hd('A', { startDate: '2025-12-01', endDate: '2026-11-30', money: tien({ paidCash: 3_300_000 }) })],
      segments: [seg('A', '2025-12-01', null)],
      events: [
        hdon('i1', '2025-12', '2025-12-01', 1_000_000), thu('i1', '2025-12', '2026-01-03', 1_000_000),
        hdon('i2', '2026-01', '2026-01-01', 2_000_000), thu('i2', '2026-01', '2026-01-05', 2_000_000),
        ev('TERMINATION_EXTRA_RECEIPT_POSTED', '2026-02-10', 'A', 300_000, { voucherId: 'v-ex', code: 'PT-GIA', invoiceId: null, billingMonth: null }),
      ],
    });
    const card = (year: number) => (buildRoomYear({ payload: p, year, todayISO: TODAY, lanes: new Map(), extras: null })
      .items.find((i) => i.type === 'contract') as { card: ContractCard }).card;
    expect(card(2025).paidYear).toBe(1_000_000);
    expect(card(2026).paidYear).toBe(2_300_000);
    expect(card(2025).paidYear + card(2026).paidYear).toBe(p.contracts[0].money!.room.paidCash);
  });
});

describe('RPC mới — hoa hồng / thưởng: 10 type, chỉ là mốc', () => {
  const COMM = LIFECYCLE_EVENT_TYPES.filter((t) => commissionEventOf(t));
  const base = (events: LifecycleEvent[]) => payload({
    contracts: [hd('A', { startDate: '2026-05-01', endDate: '2027-04-30', money: tien({ issued: 3_000_000, paidCash: 3_000_000, invoiceCount: 1 }) })],
    segments: [seg('A', '2026-05-01', null)],
    events: [hdon('i1', '2026-05', '2026-05-01', 3_000_000), thu('i1', '2026-05', '2026-05-03', 3_000_000), ...events],
  });
  const phieu = (type: string, i: number, legacyDup = false) => ({
    ...ev(type, '2026-05-02', 'A', 1_000_000, {
      voucherId: `v-${i}`, code: `PC-GIA-${i}`, name: 'Phiếu giả', kind: type.startsWith('SALE') ? 'sale' : 'broker',
      link: 'direct', stage: commissionEventOf(type)!.stage, approvalStatus: 'APPROVED', postingStatus: 'POSTED', legacyDup,
    }),
    trusted: type.endsWith('_PAID'),
  });

  it.each([
    ['COMMISSION_PENDING', 'Hoa hồng môi giới', 'Chờ duyệt', '1.000.000 đ', 'neutral', 'amber', true, false],
    ['COMMISSION_UNPOSTED', 'Hoa hồng môi giới', 'Đã duyệt, chưa ghi sổ', '1.000.000 đ', 'neutral', 'amber', false, false],
    ['COMMISSION_PAID', 'Hoa hồng môi giới', 'Đã chi', '−1.000.000 đ', 'orange', 'muted', false, false],
    ['COMMISSION_OFFBOOK', 'Hoa hồng môi giới', 'Trả ngoài sổ tiền', '−1.000.000 đ', 'purple', 'purple', false, false],
    ['COMMISSION_REVERSED', 'Hoa hồng môi giới', 'Đã đảo', '1.000.000 đ', 'neutral', 'red', true, true],
    ['SALE_BONUS_PENDING', 'Thưởng Sale', 'Chờ duyệt', '1.000.000 đ', 'neutral', 'amber', true, false],
    ['SALE_BONUS_UNPOSTED', 'Thưởng Sale', 'Đã duyệt, chưa ghi sổ', '1.000.000 đ', 'neutral', 'amber', false, false],
    ['SALE_BONUS_PAID', 'Thưởng Sale', 'Đã chi', '−1.000.000 đ', 'orange', 'muted', false, false],
    ['SALE_BONUS_OFFBOOK', 'Thưởng Sale', 'Trả ngoài sổ tiền', '−1.000.000 đ', 'purple', 'purple', false, false],
    ['SALE_BONUS_REVERSED', 'Thưởng Sale', 'Đã đảo', '1.000.000 đ', 'neutral', 'red', true, true],
  ] as const)('%s', (type, title, note, amt, amtTone, noteTone, hollow, struck) => {
    const d = detailA(base([phieu(type, 1)]));
    const r = d.events.find((e) => e.kind === 'comm')!;
    expect(r).toMatchObject({ title, note, amt, amtTone, noteTone, sub: 'Phiếu PC-GIA-1 · Phiếu giả' });
    expect(!!r.hollow).toBe(hollow);
    expect(!!r.struck).toBe(struck);
  });

  it('KPI, bảng cọc/công nợ và ĐÃ THU năm KHÔNG đổi khi có đủ 10 loại phiếu', () => {
    const khong = base([]);
    const co = base(COMM.map((t, i) => phieu(t, i)));
    const lanes = new Map([['A', lane('A')]]);
    const dKhong = detailA(khong, null, lanes);
    const dCo = detailA(co, null, lanes);
    expect(dCo.kpis).toEqual(dKhong.kpis);
    expect(dCo.balances).toEqual(dKhong.balances);
    const y = (p: LifecyclePayload) => buildRoomYear({ payload: p, year: 2026, todayISO: TODAY, lanes, extras: null });
    expect(y(co).kpis).toEqual(y(khong).kpis);
    expect(dCo.events.filter((e) => e.kind === 'comm')).toHaveLength(10);
  });

  it('"phiếu trùng cũ" chỉ khi HĐ có ≥ 2 phiếu cùng loại', () => {
    const mot = detailA(base([phieu('COMMISSION_PAID', 1, true)]));
    expect(mot.events.find((e) => e.kind === 'comm')!.sub).not.toContain('phiếu trùng cũ');
    const hai = detailA(base([phieu('COMMISSION_PAID', 1, true), phieu('COMMISSION_PAID', 2)]));
    expect(hai.events.filter((e) => e.kind === 'comm').map((e) => e.sub)).toEqual([
      'Phiếu PC-GIA-1 · Phiếu giả · phiếu trùng cũ', 'Phiếu PC-GIA-2 · Phiếu giả',
    ]);
    // Phiếu khác loại không tính là "cùng loại".
    const khacLoai = detailA(base([phieu('COMMISSION_PAID', 1, true), phieu('SALE_BONUS_PAID', 2)]));
    expect(khacLoai.events.find((e) => e.sub.startsWith('Phiếu PC-GIA-1'))!.sub).not.toContain('phiếu trùng cũ');
  });
});

describe('RPC mới — A2: dòng Ký hợp đồng in hạn gốc', () => {
  const ky = (o: Partial<LifecycleContract>) => {
    const p = payload({
      contracts: [hd('A', { startDate: '2026-05-01', endDate: '2027-02-28', ...o })],
      segments: [seg('A', '2026-05-01', null)],
    });
    return rowOf(detailA(p), 'Ký hợp đồng & nhận phòng').sub;
  };
  it.each([
    ['RPC cũ (vắng khoá)', {}, 'HĐ-A · thời hạn 01/05/2026 → 28/02/2027'],
    ['không gia hạn', { originalEndDate: null }, 'HĐ-A · thời hạn 01/05/2026 → 28/02/2027'],
    ['có gia hạn', { originalEndDate: '2026-08-30' }, 'HĐ-A · thời hạn 01/05/2026 → 30/08/2026 · gia hạn tới 28/02/2027'],
    ['hạn gốc = hạn hiện tại', { originalEndDate: '2027-02-28' }, 'HĐ-A · thời hạn 01/05/2026 → 28/02/2027'],
  ] as const)('%s', (_ten, o, sub) => {
    expect(ky(o)).toBe(sub);
  });
});

describe('payload RPC cũ — giữ nguyên hành vi', () => {
  it('COMMISSION_PAID không voucherId và phiếu cấn cọc không voucherId ⇒ dòng cũ; KPI đọc lane', () => {
    const p = payload({
      contracts: [hd('A', { status: 'TERMINATED', startDate: '2026-01-01', endDate: '2026-12-31', actualEndDate: '2026-06-15' })],
      segments: [seg('A', '2026-01-01', '2026-06-15')],
      events: [
        ev('INVOICE_ISSUED', '2026-06-15', 'A', 500_000, { billingMonth: '2026-06', status: 'PAID' }),
        ev('INVOICE_COLLECTION_POSTED', '2026-06-15', 'A', 500_000, { billingMonth: '2026-06' }),
        ev('TERMINATION_REQUESTED', '2026-06-15', 'A', 3_400_000, { status: 'COMPLETED', type: 'EARLY_TENANT' }),
        ev('SETTLEMENT_OFFSET_POSTED', '2026-06-15', 'A', 500_000, { code: 'PC-GIA-02' }),
        ev('COMMISSION_PAID', '2026-01-02', 'A', 1_000_000, { code: 'PC-GIA-04', name: 'HH giả' }),
      ],
    });
    const d = detailA(p);
    expect(titles(d)).toEqual(expect.arrayContaining(['Cấn cọc khi thanh lý', 'Hoa hồng / thưởng', 'Tiền phòng tháng đầu tiên – 06/2026']));
    expect(rowOf(d, 'Hoa hồng / thưởng')).toMatchObject({ kind: 'mark', amt: '−1.000.000 đ' });
    expect(d.kpis[0]).toMatchObject({ value: '10.000.000 đ', sub: 'Tiền phòng + dịch vụ, không gồm cọc' });
    expect(d.balances.tenantRows.map((r) => r.label)).toContain('Đã thu');
    expect(d.kpiNote).toBeNull();
  });

  it('hai dòng cùng ngày cùng nhóm giữ ĐÚNG thứ tự của RPC cũ (date, type theo chữ cái)', () => {
    const p = payload({
      contracts: [hd('A', { status: 'TERMINATED', startDate: '2026-01-01', endDate: '2026-12-31', actualEndDate: '2026-06-30' })],
      segments: [seg('A', '2026-01-01', '2026-06-30')],
      // Thứ tự đúng như RPC cũ trả (ORDER BY date, type).
      events: [
        ev('COMMISSION_PAID', '2026-06-30', 'A', 200_000, { code: 'PC-GIA-04', name: 'HH giả' }),
        ev('DEPOSIT_FORFEIT_POSTED', '2026-06-30', 'A', 2_000_000, { code: 'PC-GIA-07' }),
        ev('SETTLEMENT_OFFSET_POSTED', '2026-06-30', 'A', 300_000, { code: 'PC-GIA-02' }),
        ev('TERMINATION_REQUESTED', '2026-06-30', 'A', 0, { status: 'COMPLETED', type: 'FORFEIT' }),
      ],
    });
    const d = detailA(p);
    const giu = (kinds: string[]) => d.events.filter((e) => kinds.includes(e.kind)).map((e) => e.title);
    expect(giu(['mark'])).toEqual(['Hoa hồng / thưởng', 'Cấn cọc khi thanh lý']);
    expect(giu(['forfeit'])).toEqual(['Cọc chuyển thành doanh thu', 'Khách bỏ cọc · thanh lý HĐ']);
  });
});
