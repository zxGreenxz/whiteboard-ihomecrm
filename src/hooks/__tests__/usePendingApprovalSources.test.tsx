// @vitest-environment jsdom
// Hộp duyệt — đọc NGUỒN phiếu chờ duyệt theo công ty, cô lập lỗi (D2.16): một công ty / một phiếu không đọc
// được (vd phiếu DEMO người duyệt không xem được chi tiết) không được làm mọi dòng thành "chưa rõ loại".
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('@/lib/incomeExpenseDetailRpc', () => ({ loadIncomeExpenseDetails: m.load }));
vi.mock('@/hooks/income-expenses/detailRead', () => ({ withDetailReadDeadline: (read: Promise<unknown>) => read }));

import {
  readPendingVoucherSources, usePendingApprovalSources,
  type PendingApproval, type PendingVoucherDetail, type PendingVoucherDetailReader,
} from '../useApprovals';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const detail = (id: string, org: string, source: string | null = null, account: string | null = null): PendingVoucherDetail =>
  ({ id, organization_id: org, system_source: source, account_id: account });
const DETAILS: Record<string, PendingVoucherDetail> = {
  a1: detail('a1', ORG_A, 'profit.ledger_payout', 'acc-1'),
  a2: detail('a2', ORG_A, null, 'acc-2'),
  b1: detail('b1', ORG_B, 'profit.manager_salary', 'acc-3'),
  b2: detail('b2', ORG_B, null, null),
};
const BROKEN = new Set(['b2']);

/** Đọc giả như readIncomeExpenseDetails: lô có phiếu hỏng ⇒ ném cả lô. */
const readerWith = (broken: ReadonlySet<string>) => vi.fn<PendingVoucherDetailReader>(async (org, ids) => {
  if (ids.some((id) => broken.has(id))) throw new Error('Chi tiết phiếu chưa đầy đủ. Vui lòng tải lại.');
  return ids.map((id) => DETAILS[id]).filter((d) => d.organization_id === org);
});

describe('readPendingVoucherSources — cô lập lỗi theo công ty / phiếu', () => {
  it('hai công ty đọc trọn: mỗi công ty đúng một lô', async () => {
    const read = readerWith(new Set());
    const result = await readPendingVoucherSources([[ORG_A, ['a1', 'a2']], [ORG_B, ['b1', 'b2']]], read);
    expect(result).toEqual({
      a1: { system_source: 'profit.ledger_payout', account_id: 'acc-1' },
      a2: { system_source: null, account_id: 'acc-2' },
      b1: { system_source: 'profit.manager_salary', account_id: 'acc-3' },
      b2: { system_source: null, account_id: null },
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('một công ty lô lỗi: đọc lẻ từng phiếu của công ty đó, phiếu đọc được vẫn rõ loại, phiếu hỏng vắng', async () => {
    const read = readerWith(BROKEN);
    const result = await readPendingVoucherSources([[ORG_A, ['a1', 'a2']], [ORG_B, ['b1', 'b2']]], read);
    expect(Object.keys(result).sort()).toEqual(['a1', 'a2', 'b1']);
    expect(result.b1).toEqual({ system_source: 'profit.manager_salary', account_id: 'acc-3' });
    expect(read.mock.calls.map(([org, ids]) => `${org}:${ids.join(',')}`)).toEqual([
      'org-a:a1,a2', 'org-b:b1,b2', 'org-b:b1', 'org-b:b2',
    ]);
  });

  it('đọc lẻ chạy SONG SONG (không chờ hết giờ nối tiếp)', async () => {
    let inFlight = 0;
    let peak = 0;
    const read = vi.fn<PendingVoucherDetailReader>(async (org, ids) => {
      if (ids.length > 1) throw new Error('lô lỗi');
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return ids.map((id) => detail(id, org));
    });
    const result = await readPendingVoucherSources([[ORG_B, ['b1', 'b2', 'b3']]], read);
    expect(Object.keys(result).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(peak).toBe(3);
  });

  it('lô một phiếu lỗi: không đọc lại, công ty khác vẫn rõ loại', async () => {
    const read = readerWith(BROKEN);
    const result = await readPendingVoucherSources([[ORG_A, ['a1']], [ORG_B, ['b2']]], read);
    expect(result).toEqual({ a1: { system_source: 'profit.ledger_payout', account_id: 'acc-1' } });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('không đọc được phiếu nào (mất mạng) ⇒ ném lỗi đầu tiên để màn giữ câu báo chung + Thử lại', async () => {
    const offline = new TypeError('Failed to fetch');
    const read = vi.fn<PendingVoucherDetailReader>(async () => { throw offline; });
    await expect(readPendingVoucherSources([[ORG_A, ['a1', 'a2']], [ORG_B, ['b1']]], read)).rejects.toBe(offline);
  });

  it('bỏ dòng khác công ty / ngoài tập hỏi', async () => {
    const read = vi.fn<PendingVoucherDetailReader>(async () => [DETAILS.a1, DETAILS.b1, detail('zz', ORG_A)]);
    expect(await readPendingVoucherSources([[ORG_A, ['a1']]], read)).toEqual({
      a1: { system_source: 'profit.ledger_payout', account_id: 'acc-1' },
    });
  });
});

describe('usePendingApprovalSources', () => {
  let client: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const row = (voucherId: string, org: string): PendingApproval => ({
    request_id: `r-${voucherId}`, submission_no: 1, submitted_at: '2026-11-15T00:00:00Z', amount: 1000, voucher_id: voucherId,
    voucher_code: null, voucher_name: null, voucher_type: 'EXPENSE', maker_name: null, step_no: 1, request_version: 1,
    organization_id: org, approval_version: 1, posting_version: 1, system_source: null,
  });
  const rows = [row('a1', ORG_A), row('b1', ORG_B), row('b2', ORG_B)];

  beforeEach(() => {
    vi.clearAllMocks();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(cleanup);

  it('một phiếu của công ty khác hỏng: phiếu sổ tổng vẫn được nhận ra, phiếu hỏng vắng', async () => {
    m.load.mockImplementation(readerWith(BROKEN));
    const { result } = renderHook(() => usePendingApprovalSources(rows), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      a1: { system_source: 'profit.ledger_payout', account_id: 'acc-1' },
      b1: { system_source: 'profit.manager_salary', account_id: 'acc-3' },
    });
  });

  it('mọi lượt đọc đều lỗi ⇒ query lỗi', async () => {
    m.load.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => usePendingApprovalSources(rows), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(TypeError);
  });
});
