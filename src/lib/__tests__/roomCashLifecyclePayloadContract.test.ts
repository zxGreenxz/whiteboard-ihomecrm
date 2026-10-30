// Hợp đồng payload `get_room_cash_lifecycle_v1` ↔ client, trên payload THẬT. fixtures/roomCashLifecyclePayload.sample.json
// là đầu ra của RPC (thân 20261028203816) trên fixture PGlite của scripts/__tests__/room-cash-lifecycle-one-source-sql.test.mjs
// — test SQL đó đỏ khi tệp lệch RPC. Ở đây kiểm: hình dạng khớp kiểu TS (roomLifecycle.ts) và cách ngăn kéo Báo cáo LN
// (roomContractYear.ts) đọc nó. Số, mã, id đều GIẢ.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHUA_DU_DU_LIEU, type Lane, type TerminationRow } from '../contractLifecycle';
import { fmtMoney } from '../contractSettlement';
import {
  COMMISSION_KIND_LABEL, COMMISSION_STAGES, EVENT_LABEL, LIFECYCLE_EVENT_TYPES, STAGE_TEXT, commissionEventOf, eventLabelOf,
  type CommissionEventType, type CommissionVoucherMeta, type LifecycleEventType, type LifecyclePayload,
} from '../roomLifecycle';
import {
  buildContractDetail, buildRoomYear, buildStays, type BalanceRow, type ContractCard, type ContractDetailView, type RoomContractExtras,
} from '../roomContractYear';

interface Sample { rooms: Record<string, string>; labels: Record<string, string>; payloads: Record<string, LifecyclePayload> }
const S: Sample = JSON.parse(readFileSync(new URL('./fixtures/roomCashLifecyclePayload.sample.json', import.meta.url), 'utf8'));
/** Ngày tổ chức cố định của fixture (org_today_v1). */
const TODAY = '2026-10-29';

const idOf = (label: string): string => {
  const hit = Object.entries(S.labels).find(([, l]) => l === label);
  if (!hit) throw new Error(`thiếu nhãn ${label}`);
  return hit[0];
};
const contractOf = (room: string, label: string) => {
  const c = S.payloads[room].contracts.find((x) => x.id === idOf(label));
  if (!c?.money) throw new Error(`${room}/${label} thiếu money`);
  return { ...c, money: c.money };
};

// ── Nguồn ngoài RPC (lane cọc/thanh lý, đọc phụ) — dựng theo đúng fixture SQL ──────────────────────
const TERMINATIONS: Record<string, Pick<TerminationRow, 'status' | 'termination_date' | 'termination_type' | 'refund_amount'>> = {
  A: { status: 'APPROVED', termination_date: '2026-03-31', termination_type: 'EARLY_TENANT', refund_amount: 1_200_000 },
  G: { status: 'APPROVED', termination_date: '2026-06-15', termination_type: 'FORFEIT', refund_amount: 0 },
  // Thanh lý hiệu lực MỚI NHẤT của R (bản 06/01 COMPLETED cũ hơn).
  R: { status: 'APPROVED', termination_date: '2026-06-30', termination_type: 'EARLY_TENANT', refund_amount: 2_000_000 },
};
const lanes = new Map<string, Lane>();
for (const p of Object.values(S.payloads)) {
  for (const c of p.contracts) {
    const label = S.labels[c.id];
    const t = TERMINATIONS[label];
    lanes.set(c.id, {
      contractId: c.id, contractNumber: c.number, customer: 'Khách Giả', role: '', tag: '', target: false, steps: [],
      deposit: {
        grossCollected: 2_000_000, offsetOut: 0, netHeld: 2_000_000, historicalIn: 0, historicalOut: 0, historicalNet: 0,
        evidence: [{ voucherId: `v-${label}`, code: `PT-GIA-${label}`, date: c.startDate ?? TODAY, amount: 2_000_000, direction: 'IN', bucket: 'REAL_CASH', verification: 'verified' }],
        excluded: [], hasUnverified: false,
      },
      settlementDeposit: null, invoice: null,
      termination: t ? { id: `t-${label}`, contract_id: c.id, organization_id: null, outstanding_debt: 0, total_deposit: 2_000_000, ...t } : null,
      isTerminated: !!t, terminatedAt: t?.termination_date ?? null, segment: null, trusted: true, diagnostics: [],
    });
  }
}
const extras: RoomContractExtras = {
  transfers: [{ contractId: idOf('D'), type: 'ROOM_CHANGE', date: '2026-06-01', oldRoomId: S.rooms.D1, newRoomId: S.rooms.D2, newRoomName: 'P-D2' }],
  extensions: [], customers: new Map(),
};

