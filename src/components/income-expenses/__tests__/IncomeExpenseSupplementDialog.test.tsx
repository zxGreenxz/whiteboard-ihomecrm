// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import IncomeExpenseQuickEditDialog from '../IncomeExpenseQuickEditDialog';
import type { IncomeExpenseWithRelations } from '@/hooks/useIncomeExpenses';

const state = vi.hoisted(() => ({ save: vi.fn(), legacy: vi.fn(), move: vi.fn(), pending: false }));
vi.mock('@/hooks/income-expenses/supplements', () => ({
  useAppendIncomeExpenseSupplement: () => ({ mutateAsync: state.save, isPending: state.pending }),
  useIncomeExpenseSupplements: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock('@/hooks/income-expenses/annotateMutations', () => ({ useAnnotateIncomeExpense: () => ({ mutateAsync: state.legacy }) }));
vi.mock('@/hooks/income-expenses/incomeVoucherCashbook', () => ({
  useMyCashbookAccess: () => ({ data: [] }), useMoveIncomeVoucherCashbook: () => ({ mutateAsync: state.move }),
}));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: '00000000-0000-4000-8000-000000000002' } }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useSignedUrl', () => ({ useSignedUrl: (url: string | null) => url }));
vi.mock('@/components/ui/storage-image', () => ({ StorageImage: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} /> }));
vi.mock('../AttachmentUpload', () => ({ default: (props: {
  attachments: string[]; onChange: (urls: string[]) => void; disabled?: boolean;
  onUploadingChange?: (busy: boolean) => void; deleteOnRemove?: boolean;
}) => <div data-testid="new-upload" data-physical-delete={String(props.deleteOnRemove)}>
  {props.attachments.map(url => <button type="button" key={url} onClick={() => props.onChange(props.attachments.filter(x => x !== url))}>Gỡ {url}</button>)}
  <button type="button" disabled={props.disabled} onClick={() => props.onChange([...props.attachments, 'https://proof.test/new.png'])}>Chọn ảnh mới</button>
  <button type="button" onClick={() => props.onUploadingChange?.(true)}>Bắt đầu tải</button>
  <button type="button" onClick={() => props.onUploadingChange?.(false)}>Tải xong</button>
</div> }));

const voucher = { id: '00000000-0000-4000-8000-000000000001', code: 'PC-DEMO', type: 'EXPENSE',
  approval_status: 'APPROVED', posting_status: 'POSTED', user_id: 'original-creator',
  notes: 'Ghi chú nguyên bản', attachments: ['https://proof.test/original.png'],
} as IncomeExpenseWithRelations;

beforeEach(() => { state.save.mockReset().mockResolvedValue({ changed: true }); state.legacy.mockReset(); state.move.mockReset(); state.pending = false; });
afterEach(cleanup);

describe('Bổ sung chứng từ / ghi chú', () => {
  it('giữ nội dung cũ chỉ đọc, phần nhập mới trống, không có điều khiển tiền', () => {
    render(<IncomeExpenseQuickEditDialog open onOpenChange={() => {}} voucher={{ ...voucher, type: 'INCOME', account_id: 'cashbook' }} />);
    expect(screen.getByText('Ghi chú nguyên bản')).toBeTruthy();
    expect(screen.getByRole('textbox').textContent).toBe('');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Gỡ.*original/ })).toBeNull();
    expect(screen.getByTestId('new-upload').getAttribute('data-physical-delete')).toBe('false');
    expect((screen.getByRole('button', { name: 'Lưu bổ sung' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('chỉ gửi nội dung bổ sung, giữ khoá khi thử lại sau lỗi và không gọi sửa phiếu', async () => {
    state.save.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ changed: true });
    const close = vi.fn();
    render(<IncomeExpenseQuickEditDialog open onOpenChange={close} voucher={voucher} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Khách xác nhận\nĐã nhận hoàn trả' } });
    fireEvent.click(screen.getByRole('button', { name: 'Chọn ảnh mới' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu bổ sung' }));
    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Lưu bổ sung' }));
    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(2));
    expect(state.save.mock.calls[0][0]).toEqual({ voucherId: voucher.id,
      note: 'Khách xác nhận\nĐã nhận hoàn trả', attachments: ['https://proof.test/new.png'], idempotencyKey: expect.any(String) });
    expect(state.save.mock.calls[1][0]).toEqual(state.save.mock.calls[0][0]);
    expect(state.legacy).not.toHaveBeenCalled(); expect(state.move).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(false);
  });

  it('cho lưu chỉ ảnh và khoá lưu/đóng trong khi ảnh còn tải', async () => {
    render(<IncomeExpenseQuickEditDialog open onOpenChange={() => {}} voucher={voucher} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chọn ảnh mới' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu tải' }));
    expect((screen.getByRole('button', { name: 'Lưu bổ sung' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Huỷ' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Tải xong' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu bổ sung' }));
    await waitFor(() => expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ note: '', attachments: ['https://proof.test/new.png'] })));
  });
});
