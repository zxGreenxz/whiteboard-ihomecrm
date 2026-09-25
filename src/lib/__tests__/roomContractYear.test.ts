import { describe, it, expect } from 'vitest';
import { CHUA_DU_DU_LIEU, type Lane } from '../contractLifecycle';
import type { LifecycleContract, LifecycleEvent, LifecyclePayload } from '../roomLifecycle';
import {
  buildContractDetail, buildRoomYear, buildStays, daysBetween, monthsBetween,
  type RoomContractExtras,
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
