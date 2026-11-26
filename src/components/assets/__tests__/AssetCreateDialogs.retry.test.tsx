// @vitest-environment jsdom
// Đợt 9 (luật 5): bốn hộp TẠO tài sản / biên bản bàn giao / di chuyển / bảo trì không còn tự khoá sau một kết quả chưa rõ.
// Hook thật + máy chủ giả: lần gửi đầu tới máy chủ nhưng mất phản hồi ⇒ hộp báo rõ, nút vẫn bấm được; bấm lại gửi ĐÚNG mã
// cũ nên máy chủ chỉ có một bản ghi, hộp đóng như lưu thành công.
import * as ReactQuery from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, type FakeRecordServer } from '@/hooks/__tests__/fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
const list = (data: unknown[]) => ({ data, isLoading: false, isError: false, isPending: false, refetch: vi.fn() });
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table) } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => list([]) }));
vi.mock('@/hooks/useRooms', () => ({ useRooms: () => list([{ id: 'phong-2', name: 'P2', building: { name: 'Toà A' } }]) }));
vi.mock('@/hooks/useContracts', () => ({ useContracts: () => list([{ id: 'hd-1', contract_number: 'HĐ-01' }]) }));
vi.mock('@/hooks/useAssets', async original => ({
  ...await original<typeof import('@/hooks/useAssets')>(),
  useAssets: () => list([{ id: 'ts-1', name: 'Ghế', code: null, room: null }]),
}));
vi.mock('@/components/ui/select', () => ({
  Select: (p: { children: ReactNode; value: string; onValueChange: (value: string) => void }) => <select value={p.value ?? ''} onChange={e => p.onValueChange(e.target.value)}><option value="" />{p.children}</select>,
  SelectTrigger: () => null, SelectValue: () => null,
  SelectContent: (p: { children: ReactNode }) => <>{p.children}</>,
  SelectItem: (p: { value: string; children: ReactNode }) => <option value={p.value}>{p.children}</option>,
}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

import { forgetUnconfirmedCreates } from '@/lib/clientRecordCreate';
import { CreateAssetDialog } from '../CreateAssetDialog';
import { AssetHandoverDialog } from '../AssetHandoverDialog';
import { AssetMovementDialog } from '../AssetMovementDialog';
import { AssetMaintenanceDialog } from '../AssetMaintenanceDialog';

const rows = (table: string) => io.server.rows[table] ?? [];
const sentIds = (table: string) => io.server.inserts.filter(item => item.table === table).map(item => (item.payload as Record<string, unknown>).id);
const withClient = (ui: ReactNode) => <ReactQuery.QueryClientProvider client={new ReactQuery.QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</ReactQuery.QueryClientProvider>;
const combo = (index: number) => screen.getAllByRole('combobox')[index] as HTMLSelectElement;

beforeEach(() => {
  io.server = fakeRecordServer();
  io.server.rows.asset_categories = [{ id: 'cat-1', name: 'Bàn ghế' }];
  io.server.rows.profiles = [{ id: 'actor', full_name: 'Người tạo' }];
  forgetUnconfirmedCreates();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
});
afterEach(cleanup);

interface Case { table: string; button: string; mount: (close: () => void) => ReactNode; fill: () => Promise<void> }
const CASES: Array<[string, Case]> = [
  ['tạo tài sản', {
    table: 'assets', button: 'Tạo tài sản',
    mount: close => <CreateAssetDialog open onOpenChange={close} />,
    fill: async () => {
      await screen.findByRole('option', { name: 'Bàn ghế' });
      fireEvent.change(screen.getByLabelText('Tên tài sản *'), { target: { value: 'Ghế xoay' } });
      fireEvent.change(combo(0), { target: { value: 'cat-1' } });
    },
  }],
  ['tạo biên bản bàn giao', {
    table: 'asset_handovers', button: 'Tạo biên bản',
    mount: close => <AssetHandoverDialog open onOpenChange={close} />,
    fill: async () => {
      fireEvent.change(combo(0), { target: { value: 'hd-1' } });
      fireEvent.change(screen.getByLabelText('Danh sách tài sản (JSON) *'), { target: { value: '{"items":[]}' } });
    },
  }],
  ['ghi di chuyển tài sản', {
    table: 'asset_movements', button: 'Ghi nhận di chuyển',
    mount: close => <AssetMovementDialog open onOpenChange={close} />,
    fill: async () => {
      fireEvent.change(combo(0), { target: { value: 'ts-1' } });
      fireEvent.change(combo(2), { target: { value: 'phong-2' } });
    },
  }],
  ['tạo phiếu bảo trì', {
    table: 'asset_maintenance', button: 'Tạo phiếu bảo trì',
    mount: close => <AssetMaintenanceDialog open onOpenChange={close} />,
    fill: async () => {
      await screen.findByRole('option', { name: 'Người tạo' });
      fireEvent.change(combo(0), { target: { value: 'ts-1' } });
      fireEvent.change(screen.getByLabelText('Mô tả công việc *'), { target: { value: 'Hỏng chân ghế' } });
    },
  }],
];

describe.each(CASES)('%s', (_label, item) => {
  it('mất phản hồi: hộp báo rõ, KHÔNG khoá nút; bấm lại gửi đúng mã cũ, một bản ghi, hộp đóng', async () => {
    const close = vi.fn();
    render(withClient(item.mount(close)));
    await item.fill();
    const submit = () => screen.getByRole('button', { name: item.button }) as HTMLButtonElement;
    await waitFor(() => expect(submit().disabled).toBe(false));
    io.server.failNext(item.table, 'insert', 'drop-after');
    fireEvent.click(submit());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Bấm lại'));
    expect(close).not.toHaveBeenCalled();
    expect(rows(item.table)).toHaveLength(1);
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(rows(item.table)).toHaveLength(1);
    expect(sentIds(item.table)).toHaveLength(2);
    expect(new Set(sentIds(item.table)).size).toBe(1);
  });
});