const detailOf = (payload: LifecyclePayload, contractId: string): ContractDetailView => {
  const d = buildContractDetail({ payload, todayISO: TODAY, lanes, extras }, contractId);
  if (!d) throw new Error(`không dựng được ngăn ${contractId}`);
  return d;
};
const detail = (room: string, label: string) => detailOf(S.payloads[room], idOf(label));
const titles = (d: ContractDetailView) => d.events.map((e) => e.title);
const rowOf = (d: ContractDetailView, title: string) => {
  const r = d.events.find((e) => e.title === title);
  if (!r) throw new Error(`thiếu dòng ${title}`);
  return r;
};
const table = (rows: BalanceRow[]) => Object.fromEntries(rows.map((r) => [r.label, r.value]));
/** Mọi cặp (phòng, HĐ) mà ngăn kéo dựng được — HĐ phải có nhịp ở phòng đó. */
const STAYS = Object.entries(S.payloads).flatMap(([room, p]) => buildStays(p).map((s) => [room, S.labels[s.contract.id]] as const));

// ── Hình dạng: khoá + kiểu giá trị theo hợp đồng payload (mục 2–4) ─────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown) => typeof v === 'string';
const isUuid = (v: unknown) => typeof v === 'string' && UUID.test(v);
const isDay = (v: unknown) => typeof v === 'string' && DAY.test(v);
const isMonth = (v: unknown) => typeof v === 'string' && MONTH.test(v);
const orNull = (f: (v: unknown) => boolean) => (v: unknown) => v === null || f(v);
const oneOf = (...xs: string[]) => (v: unknown) => typeof v === 'string' && xs.includes(v);

const keysOf = (o: object) => Object.keys(o).sort();
const MONEY_KEYS = ['issued', 'paidCash', 'offset', 'debt', 'overpaid', 'invoiceCount', 'roomCount', 'depositOnInvoices', 'creditUsed'];
const REFUND_KEYS = ['depositDue', 'depositPaid', 'depositOnVouchers', 'otherDue', 'otherPaid', 'owed', 'offbook', 'warnings'];
const CONTRACT_KEYS = ['id', 'number', 'status', 'startDate', 'endDate', 'actualEndDate', 'rentPrice', 'totalDeposit', 'tenantName',
  'originalEndDate', 'money'];
