// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractDraft } from '@/lib/contractDrafts';

const draftOf = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'DRAFT', revision: 2, building_id: 'b-1', room_id: 'r-1', updated_at: '2026-10-31T07:20:00Z',
  payload: { form: { start_date: '2026-11-05' }, customers: [{ is_representative: true, full_name: `Khách ${id}` }] }, ...over,
}) as unknown as ContractDraft;
const state = vi.hoisted(() => ({ drafts: [] as unknown[] }));
vi.mock('@/hooks/useContractDrafts', () => ({
  useContractDrafts: () => ({ data: state.drafts, isLoading: false, isError: false }),
  useDeleteContractDraft: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useRooms', () => ({ useRooms: () => ({ data: [{ id: 'r-1', name: '301', building: { name: '44TL' } }] }) }));
import { ContractDraftList } from '../ContractDraftList';

const handlers = { onEdit: vi.fn(), onPrint: vi.fn(), onSign: vi.fn(), onTransfer: vi.fn() };
const show = (over: Partial<Parameters<typeof ContractDraftList>[0]> = {}) => render(<ContractDraftList layout="sheet" canEdit canExport canSign canDelete={() => true} {...handlers} {...over} />);
const rowOf = (name: string) => screen.getByText(name).closest('.cm-qdraft') as HTMLElement;

beforeEach(() => { vi.clearAllMocks(); state.drafts = [draftOf('A')]; });
afterEach(cleanup);

describe('Danh sách nháp trong bảng trượt mobile', () => {
  it('ghi đúng tên phòng và ngày theo kiểu Việt Nam; thao tác phụ ẩn cho tới khi bấm ⋯', () => {
    show();
    const row = rowOf('Khách A');
    expect(within(row).getByText('P.301 · 44TL')).toBeTruthy();
    expect(within(row).getByText(/Bắt đầu 05\/11\/2026 · Bản 2 · Sửa \d{2}\/\d{2} \d{2}:\d{2}$/)).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Sửa nháp' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /Xác nhận đã ký/ })).toBeNull();
    const more = within(row).getByRole('button', { name: 'Thao tác khác' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    for (const name of [/Xác nhận đã ký/, /^In$/, 'Liên kết nhượng', /Xóa nháp/]) expect(within(row).getByRole('button', { name })).toBeTruthy();
    fireEvent.click(more);
    expect(within(row).queryByRole('button', { name: /Xác nhận đã ký/ })).toBeNull();
  });
  it('mỗi nút gọi đúng thao tác của đúng bản nháp', () => {
    const draft = draftOf('A');
    state.drafts = [draft, draftOf('B')];
    show();
    const row = rowOf('Khách A');
    fireEvent.click(within(row).getByRole('button', { name: 'Sửa nháp' }));
    expect(handlers.onEdit).toHaveBeenCalledWith(draft);
    fireEvent.click(within(row).getByRole('button', { name: 'Thao tác khác' }));
    fireEvent.click(within(row).getByRole('button', { name: /Xác nhận đã ký/ }));
    expect(handlers.onSign).toHaveBeenCalledWith(draft);
    fireEvent.click(within(row).getByRole('button', { name: /^In$/ }));
    expect(handlers.onPrint).toHaveBeenCalledWith(draft);
    fireEvent.click(within(row).getByRole('button', { name: 'Liên kết nhượng' }));
    expect(handlers.onTransfer).toHaveBeenCalledWith(draft);
    fireEvent.click(within(row).getByRole('button', { name: /Xóa nháp/ }));
    expect(screen.getByRole('alertdialog', { name: 'Xóa bản nháp này?' })).toBeTruthy();
  });
  it('bản đã ký không sửa, không ký lại, không xóa; chỉ còn In và Liên kết nhượng', () => {
    state.drafts = [draftOf('A', { status: 'SIGNED' })];
    show();
    const row = rowOf('Khách A');
    expect(within(row).getByText('Đã ký')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Sửa nháp' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Thao tác khác' }));
    expect(within(row).queryByRole('button', { name: /Xác nhận đã ký/ })).toBeNull();
    expect(within(row).queryByRole('button', { name: /Xóa nháp/ })).toBeNull();
    expect(within(row).getByRole('button', { name: /^In$/ })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Liên kết nhượng' })).toBeTruthy();
  });
  it('không có quyền nào thì không có nút thừa; phòng chưa chọn/không tra được ghi rõ', () => {
    state.drafts = [draftOf('A', { room_id: null }), draftOf('B', { room_id: 'r-khong-thay' })];
    show({ canEdit: false, canExport: false, canSign: false, canDelete: () => false });
    expect(screen.queryByRole('button')).toBeNull();
    expect(within(rowOf('Khách A')).getByText('Chưa chọn phòng')).toBeTruthy();
    expect(within(rowOf('Khách B')).getByText('Đã chọn phòng')).toBeTruthy();
  });
});
