// Bộ đọc tám RPC "tạm ứng cổ đông + chốt chi lợi nhuận theo tháng". Payload mẫu dựng theo đúng khuôn máy chủ
// (migration 20261118041911) — mọi con số là dữ liệu GIẢ.
import { describe, expect, it } from 'vitest';
import {
  readAdvanceOptions, readAdvancePreview, readAdvanceResult, readMyShareholderPosition, readSettleResult,
  readSettlementPreview, readSettlementVoidResult, readShareholderPositions,
} from '../positionReaders';
import { ProfitLedgerPayloadError } from '../readPrimitives';

const ORG = '00000000-0000-4000-8000-000000000001';
const SH = '00000000-0000-4000-8000-000000000061';
const ACC = '00000000-0000-4000-8000-000000000056';
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Vị thế: được chia 100, đã ứng (đã duyệt) 40, đang chờ duyệt 5 ⇒ chưa chi 100, tạm ứng 40, số dư ròng 55. */
const position = (over: Record<string, unknown> = {}) => ({
  unpaid_profit: 100, advance_outstanding: 40, advance_pending: 5, settlement_cash_pending: 0, balance: 55,
  settled: { cash: 0, offset: 0, recognized: 0 }, last_settled_through_month: null, marker_month: null,
  needs_review: { count: 0, suggested: 0 },
  components: {
    allocated: 100, payouts_pending: 5, payouts_approved: 40, salary_investment: 0, salary_advance_offset: 0,
    unpaid_profit_raw: 100, advance_outstanding_raw: 40, advance_overoffset: 0,
  },
  ...over,
});
const settlement = (over: Record<string, unknown> = {}) => ({
  id: 'st-1', created_at: '2026-11-18T12:31:48.245+07:00', through_month: '2026-10-01', recognized_amount: 100,
  advance_offset_amount: 40, cash_amount: 60, cash_voucher_id: 'v-cash', cash_voucher_code: null,
  cash_voucher_status: 'UNAPPROVED', cash_voucher_posting_status: 'UNPOSTED', excluded_by_marker: false, ...over,
});
const r1Row = (over: Record<string, unknown> = {}) => ({
  shareholder_id: SH, name: 'Cổ đông 1', is_active: true, is_deleted: false, has_login: true, has_advance_right: true,
  ...position(), ...over,
});
const r1 = (over: Record<string, unknown> = {}) => ({
  organization_id: ORG, route: 'CANONICAL', as_of: '2026-11-18T12:31:48.057+07:00', shareholders: [r1Row()], ...over,
});

