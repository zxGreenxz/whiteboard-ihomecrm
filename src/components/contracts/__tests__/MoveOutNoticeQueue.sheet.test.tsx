// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ queue: {} as Record<string, unknown>, canManage: true, dialog: vi.fn() }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-1' }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: () => state.canManage }));
vi.mock('@/hooks/useContracts', () => ({ useContract: (id?: string) => ({ data: id ? { id } : undefined, isPending: false, isError: false }) }));
vi.mock('@/hooks/contracts/useMoveOutNoticeQueue', () => ({ NOTICE_QUEUE_PAGE_SIZE: 10, useMoveOutNoticeQueue: () => state.queue }));
vi.mock('../MoveOutDialog', () => ({ MoveOutDialog: ({ contract }: { contract: { id: string } }) => { state.dialog(contract.id); return <div role="dialog">hộp thoại {contract.id}</div>; } }));
import { MoveOutNoticeQueue } from '../MoveOutNoticeQueue';

const items = [
  { contract_id: 'contract-a', contract_number: 'HD-A', building_name: '44TL', room_name: '203', expected_move_out_date: '2026-10-30', updated_at: 'x' },
  { contract_id: 'contract-b', contract_number: null, building_name: '80DS3', room_name: '105', expected_move_out_date: '2026-11-01', updated_at: 'x' },
];
const show = () => render(<MemoryRouter><MoveOutNoticeQueue layout="sheet" /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks(); state.canManage = true;
  state.queue = { isPending: false, isError: false, data: { today: '2026-11-01', total: 2, items } };
});
afterEach(cleanup);

describe('Hẹn trả phòng trong bảng trượt mobile', () => {
  it('dòng gọn, tiêu đề do bảng trượt vẽ, phân biệt quá ngày và đến ngày, mở đúng hồ sơ', () => {
    show();
    const region = screen.getByRole('region', { name: 'Cần xác nhận ngày trả phòng' });
    expect(within(region).queryByRole('heading')).toBeNull();
    expect(within(region).getByRole('link', { name: 'P.203 · 44TL' }).getAttribute('href')).toBe('/contracts/contract-a');
    expect(within(region).getByText('Quá ngày dự kiến')).toBeTruthy();
    expect(within(region).getByText('Đến ngày dự kiến')).toBeTruthy();
    expect(within(region).getByText('Hẹn trả 30/10/2026')).toBeTruthy();
    fireEvent.click(within(region).getAllByRole('button', { name: 'Cập nhật ngày trả' })[1]!);
    expect(state.dialog).toHaveBeenLastCalledWith('contract-b');
  });
  it('không có quyền thì chỉ xem, không có nút cập nhật', () => {
    state.canManage = false;
    show();
    expect(screen.getByRole('link', { name: 'P.203 · 44TL' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('đang tải, đọc lỗi và hết việc đều không để bảng trống', () => {
    state.queue = { isPending: true, isError: false };
    const { unmount } = show();
    expect(screen.getByRole('status')).toBeTruthy();
    unmount();
    state.queue = { isPending: false, isError: true, refetch: vi.fn() };
    const failed = show();
    expect(screen.getByRole('alert').textContent).toContain('Chưa tải được danh sách');
    failed.unmount();
    state.queue = { isPending: false, isError: false, data: { today: '2026-11-01', total: 0, items: [] } };
    show();
    expect(screen.getByText('Không còn hồ sơ cần xác nhận ngày trả phòng.')).toBeTruthy();
  });
});
