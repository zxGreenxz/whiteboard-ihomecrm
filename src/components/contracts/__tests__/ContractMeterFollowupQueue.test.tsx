// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractMeterFollowupQueue } from '../ContractMeterFollowupQueue';

const state = vi.hoisted(() => ({ data: null as Record<string, unknown> | null }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org' }) }));
vi.mock('@/hooks/useContractMeterFollowups', () => ({
  useContractMeterFollowups: () => ({ isLoading: false, isError: false, data: state.data, refetch: vi.fn() }),
}));

const item = (n: number, overrides: Record<string, unknown>) => ({ id: `id-${n}`, contract_id: `contract-${n}`, contract_number: `HD-${n}`,
  building_name: 'Toà A', room_name: `P${n}`, effective_on: '2026-10-01', exit_state: 'FINALIZED', exit_kind: 'EARLY_RETURN', ...overrides });
const show = () => render(<MemoryRouter><ContractMeterFollowupQueue /></MemoryRouter>);

beforeEach(() => { state.data = null; });
afterEach(cleanup);

describe('khung chờ chỉ số trả phòng', () => {
  it('giữ tên vùng, tiêu đề và nút mà spec fleet khẳng định; từng dòng nói đúng việc cần làm', () => {
    state.data = { total: 2, limit: 10, offset: 0, items: [item(1, { state: 'MISSING' }), item(2, { state: 'REVIEW' })] };
    show();
    const region = screen.getByRole('region', { name: 'Chờ bổ sung chỉ số bàn giao' });
    expect(within(region).getByRole('heading', { name: 'Chờ bổ sung / kiểm tra chỉ số (2)' })).toBeTruthy();
    expect(within(region).getByText('01/10/2026 · Đã quyết toán, chưa có chỉ số chốt')).toBeTruthy();
    expect(within(region).getByText('01/10/2026 · Số bổ sung chưa khớp số đã tính tiền, cần đối soát')).toBeTruthy();
    const links = within(region).getAllByRole('link', { name: 'Mở mốc bàn giao' });
    expect(links.map(link => link.getAttribute('href'))).toEqual(['/contracts/contract-1', '/contracts/contract-2']);
    expect(screen.queryByText(/kể cả hồ sơ đã quyết toán/)).toBeNull();
  });
  it('không có việc thì không vẽ khung', () => {
    state.data = { total: 0, limit: 10, offset: 0, items: [] };
    show();
    expect(screen.queryByRole('region', { name: 'Chờ bổ sung chỉ số bàn giao' })).toBeNull();
  });
  it('trong bảng trượt mobile: dòng gọn, tiêu đề do bảng trượt vẽ, vẫn nói đúng việc và mở đúng hồ sơ', () => {
    state.data = { total: 2, limit: 10, offset: 0, items: [item(1, { state: 'MISSING' }), item(2, { state: 'REVIEW', contract_number: null })] };
    render(<MemoryRouter><ContractMeterFollowupQueue layout="sheet" /></MemoryRouter>);
    const region = screen.getByRole('region', { name: 'Chờ bổ sung chỉ số bàn giao' });
    expect(within(region).queryByRole('heading')).toBeNull();
    expect(within(region).getByRole('link', { name: 'P.P1 · Toà A' }).getAttribute('href')).toBe('/contracts/contract-1');
    expect(within(region).getByText('Thiếu chỉ số chốt')).toBeTruthy();
    expect(within(region).getByText('Số bổ sung chưa khớp')).toBeTruthy();
    expect(within(region).getByText('Hợp đồng cũ')).toBeTruthy();
    expect(within(region).getAllByText('Bàn giao 01/10/2026')).toHaveLength(2);
    expect(within(region).getAllByRole('link', { name: 'Mở mốc bàn giao' }).map(link => link.getAttribute('href'))).toEqual(['/contracts/contract-1', '/contracts/contract-2']);
  });
  it('trong bảng trượt mobile: hết việc thì báo rõ, không để bảng trống', () => {
    state.data = { total: 0, limit: 10, offset: 0, items: [] };
    render(<MemoryRouter><ContractMeterFollowupQueue layout="sheet" /></MemoryRouter>);
    expect(screen.getByText('Không còn hồ sơ chờ chỉ số.')).toBeTruthy();
  });
});