describe('vị thế — hai con số và bất biến', () => {
  it('R1 đọc đủ từng trường của một cổ đông', () => {
    const got = readShareholderPositions(r1(), ORG);
    expect(got.route).toBe('CANONICAL');
    expect(got.shareholders[0]).toMatchObject({
      shareholder_id: SH, has_advance_right: true, unpaid_profit: 100, advance_outstanding: 40, advance_pending: 5,
      settlement_cash_pending: 0, balance: 55, marker_month: null, last_settled_through_month: null,
      settled: { recognized: 0, offset: 0, cash: 0 }, needs_review: { count: 0, suggested: 0 },
    });
    expect(got.shareholders[0]!.components.advance_overoffset).toBe(0);
  });
  it('lợi nhuận chưa chi ÂM vẫn đọc được (không kẹp về 0)', () => {
    const row = r1Row(position({
      unpaid_profit: -20, advance_outstanding: 0, advance_pending: 0, balance: -20,
      components: { allocated: -20, payouts_pending: 0, payouts_approved: 0, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: -20, advance_outstanding_raw: 0, advance_overoffset: 0 },
    }));
    expect(readShareholderPositions(r1({ shareholders: [row] }), ORG).shareholders[0]!.unpaid_profit).toBe(-20);
  });
  it('luật gấp: tạm ứng thô âm đã gấp vào lợi nhuận chưa chi', () => {
    const row = r1Row(position({
      unpaid_profit: 50, advance_outstanding: 0, advance_pending: 0, balance: 50,
      settled: { cash: 30, offset: 0, recognized: 30 }, last_settled_through_month: '2026-09-01',
      components: { allocated: 80, payouts_pending: 0, payouts_approved: 30, salary_investment: 30, salary_advance_offset: 30, unpaid_profit_raw: 20, advance_outstanding_raw: -30, advance_overoffset: 30 },
    }));
    const got = readShareholderPositions(r1({ shareholders: [row] }), ORG).shareholders[0]!;
    expect(got).toMatchObject({ unpaid_profit: 50, advance_outstanding: 0, last_settled_through_month: '2026-09-01' });
    expect(got.components.advance_overoffset).toBe(30);
  });
  it.each([
    ['hai con số không cộng ra số dư ròng', { balance: 60 }],
    ['tạm ứng đang có âm', { advance_outstanding: -1, balance: 96 }],
    ['thiếu lợi nhuận chưa chi', { unpaid_profit: null }],
    ['thiếu khối components', { components: undefined }],
    ['số trả ra lệch số thô + phần gấp', { components: { ...position().components, unpaid_profit_raw: 90 } }],
    ['tháng mốc không phải ngày 1', { marker_month: '2026-09-15' }],
  ])('%s ⇒ payload hỏng, không hiện số', (_name, over) => {
    expect(() => readShareholderPositions(r1({ shareholders: [r1Row(over)] }), ORG)).toThrow(ProfitLedgerPayloadError);
  });
  it('R1: sai công ty, trùng cổ đông, thiếu cờ quyền tạm ứng ⇒ lỗi', () => {
    expect(() => readShareholderPositions(r1(), 'org-khac')).toThrow(ProfitLedgerPayloadError);
    expect(() => readShareholderPositions(r1({ shareholders: [r1Row(), r1Row()] }), ORG)).toThrow(ProfitLedgerPayloadError);
    const noRight = clone(r1Row()) as Record<string, unknown>;
    delete noRight.has_advance_right;
    expect(() => readShareholderPositions(r1({ shareholders: [noRight] }), ORG)).toThrow(ProfitLedgerPayloadError);
  });
});

describe('R2 — cổ đông tự xem', () => {
  const r2 = (over: Record<string, unknown> = {}) => ({
    organization_id: ORG, route: 'CANONICAL', shareholder: { id: SH, name: 'Cổ đông 1' },
    ...position({ unpaid_profit: 0, advance_outstanding: 0, advance_pending: 5, settlement_cash_pending: 60, balance: -5,
      settled: { cash: 60, offset: 40, recognized: 100 }, last_settled_through_month: '2026-10-01',
      components: { allocated: 100, payouts_pending: 65, payouts_approved: 40, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: 0, advance_outstanding_raw: 0, advance_overoffset: 0 } }),
    settlements: [settlement()], ...over,
  });
  it('đọc vị thế + các lần chốt', () => {
    const got = readMyShareholderPosition(r2(), ORG);
    expect(got).toMatchObject({ shareholder: { id: SH, name: 'Cổ đông 1' }, unpaid_profit: 0, advance_pending: 5, settlement_cash_pending: 60 });
    expect(got.settlements).toEqual([expect.objectContaining({ id: 'st-1', through_month: '2026-10-01', recognized_amount: 100, advance_offset_amount: 40, cash_amount: 60, cash_voucher_id: 'v-cash' })]);
  });
  it('đọc phần quỹ và ứng đầu kỳ của chính cổ đông, từ chối dữ liệu quỹ thiếu trường', () => {
    const components = { ...r2().components, shared_fund_payable: 60, shared_fund_offset: 40, opening_advance: 90 };
    expect(readMyShareholderPosition(r2({ components }), ORG).components).toMatchObject({
      shared_fund_payable: 60, shared_fund_offset: 40, opening_advance: 90,
    });
    expect(() => readMyShareholderPosition(r2({ components: { ...components, shared_fund_offset: null } }), ORG)).toThrow(ProfitLedgerPayloadError);
  });
  it('lần chốt không ra tiền: không có phiếu', () => {
    const got = readMyShareholderPosition(r2({ settlements: [settlement({ recognized_amount: 80, advance_offset_amount: 80, cash_amount: 0, cash_voucher_id: null, cash_voucher_status: null, cash_voucher_posting_status: null })] }), ORG);
    expect(got.settlements[0]).toMatchObject({ cash_amount: 0, cash_voucher_id: null });
  });
  it.each([
    ['khấu trừ + tiền khác phần ghi nhận', { cash_amount: 50 }],
    ['có tiền mà không có phiếu', { cash_voucher_id: null }],
    ['không tiền mà có phiếu', { recognized_amount: 40, cash_amount: 0 }],
    ['tháng chốt sai dạng', { through_month: '2026-10' }],
  ])('bản ghi chốt %s ⇒ lỗi', (_name, over) => {
    expect(() => readMyShareholderPosition(r2({ settlements: [settlement(over)] }), ORG)).toThrow(ProfitLedgerPayloadError);
  });
  it('trùng bản ghi chốt, thiếu danh sách ⇒ lỗi', () => {
    expect(() => readMyShareholderPosition(r2({ settlements: [settlement(), settlement()] }), ORG)).toThrow(ProfitLedgerPayloadError);
    expect(() => readMyShareholderPosition(r2({ settlements: null }), ORG)).toThrow(ProfitLedgerPayloadError);
  });
});

