// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Kiểm Báo cáo CHỈ NỐI DÂY vào bộ dùng chung của Thu chi: hộp chi tiết, bộ thao tác (useVoucherActions),
// hộp xác nhận (VoucherActionDialogs), Chi nhanh (useQuickExpense). Chính các bộ đó có test riêng.
type Voucher = { id: string };
type DetailProps = { open: boolean; onOpenChange: (open: boolean) => void; [key: string]: unknown };
const seen = vi.hoisted(() => ({
  detail: [] as DetailProps[],
  dialogs: [] as unknown[],
  options: [] as Array<{ vouchers: readonly Voucher[]; onChanged?: () => void }>,
  controllers: [] as Array<Record<string, unknown>>,
  quickRun: vi.fn(async () => {}),
}));

vi.mock('@/components/income-expenses/IncomeExpenseDetailDialog', () => ({
  default: (props: DetailProps) => {
    seen.detail.push(props);
    if (!props.open) return null;
    // như hộp thật: gọi thao tác RỒI mới onOpenChange(false)
    const approve = props.onApprove as (v: Voucher) => void;
    return (
      <div data-testid="detail">
        <button type="button" onClick={() => { approve({ id: 'v-1' }); props.onOpenChange(false); }}>duyet</button>
        <button type="button" onClick={() => props.onOpenChange(false)}>dong</button>
      </div>
    );
  },
}));
vi.mock('@/components/income-expenses/VoucherActionDialogs', () => ({
  default: ({ actions }: { actions: { anyOpen: boolean; closeAll: () => void } }) => {
    seen.dialogs.push(actions);
    return actions.anyOpen ? <button type="button" data-testid="hop-xac-nhan" onClick={actions.closeAll}>dong-hop</button> : null;
  },
}));
vi.mock('@/hooks/income-expenses/detailRead', () => ({
  useIncomeExpenseDetail: () => ({ data: { id: 'v-1' } }),
}));
vi.mock('@/hooks/income-expenses/useQuickExpense', () => ({
  useQuickExpense: () => ({ run: seen.quickRun, busy: false, collecting: false }),
}));
vi.mock('@/hooks/income-expenses/useVoucherActions', () => ({
  useVoucherActions: (options: { vouchers: readonly Voucher[]; onChanged?: () => void }) => {
    seen.options.push(options);
    const [open, setOpen] = useState(false);
    const opener = () => setOpen(true);
    const controller = {
      edit: opener, quickEdit: opener, verify: opener, history: opener, copy: opener, approve: opener,
      postApproved: opener, reverse: opener, unapprove: opener, cancel: opener, restore: opener,
      cancelBatch: opener, stopRecurring: vi.fn(),
      cancelEligibility: { 'v-1': { id: 'v-1', eligible: true, reason_code: null } },
      incomeCancelEligibility: {},
      anyOpen: open,
      closeAll: () => setOpen(false),
    };
    seen.controllers.push(controller);
    return controller;
  },
}));

import ProfitVoucherViewer from '../ProfitVoucherViewer';

afterEach(cleanup);
beforeEach(() => {
  seen.detail.length = 0;
  seen.dialogs.length = 0;
  seen.options.length = 0;
  seen.controllers.length = 0;
  seen.quickRun.mockClear();
});

const EXTRA_KEYS = [
  ['financial-analysis', 'monthly-pnl'],
  ['profit-verification'],
  ['profit-post-lock'],
  ['landlord-settlement', 'ihome'],
];

function setup() {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <ProfitVoucherViewer voucherId="v-1" organizationId="org-1" onClose={onClose} />
    </QueryClientProvider>,
  );
  return { invalidate, onClose };
}

describe('ProfitVoucherViewer — Báo cáo LN dùng đúng bộ thao tác của Thu chi', () => {
  it('trao cho hộp chi tiết ĐỦ nút của bộ dùng chung + Chi nhanh + câu trả lời Huỷ của máy chủ', () => {
    setup();
    const props = seen.detail.at(-1)!;
    const ctl = seen.controllers.at(-1)!;
    expect(props.open).toBe(true);
    expect(props.voucherId).toBe('v-1');
    expect(props.organizationIdHint).toBe('org-1');
    const pairs: Array<[string, string]> = [
      ['onEdit', 'edit'], ['onQuickEdit', 'quickEdit'], ['onApprove', 'approve'], ['onUnapprove', 'unapprove'],
      ['onCancel', 'cancel'], ['onRestore', 'restore'], ['onCopy', 'copy'], ['onPostApproved', 'postApproved'],
      ['onReversePosting', 'reverse'], ['onVerify', 'verify'], ['onHistory', 'history'], ['onStopRecurring', 'stopRecurring'],
      ['cancelEligibility', 'cancelEligibility'], ['incomeCancelEligibility', 'incomeCancelEligibility'],
    ];
    for (const [prop, key] of pairs) expect(props[prop], prop).toBe(ctl[key]);
    expect(typeof (props.quickExpense as { run: unknown }).run).toBe('function');
    // hộp xác nhận chung được gắn với ĐÚNG bộ thao tác đó; bộ thao tác biết phiếu đang mở
    expect(seen.dialogs.at(-1)).toBe(ctl);
    expect(seen.options.at(-1)!.vouchers).toEqual([{ id: 'v-1' }]);
  });

  it('sau thao tác có ghi (onChanged) ⇒ làm mới đúng 4 nguồn số riêng của báo cáo', () => {
    const { invalidate } = setup();
    act(() => { seen.options.at(-1)!.onChanged!(); });
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toEqual(EXTRA_KEYS);
  });

  it('bấm Duyệt: hộp chi tiết đóng nhưng báo cáo GIỮ màn tới khi hộp xác nhận đóng', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByText('duyet'));
    expect(screen.queryByTestId('detail')).toBeNull();
    expect(screen.getByTestId('hop-xac-nhan')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('hop-xac-nhan'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('đóng hộp chi tiết khi không thao tác ⇒ trả màn ngay, không làm mới số', () => {
    const { invalidate, onClose } = setup();
    fireEvent.click(screen.getByText('dong'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('Chi nhanh chạy xong (kể cả lỗi) ⇒ làm mới số báo cáo', async () => {
    const { invalidate } = setup();
    const quick = seen.detail.at(-1)!.quickExpense as { run: (rows: Voucher[]) => Promise<void> };
    await act(async () => { await quick.run([{ id: 'v-1' }]); });
    expect(seen.quickRun).toHaveBeenCalledWith([{ id: 'v-1' }]);
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toEqual(EXTRA_KEYS);
  });
});
