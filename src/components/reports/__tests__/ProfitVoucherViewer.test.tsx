// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Thay ba thành phần của Thu chi bằng bản ghi props: kiểm ADAPTER truyền gì, không kiểm lại chính Thu chi.
type Voucher = { id: string };
type DetailProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucherId?: string | null;
  organizationIdHint?: string | null;
  onEdit?: (v: Voucher) => void;
  onQuickEdit?: (v: Voucher) => void;
  [key: string]: unknown;
};
type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void; voucher: Voucher | null };
const seen = vi.hoisted(() => ({ detail: [] as DetailProps[], form: [] as DialogProps[], quick: [] as DialogProps[] }));

vi.mock('@/components/income-expenses/IncomeExpenseDetailDialog', () => ({
  default: (props: DetailProps) => {
    seen.detail.push(props);
    if (!props.open) return null;
    // như hộp thật: gọi onEdit/onQuickEdit RỒI mới onOpenChange(false)
    return (
      <div data-testid="detail">
        <button type="button" onClick={() => { props.onEdit?.({ id: 'v-1' }); props.onOpenChange(false); }}>sua</button>
        <button type="button" onClick={() => { props.onQuickEdit?.({ id: 'v-1' }); props.onOpenChange(false); }}>bo-sung</button>
        <button type="button" onClick={() => props.onOpenChange(false)}>dong</button>
      </div>
    );
  },
}));
vi.mock('@/components/income-expenses/IncomeExpenseForm', () => ({
  default: (props: DialogProps) => {
    seen.form.push(props);
    return props.open ? <button type="button" data-testid="form" onClick={() => props.onOpenChange(false)}>{props.voucher?.id}</button> : null;
  },
}));
vi.mock('@/components/income-expenses/IncomeExpenseQuickEditDialog', () => ({
  default: (props: DialogProps) => {
    seen.quick.push(props);
    return props.open ? <button type="button" data-testid="quick" onClick={() => props.onOpenChange(false)}>{props.voucher?.id}</button> : null;
  },
}));

import ProfitVoucherViewer from '../ProfitVoucherViewer';

afterEach(cleanup);
beforeEach(() => {
  seen.detail.length = 0;
  seen.form.length = 0;
  seen.quick.length = 0;
});

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

describe('ProfitVoucherViewer (adapter mở phiếu chi từ Báo cáo LN)', () => {
  it('mở đúng phiếu, chỉ trao Sửa + Bổ sung — Duyệt / Huỷ duyệt / Huỷ / Khôi phục / Chi nhanh vẫn ở Thu chi', () => {
    setup();
    const props = seen.detail.at(-1)!;
    expect(props.open).toBe(true);
    expect(props.voucherId).toBe('v-1');
    expect(props.organizationIdHint).toBe('org-1');
    expect(props.voucher).toBeNull();
    expect(typeof props.onEdit).toBe('function');
    expect(typeof props.onQuickEdit).toBe('function');
    for (const key of ['onApprove', 'onUnapprove', 'onCancel', 'onRestore', 'onCopy', 'quickExpense', 'onPostApproved', 'onReversePosting']) {
      expect(props[key], key).toBeUndefined();
    }
  });

  it('Sửa ⇒ hộp đóng, form Thu chi mở đúng phiếu; đóng form ⇒ làm mới 4 nguồn số rồi đóng', () => {
    const { invalidate, onClose } = setup();
    fireEvent.click(screen.getByText('sua'));
    expect(screen.queryByTestId('detail')).toBeNull();
    expect(screen.getByTestId('form').textContent).toBe('v-1');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('form'));
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toEqual([
      ['financial-analysis', 'monthly-pnl'],
      ['profit-verification'],
      ['profit-post-lock'],
      ['landlord-settlement', 'ihome'],
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Bổ sung chứng từ ⇒ hộp bổ sung của Thu chi; đóng ⇒ đóng, không làm mới số (bổ sung không đổi tiền)', () => {
    const { invalidate, onClose } = setup();
    fireEvent.click(screen.getByText('bo-sung'));
    expect(screen.getByTestId('quick').textContent).toBe('v-1');
    fireEvent.click(screen.getByTestId('quick'));
    expect(invalidate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('đóng hộp phiếu ⇒ đóng, không làm mới số', () => {
    const { invalidate, onClose } = setup();
    fireEvent.click(screen.getByText('dong'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('form')).toBeNull();
  });
});