describe('R3 — lựa chọn cho form Thu chi', () => {
  const r3 = (over: Record<string, unknown> = {}) => ({
    route: 'CANONICAL', can_create: true,
    accounts: [{ name: 'Sổ người giữ', account_id: ACC }],
    payees: [{ name: 'Cổ đông 1', is_self: false, shareholder_id: SH }],
    advance_type: { id: 'type-tam-ung', name: 'Tạm Ứng' }, ...over,
  });
  it('đọc sổ, người nhận, hạng mục — không có số tiền nào', () => {
    const got = readAdvanceOptions(r3());
    expect(got).toEqual({
      route: 'CANONICAL', can_create: true,
      accounts: [{ account_id: ACC, name: 'Sổ người giữ' }],
      payees: [{ shareholder_id: SH, name: 'Cổ đông 1', is_self: false }],
      advance_type: { id: 'type-tam-ung', name: 'Tạm Ứng' },
    });
  });
  it('không giữ sổ nào ⇒ không lập được; hạng mục chưa có ⇒ null', () => {
    expect(readAdvanceOptions(r3({ accounts: [], payees: [], can_create: false, advance_type: null }))).toMatchObject({ can_create: false, advance_type: null });
  });
  it.each([
    ['cờ nói được nhưng không có sổ', { accounts: [] }],
    ['cờ nói được nhưng không có người nhận', { payees: [] }],
    ['cờ nói được nhưng sổ tổng chưa chạy thật', { route: 'SHADOW' }],
    ['route lạ', { route: 'CANARY' }],
  ])('đóng an toàn: %s ⇒ can_create = false', (_name, over) => {
    expect(readAdvanceOptions(r3(over)).can_create).toBe(false);
  });
  it('thiếu cờ / trùng sổ ⇒ lỗi', () => {
    expect(() => readAdvanceOptions(r3({ can_create: undefined }))).toThrow(ProfitLedgerPayloadError);
    expect(() => readAdvanceOptions(r3({ accounts: [{ name: 'A', account_id: ACC }, { name: 'B', account_id: ACC }] }))).toThrow(ProfitLedgerPayloadError);
  });
});

