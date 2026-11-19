// @vitest-environment jsdom
// D2.10 — chốt / trả lương với phần lợi nhuận của sổ tổng: E13 trước MỌI nhánh chốt, E15 ngay trước
// MỌI nhánh trả với ĐÚNG khoá của salary_payout_v1; lỗi ⇒ không chốt / không lập phiếu; nhân viên
// thường giữ y đường cũ. Số liệu là số mẫu.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  rpcMock: vi.fn(), calls: [] as [string, Record<string, unknown>][], responses: [] as { data: unknown; error: unknown }[],
  qc: { invalidateQueries: vi.fn() },
}));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useRef: (current: unknown) => ({ current }) }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQueryClient: () => h.qc }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor', email: 'demo' }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  rpc: (name: string, args: Record<string, unknown>) => { h.calls.push([name, args]); return h.rpcMock(name, args); },
  from: () => {
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit', 'single', 'maybeSingle']) builder[method] = () => builder;
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(h.responses.shift() ?? { data: null, error: null }).then(resolve);
    return builder;
  },
} }));
import { useLockSalaryMonth, useSalaryPayout, type SalaryPayoutInput } from '../useManagerSalary';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { financialPending } from '@/lib/financialPending';
import { salCalc, type SalManager } from '@/lib/managerSalary';
import type { SalaryProfitStaff } from '@/lib/profitLedger/salaryReaders';
import { SalaryProfitStopError, salaryProfitQuoteFor, withSalaryProfit } from '@/lib/salaryProfit';