const COMMISSION_META = ['voucherId', 'code', 'name', 'kind', 'link', 'stage', 'approvalStatus', 'postingStatus', 'legacyDup'];
const COMMISSION_META_KEYS = {} as Record<CommissionEventType, readonly string[]>;
for (const t of LIFECYCLE_EVENT_TYPES) if (commissionEventOf(t)) COMMISSION_META_KEYS[t as CommissionEventType] = COMMISSION_META;
/** Khoá meta theo type (hợp đồng payload mục 4) — thiếu type nào là lỗi biên dịch. */
const META_KEYS: Record<LifecycleEventType, readonly string[]> = {
  CONTRACT_OPENED: ['segIndex', 'sourcePath'], ROOM_CHANGED_IN: ['segIndex', 'sourcePath'],
  ROOM_CHANGED_OUT: ['segIndex'], CONTRACT_CLOSED: ['segIndex'],
  DEPOSIT_RECEIVED: ['code', 'voucherId'], TERMINATION_REQUESTED: ['status', 'type', 'terminationId'],
  SETTLEMENT_OFFSET_POSTED: ['code', 'voucherId'], DEPOSIT_FORFEIT_POSTED: ['code', 'voucherId'],
  DEPOSIT_REFUND_POSTED: ['code', 'voucherId', 'offbook'], CUSTOMER_REFUND_POSTED: ['code', 'voucherId', 'offbook'],
  TERMINATION_EXTRA_RECEIPT_POSTED: ['voucherId', 'code', 'invoiceId', 'billingMonth'],
  TERMINATION_REFUND_OFFSET_POSTED: ['voucherId', 'code'],
  INVOICE_ISSUED: ['invoiceId', 'billingMonth', 'status', 'kind', 'total', 'carriedIn', 'depositPart', 'penalty', 'outstanding',
    'carriedOpen', 'carriedPaid', 'sourceInvoiceIds', 'creditUsed'],
  INVOICE_COLLECTION_POSTED: ['invoiceId', 'billingMonth', 'kind', 'depositPaid'],
  INVOICE_TERMINATION_OFFSET: ['invoiceId', 'billingMonth', 'kind', 'via', 'penalty', 'depositOffset'],
  ...COMMISSION_META_KEYS,
};
/** Kiểu giá trị theo tên khoá meta; vài khoá đổi kiểu theo type (null ở phiếu trả thêm, kind của hoa hồng). */
const META_VALUE: Record<string, (v: unknown, type: string) => boolean> = {
  segIndex: (v) => Number.isInteger(v), sourcePath: orNull(isStr), code: orNull(isStr), status: isStr, type: orNull(isStr),
  voucherId: isUuid, terminationId: isUuid,
  invoiceId: (v, type) => (type === 'TERMINATION_EXTRA_RECEIPT_POSTED' ? orNull(isUuid)(v) : isUuid(v)),
  billingMonth: (v, type) => (type === 'TERMINATION_EXTRA_RECEIPT_POSTED' ? orNull(isMonth)(v) : isMonth(v)),
  kind: (v, type) => (commissionEventOf(type) ? oneOf('broker', 'sale')(v) : oneOf('MONTHLY', 'SETTLEMENT')(v)),
  total: isNum, carriedIn: isNum, depositPart: isNum, penalty: isNum, outstanding: isNum, carriedOpen: isNum, carriedPaid: isNum,
  depositPaid: isNum, depositOffset: isNum, creditUsed: (v) => isNum(v) && (v as number) >= 0,
  sourceInvoiceIds: (v) => Array.isArray(v) && v.every(isUuid),
  via: oneOf('MOVE_OUT', 'FORFEIT'),
  offbook: (v) => typeof v === 'boolean', legacyDup: (v) => typeof v === 'boolean',
  name: isStr, link: oneOf('direct', 'deposit_claim'),
  stage: (v, type) => v === commissionEventOf(type)?.stage,
  approvalStatus: isStr, postingStatus: orNull(isStr),
};
const SEGMENT_TYPES = new Set(['CONTRACT_OPENED', 'ROOM_CHANGED_IN', 'ROOM_CHANGED_OUT', 'CONTRACT_CLOSED']);