describe('R4 — xem trước phiếu tạm ứng', () => {
  const request = { shareholderId: SH, amount: 500, accountId: ACC };
  const forPayee = (over: Record<string, unknown> = {}) => ({
    route: 'CANONICAL', shareholder_id: SH, maker_kind: 'CUSTODIAN_FOR_PAYEE', payee_is_maker: false, can_submit: true,
    blocked_reason: null, position: null,
    warnings: [{ code: 'ADVANCE', advance_amount: 500 }, { code: 'NEEDS_OWNER_APPROVAL' }], ...over,
  });
  const selfPosition = (amount: number | null) => ({
    ...position({ advance_outstanding: 0, advance_pending: 0, balance: 100, components: { ...position().components, payouts_pending: 0, payouts_approved: 0, advance_outstanding_raw: 0 } }),
    after_advance: amount === null ? null : { balance: 100 - amount, advance_pending: amount },
  });
  it('người giữ sổ lập hộ: KHÔNG có số của cổ đông', () => {
    const got = readAdvancePreview(forPayee(), request);
    expect(got).toMatchObject({ maker_kind: 'CUSTODIAN_FOR_PAYEE', payee_is_maker: false, can_submit: true, blocked_reason: null, position: null });
    expect(got.warnings.map((w) => w.code)).toEqual(['ADVANCE', 'NEEDS_OWNER_APPROVAL']);
  });
  it('chính người nhận: có vị thế và số sau khi ứng', () => {
    const got = readAdvancePreview(forPayee({ maker_kind: 'CUSTODIAN_ADVANCE', payee_is_maker: true, position: selfPosition(500) }), request);
    expect(got.position).toMatchObject({ unpaid_profit: 100, advance_outstanding: 0, after_advance: { balance: -400, advance_pending: 500 } });
  });
  it('chưa nhập số tiền: không có số sau khi ứng, không cho gửi dù cờ nói được', () => {
    const got = readAdvancePreview(forPayee({ maker_kind: 'CUSTODIAN_ADVANCE', payee_is_maker: true, position: selfPosition(null), warnings: [] }), { ...request, amount: null });
    expect(got.position?.after_advance).toBeNull();
    expect(got.can_submit).toBe(false);
  });
  it.each(['ROUTE', 'NOT_CUSTODIAN', 'PAYEE_NO_RIGHT', 'SALARY_REVIEW_PENDING'])('lý do khoá %s ⇒ không cho gửi kể cả khi cờ lệch', (reason) => {
    expect(readAdvancePreview(forPayee({ blocked_reason: reason }), request)).toMatchObject({ can_submit: false, blocked_reason: reason });
  });
  it('lý do khoá chưa biết ⇒ OTHER, vẫn khoá', () => {
    expect(readAdvancePreview(forPayee({ blocked_reason: 'LY_DO_MOI' }), request)).toMatchObject({ can_submit: false, blocked_reason: 'OTHER' });
  });
  it.each([
    ['cổ đông khác', { shareholder_id: 'sh-khac' }],
    ['cách lập không khớp người nhận', { maker_kind: 'CUSTODIAN_ADVANCE' }],
    ['cách lập của lệnh chi cũ', { maker_kind: 'OWNER' }],
    ['số sau khi ứng không cộng đúng số tiền', { maker_kind: 'CUSTODIAN_ADVANCE', payee_is_maker: true, position: { ...selfPosition(500), after_advance: { balance: -400, advance_pending: 400 } } }],
    ['có số tiền mà thiếu số sau khi ứng', { maker_kind: 'CUSTODIAN_ADVANCE', payee_is_maker: true, position: selfPosition(null) }],
  ])('%s ⇒ lỗi', (_name, over) => {
    expect(() => readAdvancePreview(forPayee(over), request)).toThrow(ProfitLedgerPayloadError);
  });
});

describe('W1 — biên nhận lập phiếu tạm ứng', () => {
  const w1 = (over: Record<string, unknown> = {}) => ({
    state: 'PENDING_APPROVAL', amount: 10, within_amount: 0, advance_amount: 10, balance_before: null,
    maker_kind: 'CUSTODIAN_FOR_PAYEE', payout_kind: 'ADVANCE',
    warnings: [{ code: 'ADVANCE', advance_amount: 10 }, { code: 'NEEDS_OWNER_APPROVAL' }],
    voucher_id: 'v-1', approval_request_id: 'r-1', shareholder_id: SH, ...over,
  });
  it('lập hộ: số dư trước là null (không phải 0)', () => {
    expect(readAdvanceResult(w1(), { shareholderId: SH, amount: 10 })).toMatchObject({ voucher_id: 'v-1', advance_amount: 10, within_amount: 0, balance_before: null, maker_kind: 'CUSTODIAN_FOR_PAYEE' });
  });
  it('tự tạm ứng: có số dư trước và cảnh báo vượt ước tính', () => {
    const got = readAdvanceResult(w1({ maker_kind: 'CUSTODIAN_ADVANCE', balance_before: 80, warnings: [{ code: 'ADVANCE_EXCEEDS_ESTIMATE', open_estimate: 0, outstanding_advance: 20 }] }), { shareholderId: SH, amount: 10 });
    expect(got.balance_before).toBe(80);
    expect(got.warnings[0]).toEqual({ code: 'ADVANCE_EXCEEDS_ESTIMATE', open_estimate: 0, outstanding_advance: 20 });
  });
  it.each([
    ['số tiền khác số đã gửi', { amount: 11, advance_amount: 11 }],
    ['có phần "trong số dư" (mọi khoản ứng đều là tạm ứng)', { within_amount: 4, advance_amount: 6 }],
    ['thiếu khoá số dư trước', { balance_before: undefined }],
    ['thiếu phiếu', { voucher_id: null }],
    ['loại khác tạm ứng', { payout_kind: 'SETTLEMENT' }],
    ['cách lập của chủ', { maker_kind: 'OWNER' }],
    ['cổ đông khác', { shareholder_id: 'sh-khac' }],
  ])('%s ⇒ biên nhận hỏng', (_name, over) => {
    expect(() => readAdvanceResult(w1(over), { shareholderId: SH, amount: 10 })).toThrow(ProfitLedgerPayloadError);
  });
});

