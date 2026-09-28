// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import { ContractWorkspaceTabList } from '../ContractWorkspaceTabList';

const mocks = vi.hoisted(() => ({
  exit: { data: undefined as { total: number; items: unknown[] } | undefined, isLoading: false, isError: false },
  drafts: { data: undefined as { building_id: string; status?: 'EDITABLE' | 'SIGNED' }[] | undefined, isLoading: false, isError: false },
  exitHook: vi.fn(), draftHook: vi.fn(),
}));
vi.mock('@/hooks/useContractExitCases', () => ({ useContractExitCases: (filters: unknown) => { mocks.exitHook(filters); return mocks.exit; } }));
vi.mock('@/hooks/useContractDrafts', () => ({ useContractDrafts: (buildingId?: string) => { mocks.draftHook(buildingId); return mocks.drafts; } }));

const buildingA = '11111111-1111-4111-8111-111111111111';
const buildingB = '22222222-2222-4222-8222-222222222222';
const buildingC = '33333333-3333-4333-8333-333333333333';
const show = (buildingIds: string[] = []) => render(<Tabs defaultValue="contracts"><ContractWorkspaceTabList buildingIds={buildingIds} /></Tabs>);

afterEach(cleanup);
beforeEach(() => {
  mocks.exit = { data: undefined, isLoading: false, isError: false };
  mocks.drafts = { data: undefined, isLoading: false, isError: false };
  mocks.exitHook.mockReset();
  mocks.draftHook.mockReset();
});

it('uses server pending total rather than the ten visible case rows', () => {
  mocks.exit.data = { total: 37, items: Array(10).fill({}) };
  mocks.drafts.data = [];
  show([buildingA]);
  expect(within(screen.getByRole('tab', { name: /Chờ quyết toán/ })).getByText('37')).toBeTruthy();
  expect(mocks.exitHook).toHaveBeenCalledWith({ buildingIds: [buildingA], state: 'PENDING', limit: 10, offset: 0 });
  expect(mocks.draftHook).toHaveBeenCalledWith(buildingA);
});

it('counts only unsigned drafts in the selected building scope', () => {
  mocks.exit.data = { total: 0, items: [] };
  mocks.drafts.data = [
    { building_id: buildingA, status: 'EDITABLE' },
    { building_id: buildingB, status: 'SIGNED' },
    { building_id: buildingB },
    { building_id: buildingC, status: 'EDITABLE' },
  ];
  show([buildingA, buildingB]);
  expect(within(screen.getByRole('tab', { name: /Hợp đồng nháp/ })).getByText('2')).toBeTruthy();
  expect(mocks.draftHook).toHaveBeenCalledWith(undefined);
});

it('shows loading and query errors instead of false zero badges', () => {
  mocks.exit.isLoading = true;
  mocks.drafts.isError = true;
  show();
  const pending = screen.getByRole('tab', { name: /Chờ quyết toán/ });
  const drafts = screen.getByRole('tab', { name: /Hợp đồng nháp/ });
  expect(within(pending).getByText('…')).toBeTruthy();
  expect(within(drafts).getByText('!')).toBeTruthy();
  expect(pending.getAttribute('title')).toMatch(/Đang tải/);
  expect(drafts.getAttribute('title')).toMatch(/Không tải/);
  expect(within(pending).queryByText('0')).toBeNull();
  expect(within(drafts).queryByText('0')).toBeNull();
});