describe('payload thật khớp kiểu TS (roomLifecycle.ts) và hợp đồng payload', () => {
  it('khung ngoài, contracts[] và money: đủ khoá, đúng kiểu', () => {
    for (const [room, p] of Object.entries(S.payloads)) {
      expect(keysOf(p), room).toEqual(['contracts', 'events', 'generatedAt', 'range', 'room', 'segments', 'vacancies']);
      expect(p.room.id, room).toBe(S.rooms[room]);
      expect(p.range, room).toEqual({ from: null, to: null });
      for (const c of p.contracts) {
        const tag = `${room}/${S.labels[c.id]}`;
        expect(keysOf(c), tag).toEqual([...CONTRACT_KEYS].sort());
        expect([c.startDate, c.endDate].every(isDay), tag).toBe(true);
        expect([c.actualEndDate, c.originalEndDate].every(orNull(isDay)), tag).toBe(true);
        const m = c.money;
        expect(m && keysOf(m), tag).toEqual(['contract', 'refund', 'room']);
        for (const scope of [m!.contract, m!.room]) {
          expect(keysOf(scope), tag).toEqual([...MONEY_KEYS].sort());
          expect(Object.values(scope).every(isNum), tag).toBe(true);
          expect([scope.offset, scope.debt, scope.overpaid, scope.creditUsed ?? Number.NaN].every((x) => x >= 0), tag).toBe(true);
        }
        expect(m!.room.roomCount, tag).toBeLessThanOrEqual(1);
        const r = m!.refund;
        if (r) {
          expect(keysOf(r), tag).toEqual([...REFUND_KEYS].sort());
          expect([r.depositPaid, r.depositOnVouchers, r.otherDue, r.otherPaid, r.offbook].every(isNum), tag).toBe(true);
          expect([r.depositDue, r.owed].every(orNull(isNum)), tag).toBe(true);
          expect(r.warnings.every(oneOf('NO_EFFECTIVE_TERMINATION', 'DEPOSIT_LINE_MISMATCH')), tag).toBe(true);
          // owed null đúng khi depositDue null (không có thanh lý hiệu lực).
          expect(r.owed === null, tag).toBe(r.depositDue === null);
        }
      }
    }
  });

  it('events[]: type thuộc 25 type, meta đúng bộ khoá và kiểu giá trị theo type', () => {
    for (const [room, p] of Object.entries(S.payloads)) {
      for (const e of p.events) {
        const tag = `${room} ${e.date} ${e.type}`;
        expect(LIFECYCLE_EVENT_TYPES as readonly string[], tag).toContain(e.type);
        expect(keysOf(e), tag).toEqual(['amount', 'contractId', 'date', 'meta', 'trusted', 'type']);
        expect(isDay(e.date) && isUuid(e.contractId) && typeof e.trusted === 'boolean', tag).toBe(true);
        // Mốc cư trú không có tiền; còn lại là số (TERMINATION_REQUESTED: refund_amount có thể null).
        if (SEGMENT_TYPES.has(e.type)) expect(e.amount, tag).toBeNull();
        else if (e.type !== 'TERMINATION_REQUESTED') expect(isNum(e.amount), tag).toBe(true);
        const meta = e.meta;
        expect(meta, tag).not.toBeNull();
        expect(keysOf(meta!), tag).toEqual([...META_KEYS[e.type as LifecycleEventType]].sort());
        for (const [k, v] of Object.entries(meta!)) expect(META_VALUE[k](v, e.type), `${tag} meta.${k}=${JSON.stringify(v)}`).toBe(true);
      }
    }
  });

  it('mọi type có nhãn riêng; mẫu phủ đủ 15 type nền và đủ 5 trạng thái hoa hồng/thưởng', () => {
    const seen = new Set<string>();
    for (const p of Object.values(S.payloads)) {
      for (const e of p.events) {
        seen.add(e.type);
        expect(EVENT_LABEL, e.type).toHaveProperty(e.type);
        expect(eventLabelOf(e).label, e.type).not.toBe(e.type);
        // Nhãn hoa hồng đã nói trạng thái ⇒ feed /thu-tien không gắn thêm "chưa vào sổ thật".
        expect(eventLabelOf(e).statusInLabel ?? false, e.type).toBe(commissionEventOf(e.type) !== null);
      }
    }
    expect([...seen].filter((t) => !commissionEventOf(t)).sort()).toEqual(
      LIFECYCLE_EVENT_TYPES.filter((t) => !commissionEventOf(t)).sort(),
    );
    expect(new Set([...seen].map((t) => commissionEventOf(t)?.stage).filter(Boolean))).toEqual(new Set(COMMISSION_STAGES));
    expect(new Set([...seen].map((t) => commissionEventOf(t)?.kind).filter(Boolean))).toEqual(new Set(['broker', 'sale']));
  });
});