describe('R5 — xem trước chốt', () => {
  const request = { shareholderId: SH, throughMonth: null, accountId: null };
  const r5 = (over: Record<string, unknown> = {}) => ({
    route: 'CANONICAL', shareholder_id: SH,
    months: [
      { month: '2026-09-01', allocated: 60, selectable: true, unpaid_through: 60 },
      { month: '2026-10-01', allocated: 40, selectable: true, unpaid_through: 100 },
    ],
    min_through_month: '2026-09-01', through_month: '2026-10-01',
    recognized_amount: 100, advance_offset_amount: 40, cash_amount: 60, advance_left: 0, advance_pending: 5,
    can_submit: false, blocked_reason: 'ACCOUNT_REQUIRED', settlements: [], position: position(), ...over,
  });
  it('mặc định tháng máy chủ trả: ba con số + tạm ứng chờ duyệt', () => {
    const got = readSettlementPreview(r5(), request);
    expect(got).toMatchObject({
      through_month: '2026-10-01', min_through_month: '2026-09-01', recognized_amount: 100, advance_offset_amount: 40,
      cash_amount: 60, advance_left: 0, advance_pending: 5, can_submit: false, blocked_reason: 'ACCOUNT_REQUIRED',
    });
    expect(got.months.map((m) => [m.month, m.selectable])).toEqual([['2026-09-01', true], ['2026-10-01', true]]);
  });
  it('đã chọn sổ ⇒ gửi được', () => {
    expect(readSettlementPreview(r5({ can_submit: true, blocked_reason: null }), { ...request, accountId: ACC }).can_submit).toBe(true);
  });
  it('tháng cuối lỗ: không còn gì để chốt, ba con số tiền là null (KHÔNG phải 0), tháng sớm hơn vẫn chọn được', () => {
    const got = readSettlementPreview(r5({
      months: [
        { month: '2026-09-01', allocated: 100, selectable: true, unpaid_through: 100 },
        { month: '2026-10-01', allocated: -120, selectable: false, unpaid_through: -20 },
      ],
      recognized_amount: -20, advance_offset_amount: null, cash_amount: null, advance_left: null, advance_pending: 0,
      blocked_reason: 'NOTHING_TO_SETTLE',
      position: position({ unpaid_profit: -20, advance_outstanding: 0, advance_pending: 0, balance: -20, components: { allocated: -20, payouts_pending: 0, payouts_approved: 0, salary_investment: 0, salary_advance_offset: 0, unpaid_profit_raw: -20, advance_outstanding_raw: 0, advance_overoffset: 0 } }),
    }), request);
    expect(got).toMatchObject({ recognized_amount: -20, advance_offset_amount: null, cash_amount: null, advance_left: null, can_submit: false, blocked_reason: 'NOTHING_TO_SETTLE', min_through_month: '2026-09-01' });
  });
  it('không còn tháng đủ điều kiện: tháng null, không có số', () => {
    const got = readSettlementPreview(r5({ months: [], min_through_month: null, through_month: null, recognized_amount: null, advance_offset_amount: null, cash_amount: null, advance_left: null, blocked_reason: 'NOTHING_TO_SETTLE' }), request);
    expect(got).toMatchObject({ through_month: null, recognized_amount: null, cash_amount: null, can_submit: false });
  });
  it('chọn tháng cụ thể: máy chủ phải dội lại đúng tháng đó', () => {
    const picked = r5({ through_month: '2026-09-01', recognized_amount: 60, advance_offset_amount: 40, cash_amount: 20, advance_left: 0 });
    expect(readSettlementPreview(picked, { ...request, throughMonth: '2026-09-01' }).cash_amount).toBe(20);
    expect(() => readSettlementPreview(r5(), { ...request, throughMonth: '2026-09-01' })).toThrow(ProfitLedgerPayloadError);
  });
  it.each([
    ['khấu trừ + thực chi khác phần ghi nhận', { cash_amount: 50 }],
    ['phần ghi nhận khác luỹ kế của tháng', { recognized_amount: 90, cash_amount: 50 }],
    ['tạm ứng còn lại không khớp', { advance_left: 7 }],
    ['thiếu thực chi khi có gì để chốt', { cash_amount: null }],
    ['tháng xem trước không có trong danh sách', { through_month: '2026-11-01' }],
    ['tạm ứng chờ duyệt khác vị thế', { advance_pending: 0 }],
    ['tháng chọn được mà luỹ kế ≤ 0', { months: [{ month: '2026-09-01', allocated: 60, selectable: true, unpaid_through: 0 }, { month: '2026-10-01', allocated: 40, selectable: true, unpaid_through: 100 }] }],
    ['cổ đông khác', { shareholder_id: 'sh-khac' }],
  ])('%s ⇒ lỗi', (_name, over) => {
    expect(() => readSettlementPreview(r5(over), request)).toThrow(ProfitLedgerPayloadError);
  });
  it('cờ nói gửi được nhưng còn lý do khoá ⇒ không cho gửi', () => {
    expect(readSettlementPreview(r5({ can_submit: true, blocked_reason: 'SALARY_REVIEW_PENDING' }), request).can_submit).toBe(false);
    expect(readSettlementPreview(r5({ can_submit: true, blocked_reason: 'LY_DO_MOI' }), request)).toMatchObject({ can_submit: false, blocked_reason: 'OTHER' });
  });
});

