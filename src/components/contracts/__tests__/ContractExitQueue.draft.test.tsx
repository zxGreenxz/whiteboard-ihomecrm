// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dialog: vi.fn(), draftIds: [] as string[][], canSettle: true }));
const items = [
  { id: 'case-a', contract_id: 'contract-a', building_name: '102LVT', room_name: '502', contract_number: 'HD-A', customer_name: 'Khách A',
    actual_move_out_on: '2026-10-03', initial_kind: 'NATURAL_EXPIRY', state: 'PENDING' },
  { id: 'case-b', contract_id: 'contract-b', building_name: '1392QT', room_name: 'L06', contract_number: 'HD-B', customer_name: 'Khách B',
    actual_move_out_on: '2026-10-24', initial_kind: 'FORFEIT', state: 'PENDING' },
];
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-1' }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: {} }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: () => state.canSettle }));
vi.mock('@/hooks/useContractExitCases', () => ({
  useContractExitCases: () => ({ data: { items, total: 2 }, isLoading: false, isError: false }),
  useContractExitCase: (id: string | null) => ({ data: id ? items.find(item => item.id === id) : undefined, isLoading: false, isError: false }),
}));
vi.mock('@/hooks/useContracts', () => ({ useContract: (id?: string) => ({ data: id ? { id } : undefined, isLoading: false, isError: false }) }));
vi.mock('@/hooks/useContractExitSettlementDrafts', () => ({ useContractExitSettlementDrafts: (ids: string[]) => {
  state.draftIds.push(ids);
  return { data: [{ caseId: 'case-b', version: 2, updatedAt: '2026-10-30T03:45:00Z', updatedByName: 'Người A' }] };
} }));
vi.mock('../TerminateDialog', () => ({ TerminateDialog: (props: { exitCase: { id: string }; resumeDraft?: boolean }) => {
  state.dialog(props.exitCase.id, props.resumeDraft);
  return <div role="dialog">hộp thoại {props.exitCase.id}</div>;
} }));
import { ContractExitQueue } from '../ContractExitQueue';

beforeEach(() => { vi.clearAllMocks(); state.draftIds.length = 0; state.canSettle = true; });
afterEach(cleanup);
const show = () => render(<MemoryRouter><ContractExitQueue showEmpty /></MemoryRouter>);
const row = (text: string) => screen.getByText(text).closest('div.flex') as HTMLElement;

describe('Chờ quyết toán: hồ sơ có nháp', () => {
  it('hồ sơ có nháp hiện "Mở bản nháp" và "Quyết toán"; hồ sơ không nháp chỉ có "Quyết toán"', () => {
    show();
    const withDraft = row('1392QT · L06 · HD-B');
    expect(within(withDraft).getByText(/Có nháp · lưu .* bởi Người A/)).toBeTruthy();
    expect(within(withDraft).getByRole('button', { name: 'Mở bản nháp' })).toBeTruthy();
    expect(within(withDraft).getByRole('button', { name: 'Quyết toán' })).toBeTruthy();
    const noDraft = row('102LVT · 502 · HD-A');
    expect(within(noDraft).queryByRole('button', { name: 'Mở bản nháp' })).toBeNull();
    expect(within(noDraft).getByRole('button', { name: 'Quyết toán' })).toBeTruthy();
    expect(state.draftIds[state.draftIds.length - 1]).toEqual(['case-a', 'case-b']);
  });
  it('"Mở bản nháp" mở hộp thoại điền lại nháp; "Quyết toán" mở form mới', () => {
    show();
    fireEvent.click(within(row('1392QT · L06 · HD-B')).getByRole('button', { name: 'Mở bản nháp' }));
    expect(state.dialog).toHaveBeenLastCalledWith('case-b', true);
    cleanup(); vi.clearAllMocks();
    show();
    fireEvent.click(within(row('1392QT · L06 · HD-B')).getByRole('button', { name: 'Quyết toán' }));
    expect(state.dialog).toHaveBeenLastCalledWith('case-b', false);
  });
  it('không có quyền quyết toán thì không hỏi nháp, không hiện nút', () => {
    state.canSettle = false;
    show();
    expect(screen.queryByRole('button', { name: 'Mở bản nháp' })).toBeNull();
    expect(state.draftIds.every(ids => ids.length === 0)).toBe(true);
  });
  it('trong bảng trượt mobile: dòng gọn "P.phòng · toà", vẫn đủ hai nút và mở đúng hồ sơ', () => {
    render(<MemoryRouter><ContractExitQueue layout="sheet" showEmpty /></MemoryRouter>);
    expect(screen.queryByRole('heading', { name: /Chờ quyết toán/ })).toBeNull();
    const withDraft = screen.getByRole('link', { name: 'P.L06 · 1392QT' }).closest('.cm-qrow') as HTMLElement;
    expect(within(withDraft).getByRole('link', { name: 'P.L06 · 1392QT' }).getAttribute('href')).toBe('/contracts/contract-b');
    expect(within(withDraft).getByText(/Có nháp · lưu .* bởi Người A/)).toBeTruthy();
    expect(within(withDraft).getByText('HD-B')).toBeTruthy();
    fireEvent.click(within(withDraft).getByRole('button', { name: 'Mở bản nháp' }));
    expect(state.dialog).toHaveBeenLastCalledWith('case-b', true);
    const noDraft = screen.getByRole('link', { name: 'P.502 · 102LVT', hidden: true }).closest('.cm-qrow') as HTMLElement;
    expect(within(noDraft).queryByRole('button', { name: 'Mở bản nháp', hidden: true })).toBeNull();
    expect(within(noDraft).getByRole('button', { name: 'Quyết toán', hidden: true })).toBeTruthy();
  });
  it('trong bảng trượt mobile: không có quyền quyết toán thì chỉ xem, không nút, không dấu nháp', () => {
    state.canSettle = false;
    render(<MemoryRouter><ContractExitQueue layout="sheet" showEmpty /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'P.L06 · 1392QT' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Có nháp/)).toBeNull();
  });
});