type Args = Record<string, unknown>;
const mutation = (options: unknown) => (options as { mutationFn: (input: unknown) => Promise<unknown> }).mutationFn;
const names = () => h.calls.map(([name]) => name);
const argsOf = (name: string, nth = 0) => h.calls.filter(([n]) => n === name)[nth]?.[1] as Args;
const STAFF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PERIOD = '2026-10-01';
const receiptRow = { data: { code: 'PC1', approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED' }, error: null };

const quoteReceipt = (args: Args, over: Args = {}) => ({
  quote_id: 'q-1', shareholder_id: 'sh-1', staff_id: args.p_staff_id, period_month: args.p_period_month, organization_id: 'org-1',
  investment_amount: args.p_investment_selected, advance_offset_amount: args.p_offset_selected, investment_month: 3_000_000,
  advance_offset_month: 1_200_000, paid_investment: 0, paid_offset: 0, settled_by_marker: false, sheet_status: 'DRAFT',
  expected_voucher_amount: args.p_expected_voucher_amount, payout_request_key: args.p_payout_idempotency_key,
  expires_at: '2026-11-05T00:30:00Z', voided_quote_ids: [], offset_conflict: false, needs_review_reason: null, ...over,
});
const freezeReceipt = (args: Args, over: Args = {}) => ({
  already_locked: false, settlement_id: 'c3', voided_settlement_id: null, shareholder_id: 'sh-1', staff_id: args.p_staff_id,
  period_month: args.p_period_month, organization_id: 'org-1', investment_month: args.p_expected_investment,
  advance_offset_month: args.p_max_offset, paid_investment: 0, paid_offset: 0, unpaid_investment: args.p_expected_investment,
  settled_by_marker: false, ...over,
});

function profitStaff(over: Partial<SalaryProfitStaff> = {}): SalaryProfitStaff {
  return {
    staff_id: STAFF, organization_id: 'org-1', shareholder_id: 'sh-1', sheet_status: 'DRAFT', profit_draft: false,
    allocations: [{ building_id: 'b1', building_label: 'T1', amount: 3_000_000, status: 'LOCKED', is_stale: false }],
    by_building: [], allocated_total: 3_000_000, investment_month: 3_000_000, investment_cap: 3_000_000,
    marker_through: null, settled_by_marker: false, settlement: null, paid_lines: [], paid_investment: 0, paid_offset: 0,
    advance_open: 5_000_000, advance_offset_month: 1_200_000, suggested_advance_offset: 1_200_000, remaining_offset: 1_200_000,
    offset_conflict: false, needs_review: { count: 0, suggested: 0 }, ...over,
  };
}
function manager(over: Partial<SalManager> = {}, profit: SalaryProfitStaff | null = profitStaff()): SalManager {
  const base: SalManager = {
    id: STAFF, name: 'Nhân viên A', short: 'A', alias: '', role: 'Quản lý', initials: 'A', tone: 'primary', workdays: 20,
    base: 5_000_000, roomRent: 1_000_000, incomeGoal: 0, bonusAuto: [], adjustments: [],
    investment: 3_000_000, investmentBy: [{ b: 'T1', amount: 3_000_000 }], investmentLocked: true,
    commission: 0, commissionItems: [], commissionFlagged: [],
    advance: 500_000, advanceItems: [{ date: '05/10', label: 'Ứng lương', amount: 500_000 }], roomRentItems: [], roomRentInvoice: null,
    paid: 0, stats: { jobs: 0, repairs: 0, afterHour: 0, workdays: 20, streak: 0 }, trend: [], status: 'DRAFT',
    salaryMonthlyId: null, ledger: [], ...over,
  };
  const m = withSalaryProfit(base, profit);
  m.calc = salCalc(m);
  return m;
}
const payout = (over: Partial<SalaryPayoutInput> = {}): SalaryPayoutInput => ({
  ownerId: 'owner', staffId: STAFF, staffName: 'Nhân viên A', periodMonth: PERIOD, amount: 4_000_000,
  account_id: 'account', voucher_date: '2026-11-05', note: null, rentInvoice: null,
  profitQuote: { investmentSelected: 3_000_000, offsetSelected: 1_200_000 }, ...over,
});
const payoutScope = { namespace: 'salary-payout', userId: 'actor', organizationId: 'actor-scope', businessKey: `${STAFF}-${PERIOD}` };

beforeEach(() => { localStorage.clear(); h.rpcMock.mockReset(); h.calls = []; h.responses = []; h.qc.invalidateQueries.mockReset(); });

describe('trả lương — báo giá phần lợi nhuận (E15) trước khi lập phiếu', () => {
  it('cổ đông: E15 NGAY TRƯỚC salary_payout_v1, cùng khoá trả lương, số luỹ kế và tổng phiếu gồm tiền phòng kẹp theo nợ còn', async () => {
    h.rpcMock.mockImplementation(async (name: string, args: Args) => {
      if (name === 'salary_profit_payout_quote_v1') return { data: quoteReceipt(args), error: null };
      if (name === 'salary_payout_v1') return { data: { salary_voucher_id: 'voucher' }, error: null };
      throw new Error('unexpected ' + name);
    });
    h.responses = [receiptRow];
    const input = payout({ rentInvoice: { invoiceId: 'inv', roomId: null, buildingId: null, contractId: null, amount: 1_000_000, remaining: 600_000 } });
    await expect(mutation(useSalaryPayout())(input)).resolves.toMatchObject({ id: 'voucher' });
    expect(names()).toEqual(['salary_profit_payout_quote_v1', 'salary_payout_v1']);
    const quote = argsOf('salary_profit_payout_quote_v1');
    const pay = argsOf('salary_payout_v1');
    expect(quote.p_payout_idempotency_key).toBe(pay.p_idempotency_key);
    expect(quote.p_idempotency_key).not.toBe(pay.p_idempotency_key);
    expect(quote).toMatchObject({ p_staff_id: STAFF, p_period_month: PERIOD, p_investment_selected: 3_000_000, p_offset_selected: 1_200_000, p_expected_voucher_amount: 4_600_000 });
    expect(pay).toMatchObject({ p_take_home: 4_000_000, p_rent_amount: 1_000_000 });
  });

  it('E15 từ chối (số vừa đổi) ⇒ KHÔNG lập phiếu, báo tải lại; lần sau dùng khoá trả lương MỚI và khoá báo giá mới', async () => {
    let quotes = 0;
    h.rpcMock.mockImplementation(async (name: string, args: Args) => {
      if (name === 'salary_profit_payout_quote_v1') {
        quotes += 1;
        return quotes === 1 ? { data: null, error: { code: 'PT409', message: 'SALARY_PROFIT_QUOTE_CHANGED: changed', details: null } } : { data: quoteReceipt(args), error: null };
      }
      if (name === 'salary_payout_v1') return { data: { salary_voucher_id: 'voucher' }, error: null };
      throw new Error('unexpected ' + name);
    });
    const hook = useSalaryPayout();
    const error = await mutation(hook)(payout()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SalaryProfitStopError);
    expect(error).toMatchObject({ outcome: 'failure', reload: true, completed: [] });
    expect((error as Error).message).toMatch(/vừa đổi/);
    expect(names()).toEqual(['salary_profit_payout_quote_v1']);
    expect(financialPending.read(payoutScope)).toBeNull();
    (hook as unknown as { onError: (e: unknown) => void }).onError(error);
    expect(h.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['manager-salary'] });

    h.responses = [receiptRow];
    await expect(mutation(useSalaryPayout())(payout())).resolves.toMatchObject({ id: 'voucher' });
    const first = argsOf('salary_profit_payout_quote_v1', 0);
    const second = argsOf('salary_profit_payout_quote_v1', 1);
    expect(second.p_payout_idempotency_key).not.toBe(first.p_payout_idempotency_key);
    expect(second.p_idempotency_key).not.toBe(first.p_idempotency_key);
    expect(argsOf('salary_payout_v1').p_idempotency_key).toBe(second.p_payout_idempotency_key);
  });

  it.each(['OFFSET_CONFLICT', 'MIXED_SIGN_SELECTION'])('E15 báo trước "%s" ⇒ dừng, không lập phiếu', async (reason) => {
    h.rpcMock.mockImplementation(async (name: string, args: Args) => {
      if (name === 'salary_profit_payout_quote_v1') return { data: quoteReceipt(args, { needs_review_reason: reason }), error: null };
      throw new Error('unexpected ' + name);
    });
    await expect(mutation(useSalaryPayout())(payout())).rejects.toBeInstanceOf(SalaryProfitStopError);
    expect(names()).toEqual(['salary_profit_payout_quote_v1']);
  });

  it('báo giá gắn khoá khác khoá trả lương ⇒ không lập phiếu', async () => {
    h.rpcMock.mockImplementation(async (name: string, args: Args) => {
      if (name === 'salary_profit_payout_quote_v1') return { data: quoteReceipt(args, { payout_request_key: 'khoa-khac-hoan-toan' }), error: null };
      throw new Error('unexpected ' + name);
    });
    await expect(mutation(useSalaryPayout())(payout())).rejects.toBeInstanceOf(FinancialWorkflowError);
    expect(names()).toEqual(['salary_profit_payout_quote_v1']);
  });

  it('nhánh lùi legacy cũng đi SAU báo giá', async () => {
    h.rpcMock.mockImplementation(async (name: string, args: Args) => {
      if (name === 'salary_profit_payout_quote_v1') return { data: quoteReceipt(args), error: null };
      if (name === 'salary_payout_v1') return { data: null, error: { code: '55000', message: 'Writer chưa bật' } };
      if (name === 'rent_support_salary_bridge_required_v1') return { data: false, error: null };
      throw new Error('unexpected ' + name);
    });
    h.responses = [{ data: null, error: { code: '42501', message: 'denied' } }];
    await expect(mutation(useSalaryPayout())(payout())).rejects.toBeTruthy();
    expect(names()).toEqual(['salary_profit_payout_quote_v1', 'salary_payout_v1', 'rent_support_salary_bridge_required_v1']);
  });

  it.each([undefined, null])('hồi quy — nhân viên thường (profitQuote %s): không báo giá, gọi salary_payout_v1 như cũ', async (profitQuote) => {
    h.rpcMock.mockImplementation(async (name: string) => {
      if (name === 'salary_payout_v1') return { data: { salary_voucher_id: 'voucher' }, error: null };
      throw new Error('unexpected ' + name);
    });
    h.responses = [receiptRow];
    await expect(mutation(useSalaryPayout())(payout({ profitQuote }))).resolves.toMatchObject({ id: 'voucher' });
    expect(names()).toEqual(['salary_payout_v1']);
  });
});

describe('chốt lương — đóng băng phần lợi nhuận (E13) trước khi chốt', () => {
  const shareholder = manager();
  const employee = manager({ id: OTHER, name: 'Nhân viên B', investment: 0, investmentBy: [] }, null);
  const lockedShareholder = manager({ id: '33333333-3333-4333-8333-333333333333', status: 'LOCKED' });
  const lockArgs = { ownerId: 'owner', periodMonth: PERIOD, managers: [shareholder, employee, lockedShareholder] };

  it('cổ đông bảng nháp: E13 TRƯỚC lock_salary_month_v2; thực nhận / đầu tư / ứng gửi chốt khớp đúng số đóng băng', async () => {
    h.rpcMock.mockImplementation(async (name: string, args: Args) => {
      if (name === 'salary_profit_settlement_freeze_v1') return { data: freezeReceipt(args), error: null };
      if (name === 'lock_salary_month_v2') return { data: { state: 'LOCKED', period_month: PERIOD, locked_count: 2 }, error: null };
      throw new Error('unexpected ' + name);
    });
    await expect(mutation(useLockSalaryMonth())(lockArgs)).resolves.toEqual({ count: 2 });
    expect(names()).toEqual(['salary_profit_settlement_freeze_v1', 'lock_salary_month_v2']);
    const freeze = argsOf('salary_profit_settlement_freeze_v1');
    const lock = argsOf('lock_salary_month_v2');
    const row = (lock.p_managers as Args[]).find((r) => r.staff_id === STAFF)!;
    expect(freeze).toMatchObject({ p_staff_id: STAFF, p_period_month: PERIOD, p_max_offset: 1_200_000 });
    expect(freeze.p_expected_take_home).toBe(row.take_home);
    expect(freeze.p_expected_investment).toBe(row.investment_profit);
    expect(row.advances_total).toBe(500_000 + 1_200_000);
    expect(row.take_home).toBe(5_000_000 + 3_000_000 - 1_700_000 - 1_000_000);
    expect(String(freeze.p_idempotency_key)).toContain(String(lock.p_idempotency_key));
    const plain = (lock.p_managers as Args[]).find((r) => r.staff_id === OTHER)!;
    expect(plain.advances_total).toBe(500_000);
  });

  it('E13 từ chối ⇒ KHÔNG chốt, từ chối chắc chắn, tải lại bảng lương', async () => {
    h.rpcMock.mockImplementation(async (name: string) => {
      if (name === 'salary_profit_settlement_freeze_v1') return { data: null, error: { code: 'PT409', message: 'SALARY_PROFIT_QUOTE_CHANGED: changed', details: null } };
      throw new Error('unexpected ' + name);
    });
    const hook = useLockSalaryMonth();
    const error = await mutation(hook)(lockArgs).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ outcome: 'failure', reload: true });
    expect(names()).toEqual(['salary_profit_settlement_freeze_v1']);
    (hook as unknown as { onError: (e: unknown) => void }).onError(error);
    expect(h.qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['manager-salary'] });
  });

  it.each([
    ['trừ tạm ứng khác', { advance_offset_month: 900_000 }],
    ['vừa vào mốc đã trả đủ', { settled_by_marker: true }],
    ['đã chốt ở nơi khác', { already_locked: true, offset_conflict: false }],
  ])('đóng băng lệch số đang chốt (%s) ⇒ KHÔNG chốt', async (_label, over) => {
    h.rpcMock.mockImplementation(async (name: string, args: Args) => {
      if (name === 'salary_profit_settlement_freeze_v1') return { data: freezeReceipt(args, over), error: null };
      throw new Error('unexpected ' + name);
    });
    await expect(mutation(useLockSalaryMonth())(lockArgs)).rejects.toBeInstanceOf(SalaryProfitStopError);
    expect(names()).toEqual(['salary_profit_settlement_freeze_v1']);
  });

  it('nhánh lùi legacy cũng đi SAU đóng băng', async () => {
    h.rpcMock.mockImplementation(async (name: string, args: Args) => {
      if (name === 'salary_profit_settlement_freeze_v1') return { data: freezeReceipt(args), error: null };
      if (name === 'lock_salary_month_v2') return { data: null, error: { code: '55000', message: 'Writer chưa bật' } };
      if (name === 'rent_support_salary_bridge_required_v1') return { data: true, error: null };
      throw new Error('unexpected ' + name);
    });
    await expect(mutation(useLockSalaryMonth())(lockArgs)).rejects.toBeTruthy();
    expect(names()).toEqual(['salary_profit_settlement_freeze_v1', 'lock_salary_month_v2', 'rent_support_salary_bridge_required_v1']);
  });

  it('hồi quy — chỉ nhân viên thường: không đóng băng, chốt như cũ', async () => {
    h.rpcMock.mockImplementation(async (name: string) => {
      if (name === 'lock_salary_month_v2') return { data: { state: 'LOCKED', period_month: PERIOD, locked_count: 1 }, error: null };
      throw new Error('unexpected ' + name);
    });
    await expect(mutation(useLockSalaryMonth())({ ownerId: 'owner', periodMonth: PERIOD, managers: [employee] })).resolves.toEqual({ count: 1 });
    expect(names()).toEqual(['lock_salary_month_v2']);
  });
});

describe('màn bảng lương nối phần lợi nhuận vào mọi lối trả', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/pages/finance/ManagerSalaryPage.tsx'), 'utf8');
  it('trả từng người và trả hàng loạt đều dựng báo giá từ dòng lương đang hiện', () => {
    expect(page).toMatch(/profitQuote: salaryProfitQuoteFor\(m, choice\)/);
    expect(page).toMatch(/profitQuote:salaryProfitQuoteFor\(m\)/);
  });
  it('trả hàng loạt: người nào bị chặn vì phần lợi nhuận thì chỉ người đó lỗi', () => {
    const blocked = manager({ status: 'LOCKED' }, profitStaff({ sheet_status: 'LOCKED', offset_conflict: true }));
    expect(() => salaryProfitQuoteFor(blocked)).toThrow(SalaryProfitStopError);
    expect(salaryProfitQuoteFor(manager({ id: OTHER }, null))).toBeNull();
  });
});