describe('W2 / W3 — biên nhận chốt và huỷ chốt', () => {
  const w2 = (over: Record<string, unknown> = {}) => ({
    state: 'PENDING_APPROVAL', settlement_id: 'st-1', through_month: '2026-10-01', recognized_amount: 100,
    advance_offset_amount: 40, cash_amount: 60, voucher_id: 'v-cash', approval_request_id: 'r-1', ...over,
  });
  it('có tiền: phiếu chờ duyệt', () => {
    expect(readSettleResult(w2(), { throughMonth: '2026-10-01' })).toMatchObject({ state: 'PENDING_APPROVAL', voucher_id: 'v-cash', cash_amount: 60, advance_offset_amount: 40 });
  });
  it('không tiền: có hiệu lực ngay, không phiếu', () => {
    const got = readSettleResult(w2({ state: 'SETTLED', through_month: '2026-09-01', recognized_amount: 80, advance_offset_amount: 80, cash_amount: 0, voucher_id: null, approval_request_id: null }), { throughMonth: '2026-09-01' });
    expect(got).toMatchObject({ state: 'SETTLED', voucher_id: null, approval_request_id: null, cash_amount: 0 });
  });
  it.each([
    ['tháng khác tháng đã gửi', { through_month: '2026-09-01' }],
    ['có tiền mà không có phiếu', { voucher_id: null }],
    ['có tiền mà báo đã chốt xong', { state: 'SETTLED' }],
    ['không tiền mà có phiếu', { recognized_amount: 40, cash_amount: 0 }],
    ['khấu trừ + tiền khác phần ghi nhận', { advance_offset_amount: 30 }],
    ['phần ghi nhận ≤ 0', { recognized_amount: 0, advance_offset_amount: 0, cash_amount: 0, voucher_id: null, state: 'SETTLED' }],
    ['thiếu mã bản ghi chốt', { settlement_id: null }],
  ])('%s ⇒ biên nhận hỏng', (_name, over) => {
    expect(() => readSettleResult(w2(over), { throughMonth: '2026-10-01' })).toThrow(ProfitLedgerPayloadError);
  });
  it('W3: đúng bản ghi, trạng thái VOID', () => {
    expect(readSettlementVoidResult({ state: 'VOID', settlement_id: 'st-1' }, 'st-1')).toEqual({ settlement_id: 'st-1', state: 'VOID' });
    expect(() => readSettlementVoidResult({ state: 'VOID', settlement_id: 'st-2' }, 'st-1')).toThrow(ProfitLedgerPayloadError);
    expect(() => readSettlementVoidResult({ state: 'ACTIVE', settlement_id: 'st-1' }, 'st-1')).toThrow(ProfitLedgerPayloadError);
  });
});
