// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  move: { data: { total: 0 } } as { data?: { total: number }; isError?: boolean },
  exit: { data: { total: 0 } } as { data?: { total: number }; isError?: boolean },
  meter: { data: { total: 0 } } as { data?: { total: number }; isError?: boolean },
  drafts: { data: [] } as { data?: { status: string }[]; isError?: boolean },
  exitScope: [] as unknown[],
}));
vi.mock('@/hooks/contracts/useMoveOutNoticeQueue', () => ({ useMoveOutNoticeQueue: () => state.move }));
vi.mock('@/hooks/useContractExitCases', () => ({ useContractExitCases: (filters: unknown) => { state.exitScope.push(filters); return state.exit; } }));
vi.mock('@/hooks/useContractMeterFollowups', () => ({ useContractMeterFollowups: () => state.meter }));
vi.mock('@/hooks/useContractDrafts', () => ({ useContractDrafts: () => state.drafts }));
vi.mock('../MoveOutNoticeQueue', () => ({ MoveOutNoticeQueue: ({ layout }: { layout: string }) => <p>khung hẹn trả {layout}</p> }));
vi.mock('../ContractExitQueue', () => ({ ContractExitQueue: ({ layout, showEmpty }: { layout: string; showEmpty: boolean }) => <p>khung quyết toán {layout} {String(showEmpty)}</p> }));
vi.mock('../ContractMeterFollowupQueue', () => ({ ContractMeterFollowupQueue: ({ layout }: { layout: string }) => <p>khung chỉ số {layout}</p> }));
vi.mock('../ContractDraftWorkspace', () => ({ ContractDraftWorkspace: ({ sheetHeader }: { sheetHeader: (action: ReactNode) => ReactNode }) => <>{sheetHeader(<button>Soạn nháp</button>)}<p>khung nháp</p></> }));
import { ContractMobileQueues } from '../ContractMobileQueues';

beforeEach(() => {
  state.move = { data: { total: 0 } }; state.exit = { data: { total: 0 } }; state.meter = { data: { total: 0 } };
  state.drafts = { data: [] }; state.exitScope.length = 0;
});
afterEach(cleanup);
const tileNames = () => screen.getAllByRole('button').map(button => button.textContent);

describe('Ô hàng chờ trang Hợp đồng mobile', () => {
  it('chỉ hàng có hồ sơ mới có ô; ô Nháp luôn có để còn lối soạn, và đếm bỏ bản đã ký', () => {
    state.exit = { data: { total: 2 } };
    state.drafts = { data: [{ status: 'DRAFT' }, { status: 'SIGNED' }, { status: 'DRAFT' }] };
    render(<ContractMobileQueues />);
    expect(tileNames()).toEqual(['Chờ quyết toán2', 'Hợp đồng nháp2']);
  });
  it('đủ bốn hàng thì xếp theo độ gấp: hẹn trả, quyết toán, chỉ số, nháp', () => {
    state.move = { data: { total: 1 } }; state.exit = { data: { total: 3 } }; state.meter = { data: { total: 4 } };
    render(<ContractMobileQueues />);
    expect(tileNames()).toEqual(['Hẹn trả phòng1', 'Chờ quyết toán3', 'Chờ chỉ số4', 'Hợp đồng nháp0']);
  });
  it('chưa có dữ liệu thì chưa vẽ ô hàng chờ, không in số 0', () => {
    state.exit = {}; state.move = {}; state.meter = {};
    render(<ContractMobileQueues />);
    expect(tileNames()).toEqual(['Hợp đồng nháp0']);
  });
  it('đọc lỗi không bị giấu: ô vẫn hiện "!" và mở được để thử lại', () => {
    state.exit = { isError: true };
    render(<ContractMobileQueues />);
    expect(screen.getByLabelText('Không tải được hồ sơ chờ quyết toán').textContent).toBe('!');
    fireEvent.click(screen.getByRole('button', { name: /Chờ quyết toán/ }));
    expect(screen.getByText('khung quyết toán sheet true')).toBeTruthy();
  });
  it('bấm ô mở đúng hàng trong bảng trượt, đóng rồi mở hàng khác', () => {
    state.exit = { data: { total: 2 } }; state.meter = { data: { total: 1 } };
    render(<ContractMobileQueues />);
    fireEvent.click(screen.getByRole('button', { name: /Chờ quyết toán/ }));
    const dialog = screen.getByRole('dialog', { name: /Chờ quyết toán/ });
    expect(within(dialog).getByText('khung quyết toán sheet true')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /Chờ chỉ số/, hidden: true }));
    expect(within(screen.getByRole('dialog', { name: /Chờ chỉ số/ })).getByText('khung chỉ số sheet')).toBeTruthy();
  });
  it('bảng Nháp đặt nút Soạn nháp vào đầu bảng', () => {
    render(<ContractMobileQueues buildingId="b-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Hợp đồng nháp/ }));
    const dialog = screen.getByRole('dialog', { name: /Hợp đồng nháp/ });
    expect(within(dialog).getByRole('button', { name: 'Soạn nháp' })).toBeTruthy();
    expect(within(dialog).getByText('khung nháp')).toBeTruthy();
    expect(state.exitScope[0]).toEqual({ buildingIds: ['b-1'], state: 'PENDING', limit: 10, offset: 0 });
  });
});
