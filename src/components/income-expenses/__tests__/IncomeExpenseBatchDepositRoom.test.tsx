// @vitest-environment jsdom
// Phiếu tổng: dòng hạng mục Tiền cọc phải chọn phòng (07/10/2026) — chặn trước khi gửi, vì phiếu tổng
// lưu lần lượt từng phiếu: máy chủ chặn giữa chừng sẽ để lại một đợt dở dang.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ create: vi.fn(), toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: h.toastError, warning: vi.fn(), success: vi.fn() } }));
vi.mock('@/hooks/useIncomeExpenses', () => ({ useCreateIncomeExpenseBatch: () => ({ mutateAsync: h.create, isPending: false }) }));
vi.mock('@/hooks/useIncomeExpenseFormScope', () => ({ useIncomeExpenseFormBuildings: () => ({ data: [{ id: 'b1', name: '1392QT', managed: true }] }), useIncomeExpenseFormRooms: () => ({ data: [] }) }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: () => ({ data: [{ id: 'a1', name: 'TKHIEP' }] }) }));
vi.mock('@/hooks/useIncomeExpenseTypes', () => ({ useIncomeExpenseTypes: () => ({ data: [{ id: 'tien-coc', name: 'Tiền Cọc', is_deposit: true }] }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'u1' } }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('../AttachmentUpload', () => ({ default: () => null }));
vi.mock('../IncomeExpenseItemSelector', () => ({ default: ({ open, onSelect, onOpenChange }: { open: boolean; onSelect: (items: { id: string; name: string }[]) => void; onOpenChange: (open: boolean) => void }) => open ? <button onClick={() => { onSelect([{ id: 'tien-coc', name: 'Tiền Cọc' }]); onOpenChange(false); }}>Chọn tiền cọc</button> : null }));
import IncomeExpenseBatchForm from '../IncomeExpenseBatchForm';
import { DEPOSIT_ROOM_REQUIRED_MESSAGE } from '@/lib/depositRoomRule';
class ResizeObserverFake { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', ResizeObserverFake);
afterEach(cleanup);
describe('Phiếu tổng: dòng Tiền cọc bắt buộc chọn phòng', () => {
  it('chưa chọn phòng ⇒ không gửi, báo lỗi ngay ô Phòng của dòng đó', async () => {
    render(<IncomeExpenseBatchForm open onOpenChange={() => {}} defaultType="INCOME" />);
    fireEvent.click(screen.getByRole('button', { name: 'Thêm hạng mục' }));
    fireEvent.click(screen.getByText('Chọn tiền cọc'));
    expect(screen.getByText('Phòng *')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lưu 1 phiếu' }));
    const phong = await screen.findByRole('combobox', { name: 'Phòng hạng mục 1' });
    await waitFor(() => expect(phong.getAttribute('aria-invalid')).toBe('true'));
    expect(phong.getAttribute('aria-describedby')).toBe('batch-item-0-room_id-error');
    expect(document.getElementById('batch-item-0-room_id-error')?.textContent).toBe(DEPOSIT_ROOM_REQUIRED_MESSAGE);
    expect(h.toastError).toHaveBeenCalledWith(DEPOSIT_ROOM_REQUIRED_MESSAGE);
    expect(h.create).not.toHaveBeenCalled();
  });
});