describe('ngăn kéo Báo cáo LN đọc payload thật', () => {
  it.each(STAYS)('%s/%s: 3 số tổng và bảng khách theo money.room (phòng đang xem); dòng "Cả HĐ" khi ≥ 2 phòng', (room, label) => {
    const { money: m } = contractOf(room, label);
    const d = detail(room, label);
    expect(d.kpis[0]).toMatchObject({ label: 'ĐÃ THU', value: fmtMoney(m.room.paidCash) });
    expect(d.balances.invoicePaid).toBe(m.room.paidCash);
    expect(d.balances.invoiceDebt).toBe(m.room.debt);
    // Cọc tính theo HĐ (lane): nhịp đã kết thúc thì không còn "thiếu cọc".
    expect(d.balances.tenantOwe).toBe((d.balances.depositShort ?? Number.NaN) + m.room.debt);
    expect(d.kpis[1].value).toBe(fmtMoney(d.balances.tenantOwe!));
    const t = table(d.balances.tenantRows);
    expect(t).toMatchObject({ 'Hoá đơn phát sinh': fmtMoney(m.room.issued), 'Khách đã nộp': fmtMoney(m.room.paidCash) });
    expect(t['Cấn trừ khi thanh lý']).toBe(m.room.offset > 0 ? fmtMoney(m.room.offset) : undefined);
    expect(t['Thu dư']).toBe(m.room.overpaid > 0 ? fmtMoney(m.room.overpaid) : undefined);
    const credit = m.room.creditUsed ?? 0;
    expect(t['Tiền thừa đã trừ kỳ sau / khi thanh lý']).toBe(credit > 0 ? fmtMoney(credit) : undefined);
    expect(d.tiles[3].sub).toContain(`${m.room.invoiceCount} hoá đơn`);
    expect(d.kpiNote).toBe(m.contract.roomCount > 1
      ? `Cả HĐ (${m.contract.roomCount} phòng): đã nộp ${fmtMoney(m.contract.paidCash)} · còn nợ ${fmtMoney(m.contract.debt)}`
      : null);
  });

  it('HĐ hai phòng: mỗi phòng một số ĐÃ THU riêng, cùng một dòng "Cả HĐ"; tổng hai phòng = cả HĐ', () => {
    const [d1, d2] = [detail('D1', 'D'), detail('D2', 'D')];
    expect([d1.kpis[0].value, d2.kpis[0].value]).toEqual(['2.000.500 đ', '2.650.000 đ']);
    expect(d1.kpiNote).toBe('Cả HĐ (2 phòng): đã nộp 4.650.500 đ · còn nợ 0 đ');
    expect(d2.kpiNote).toBe(d1.kpiNote);
    const [m1, m2] = [contractOf('D1', 'D').money, contractOf('D2', 'D').money];
    for (const k of ['issued', 'paidCash', 'invoiceCount', 'depositOnInvoices'] as const) expect(m1.room[k] + m2.room[k], k).toBe(m1.contract[k]);
    expect(d1.kind).toBe('room');
    expect(rowOf(d1, 'Chuyển sang phòng P-D2').note).toBe('Cọc chuyển theo');
  });

  it('CHỦ NHÀ CÒN NỢ KHÁCH = refund.owed; cọc đã hoàn đủ ⇒ phần còn nợ gọi là tiền thừa; không thanh lý hiệu lực ⇒ chưa đủ dữ liệu', () => {
    expect(detail('A', 'A').kpis[2]).toMatchObject({ value: '1.200.000 đ', sub: 'Cọc chưa hoàn' });
    const r = detail('R', 'R');
    expect(r.kpis[2]).toMatchObject({ value: fmtMoney(contractOf('R', 'R').money.refund!.owed!), sub: 'Tiền thừa / tiền phòng chưa trả' });
    expect(r.balances.chips.map((c) => c.text)).toEqual(expect.arrayContaining([
      'Chủ nhà chưa trả khách 200.000 đ',
      'Phiếu hoàn lệch quyết toán: phiếu ghi cọc 2.500.000 đ, quyết toán 2.000.000 đ',
    ]));
    expect(table(r.balances.landRows)).toMatchObject({
      'Phải hoàn cọc': '2.000.000 đ', 'Đã hoàn cọc': '2.000.000 đ', 'Phải trả thêm (tiền thừa / tiền phòng)': '600.000 đ',
      'Đã trả thêm': '400.000 đ', 'Trong đó trả ngoài sổ tiền': '500.000 đ', 'Chủ nhà còn nợ khách': '200.000 đ',
    });
    // Phần cọc / phần tiền thừa của cùng một phiếu là hai dòng; phiếu sổ ảo nói rõ.
    expect(r.events.filter((e) => e.kind === 'ref').map((e) => `${e.title}|${e.amt}|${e.note}`)).toEqual([
      'Hoàn cọc cho khách|−1.500.000 đ|Tiền đã ra két',
      'Trả khách tiền thừa / tiền phòng|−400.000 đ|Tiền đã ra két',
      'Hoàn cọc cho khách|−500.000 đ|Trả ngoài sổ tiền',
    ]);
    const rb = detail('R', 'RB');
    expect(rb.kpis[2]).toMatchObject({ value: CHUA_DU_DU_LIEU, sub: 'Có phiếu hoàn, chưa có thanh lý hiệu lực' });
    expect(rb.balances.landOwe).toBeNull();
    expect(rb.balances.chips.map((c) => c.text)).toContain('Có phiếu hoàn nhưng chưa có thanh lý hiệu lực');
  });

  it('dòng gộp cấn trừ: đúng MỘT dòng ở ngăn kết thúc bằng thanh lý; không có ở chuyển phòng, bỏ cọc, đang ở', () => {
    const count = Object.fromEntries(STAYS.map(([room, label]) => [`${room}/${label}`, detail(room, label).events.filter((e) => e.kind === 'offset').length]));
    expect(count).toEqual({
      'A/A': 1, 'B/B': 0, 'C/C': 0, 'D1/D': 0, 'D2/D': 1, 'F/F': 1, 'G/G': 0, 'R/R': 0, 'R/RB': 0, 'K/K': 0, 'L/L': 0,
      'P/P1': 1, 'P/P6': 1, 'P/P2': 0, 'T/T1': 0, 'T/T2': 0, 'T/T3': 0, 'T/T4': 0, 'T/T5': 0, 'T/T6': 0, 'T/T7': 0,
      'T/T8': 0, 'T/T9': 0,
    });

    const a = detail('A', 'A');
    const coc = S.payloads.A.events.find((e) => e.type === 'SETTLEMENT_OFFSET_POSTED')!;
    expect(rowOf(a, 'Trừ vào cọc khi thanh lý')).toMatchObject({
      amt: fmtMoney(coc.amount!), note: 'Lấy từ cọc', sub: 'Phiếu PC-GIA-offA · trả hoá đơn tiền phòng 02/2026, thanh lý 03/2026',
    });
    // Hoá đơn thanh lý đã cấn hết không còn hàng riêng; thứ tự Thanh lý → Trừ vào cọc → Chưa hoàn cọc.
    expect(titles(a).filter((x) => x.includes('khi thanh lý – '))).toEqual([]);
    expect(titles(a).slice(-3)).toEqual(['Thanh lý trước hạn', 'Trừ vào cọc khi thanh lý', 'Chưa hoàn cọc cho khách']);

    expect(rowOf(detail('F', 'F'), 'Trừ vào cọc khi thanh lý')).toMatchObject({
      amt: '2.000.000 đ', note: 'Cấn trừ vượt các phiếu quyết toán 1.000.000 đ', noteTone: 'amber',
    });
    // Không có phiếu cấn cọc: số = phần cấn trừ không phải tiền của phòng (= hàng "Cấn trừ khi thanh lý" của bảng,
    // khách trả thêm là tiền thật); CT 700.000 chỉ có chứng từ cho 170.000 ⇒ r = 530.000 > 5.000 ⇒ cảnh báo (F6).
    const dD2 = detail('D2', 'D');
    const d2 = rowOf(dD2, 'Cấn trừ khi thanh lý (không dùng cọc)');
    expect(d2).toMatchObject({ amt: '550.000 đ', note: 'Cấn trừ vượt các phiếu quyết toán 530.000 đ', noteTone: 'amber' });
    expect(d2.amt).toBe(table(dD2.balances.tenantRows)['Cấn trừ khi thanh lý']);
    expect(d2.sub).toBe('trả hoá đơn thanh lý 07/2026 · cấn khoản hoàn 20.000 đ · khách trả thêm 150.000 đ');
    // Khoản hoàn cấn nợ phát theo HĐ (cả phòng cũ) nhưng chỉ phòng thanh lý nói tới nó.
    expect(S.payloads.D1.events.some((e) => e.type === 'TERMINATION_REFUND_OFFSET_POSTED')).toBe(true);
    expect(detail('D1', 'D').events.some((e) => e.sub.includes('cấn khoản hoàn'))).toBe(false);
    // Phiếu cấn cọc thô của RPC cũ không còn là dòng riêng.
    for (const [room, label] of STAYS) expect(titles(detail(room, label)), `${room}/${label}`).not.toContain('Cấn cọc khi thanh lý');
    // Dòng cọc trên hoá đơn tất toán bằng cấn trừ (P): HĐ không có phiếu cấn cọc ⇒ hàng hoá đơn không gọi là "Trừ vào
    // cọc"; cấn trừ chỉ là phần doanh thu; không thu dư ảo; nợ thật kỳ sau còn nguyên.
    const p1 = detail('P', 'P1');
    expect(rowOf(p1, 'Tiền phòng tháng đầu tiên – 05/2026')).toMatchObject({
      amt: '1.000.000 đ', note: 'Cấn trừ khi thanh lý', noteTone: 'purple', sub: 'Hoá đơn kỳ 05/2026 · kèm cọc 3.000.000 đ (tính ở mục cọc)',
    });
    expect(table(p1.balances.tenantRows)).toMatchObject({ 'Hoá đơn phát sinh': '1.000.000 đ', 'Cấn trừ khi thanh lý': '1.000.000 đ' });
    expect(table(p1.balances.tenantRows)['Thu dư']).toBeUndefined();
    expect(detail('P', 'P6').kpis[1].value).toBe('2.500.000 đ');
    expect(p1.events.some((e) => e.note === 'Trừ vào cọc')).toBe(false);
  });

  it('thu dư của writer cũ đã trừ kỳ sau / khi thanh lý (phòng T): ĐÃ THU là tiền thật, không còn "Thu dư" ảo, nợ thật không bị che', () => {
    const t1 = detail('T', 'T1');
    expect(t1.kpis[0].value).toBe('2.000.000 đ');
    expect(t1.balances.invoiceDebt).toBe(1_000_000);
    expect(table(t1.balances.tenantRows)).toMatchObject({
      'Hoá đơn phát sinh': '2.998.000 đ', 'Khách đã nộp': '2.000.000 đ', 'Tiền thừa đã trừ kỳ sau / khi thanh lý': '2.000 đ', 'Khách còn nợ': '1.000.000 đ',
    });
    expect(table(t1.balances.tenantRows)['Thu dư']).toBeUndefined();
    expect(rowOf(t1, 'Tiền phòng tháng đầu tiên – 03/2025')).toMatchObject({
      sub: 'Hoá đơn kỳ 03/2025 · thu ngày 05/03/2025 · thừa 2.000 đ đã trừ kỳ sau / khi thanh lý', note: 'Đã thu',
    });
    // Áp một phần: phần chưa áp vẫn là thu dư, đứng cạnh dòng thừa đã trừ.
    const t2 = table(detail('T', 'T2').balances.tenantRows);
    expect([t2['Thu dư'], t2['Tiền thừa đã trừ kỳ sau / khi thanh lý']]).toEqual(['3.000 đ', '2.000 đ']);
    // Áp vào hoá đơn đã huỷ / đã xoá: chưa dùng ⇒ không có dòng mới, thu dư vẫn bù nợ kỳ khác.
    const t4 = detail('T', 'T4');
    expect(table(t4.balances.tenantRows)['Tiền thừa đã trừ kỳ sau / khi thanh lý']).toBeUndefined();
    expect(t4.balances.invoiceDebt).toBe(299_200);
    expect(t4.events.some((e) => e.sub.includes('đã trừ kỳ sau / khi thanh lý'))).toBe(false);
    // Lượt áp trỏ chính hoá đơn nguồn (bút toán bù huỷ lô trùng) không phải đã dùng: lô kia đã quay về ACTIVE ⇒ thu dư
    // còn nguyên; lô kia còn áp ⇒ đúng một phần thừa đã trừ.
    const t8 = detail('T', 'T8');
    expect([table(t8.balances.tenantRows)['Thu dư'], table(t8.balances.tenantRows)['Tiền thừa đã trừ kỳ sau / khi thanh lý']]).toEqual(['2.000 đ', undefined]);
    expect(t8.events.some((e) => e.sub.includes('đã trừ kỳ sau / khi thanh lý'))).toBe(false);
    const t9 = table(detail('T', 'T9').balances.tenantRows);
    expect([t9['Thu dư'], t9['Tiền thừa đã trừ kỳ sau / khi thanh lý']]).toEqual([undefined, '2.000 đ']);
  });

  it('thanh lý kiểu cũ (hoá đơn tổng âm + phiếu hoàn gắn hoá đơn): khoản hoàn chỉ ở mục hoàn, ĐÃ THU không bị trừ', () => {
    const l = detail('L', 'L');
    const m = contractOf('L', 'L').money;
    expect(l.kpis[0].value).toBe(fmtMoney(m.room.paidCash));
    expect(m.room.paidCash).toBe(2_000_000);
    expect(l.events.filter((e) => e.kind === 'ref').map((e) => `${e.title}|${e.amt}`)).toEqual(['Hoàn cọc cho khách|−2.800.000 đ']);
    expect(titles(l).some((x) => x.includes('khi thanh lý – '))).toBe(false);
  });

  it('hoa hồng/thưởng: tiêu đề, trạng thái, chấm rỗng/gạch theo type + meta; "phiếu trùng cũ" theo legacyDup; không vào số tổng', () => {
    const p = S.payloads.K;
    const d = detail('K', 'K');
    const comm = p.events.filter((e) => commissionEventOf(e.type));
    expect(comm).toHaveLength(10);
    for (const e of comm) {
      const cm = commissionEventOf(e.type)!;
      const meta = e.meta as CommissionVoucherMeta;
      expect([meta.kind, meta.stage], e.type).toEqual([cm.kind, cm.stage]);
      const row = d.events.find((r) => r.kind === 'comm' && r.sub.split(' · ')[0] === `Phiếu ${meta.code}`);
      expect(row, meta.code ?? '').toBeDefined();
      const tien = cm.stage === 'PAID' || cm.stage === 'OFFBOOK';
      expect(row, meta.code ?? '').toMatchObject({
        title: COMMISSION_KIND_LABEL[cm.kind], note: STAGE_TEXT[cm.stage], amt: `${tien ? '−' : ''}${fmtMoney(e.amount!)}`,
      });
      expect([row!.hollow ?? false, row!.struck ?? false], meta.code ?? '').toEqual([
        cm.stage === 'PENDING' || cm.stage === 'REVERSED', cm.stage === 'REVERSED',
      ]);
      expect(row!.sub.includes('phiếu trùng cũ'), meta.code ?? '').toBe(meta.legacyDup);
    }
    // Bỏ hết sự kiện hoa hồng thì số tổng, bảng và ô năm y nguyên.
    const bare = { ...p, events: p.events.filter((e) => !commissionEventOf(e.type)) };
    const d0 = detailOf(bare, idOf('K'));
    expect(d0.kpis).toEqual(d.kpis);
    expect(d0.balances).toEqual(d.balances);
    const year = (payload: LifecyclePayload) => buildRoomYear({ payload, year: 2026, todayISO: TODAY, lanes, extras }).kpis;
    expect(year(bare)).toEqual(year(p));
    // Cọc lấy từ lane (chứng từ), không cộng DEPOSIT_RECEIVED của RPC.
    expect(table(d.balances.tenantRows)['Cọc đã đóng (thực thu)']).toBe('2.000.000 đ');
  });

  it('A2: mốc nhận phòng in hạn gốc kèm "gia hạn tới"; HĐ chưa gia hạn giữ dạng cũ', () => {
    expect(rowOf(detail('A', 'A'), 'Ký hợp đồng & nhận phòng').sub).toBe('HD-GIA-A · thời hạn 01/01/2026 → 30/06/2026 · gia hạn tới 31/12/2026');
    expect(rowOf(detail('B', 'B'), 'Ký hợp đồng & nhận phòng').sub).toBe('HD-GIA-B · thời hạn 01/05/2026 → 30/04/2027');
    expect(rowOf(detail('D2', 'D'), 'Chuyển đến phòng này').sub).toBe('HD-GIA-D · thời hạn 01/05/2026 → 30/04/2027');
  });

  it('Σ ĐÃ THU theo năm của thẻ HĐ = money.room.paidCash; ô năm = Σ thẻ; số hoá đơn thẻ = money.room.invoiceCount', () => {
    for (const [room, payload] of Object.entries(S.payloads)) {
      const first = buildRoomYear({ payload, year: 2026, todayISO: TODAY, lanes, extras });
      const paid = new Map<string, number>();
      for (let year = first.minYear; year <= first.maxYear; year++) {
        const v = buildRoomYear({ payload, year, todayISO: TODAY, lanes, extras });
        const cards = v.items.flatMap((i) => (i.type === 'contract' ? [i.card] : [] as ContractCard[]));
        for (const c of cards) {
          paid.set(c.id, (paid.get(c.id) ?? 0) + c.paidYear);
          expect(c.invoiceCount, `${room}/${S.labels[c.id]}`).toBe(contractOf(room, S.labels[c.id]).money.room.invoiceCount);
        }
        expect(v.kpis[2].value, `${room} ${year}`).toBe(fmtMoney(cards.reduce((s, c) => s + c.paidYear, 0)));
      }
      for (const c of payload.contracts) {
        if (!paid.has(c.id)) continue;
        expect(paid.get(c.id), `${room}/${S.labels[c.id]}`).toBe(c.money!.room.paidCash);
      }
    }
  });

  it('cùng ngày khác type: thứ tự dòng theo client, không theo thứ tự type của RPC', () => {
    // RPC xếp DEPOSIT_FORFEIT_POSTED trước TERMINATION_REQUESTED (theo chữ cái) — ngăn kéo vẫn nói thanh lý trước.
    const g = titles(detail('G', 'G'));
    expect(g.indexOf('Khách bỏ cọc · thanh lý HĐ')).toBeLessThan(g.indexOf('Cọc chuyển thành doanh thu'));
    // Đảo thứ tự type trong cùng ngày (giữ thứ tự trong cùng type): mọi ngăn y nguyên.
    for (const [room, label] of STAYS) {
      const p = S.payloads[room];
      const flipped = { ...p, events: [...p.events].sort((a, b) => a.date.localeCompare(b.date) || b.type.localeCompare(a.type)) };
      expect(detailOf(flipped, idOf(label)), `${room}/${label}`).toEqual(detail(room, label));
    }
  });
});
