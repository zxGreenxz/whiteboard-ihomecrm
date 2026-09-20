// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SettlementSourceRow } from '@/lib/contractSettlement';
const m = vi.hoisted(() => ({ input: null as unknown, eventInput: null as unknown, rows: [] as SettlementSourceRow[], refresh: vi.fn(), eventRefresh: vi.fn(), fetching: false, error: null as string | null }));
vi.mock('@/hooks/useContractSettlement', () => ({ useContractSettlement: (scope: unknown) => {
  m.input = scope;
  return { rows: m.rows, loading: false, fetching: m.fetching, error: m.error, partial: false, pagination: { complete: true }, refresh: m.refresh };
} }));
vi.mock('@/hooks/useContractSettlementEvents', () => ({ useContractSettlementEvents: (scope: unknown) => {
  m.eventInput = scope;
  return { rows: [], complete: true, loading: false, fetching: false, error: null, refresh: m.eventRefresh };
} }));
import { ContractSettlementSection, type SettlementDetailContext } from '../ContractSettlementSection';
const source: SettlementSourceRow = {
  rowType: 'source', rowKey: 'source:a', settlementKind: 'commission',
  sourceRef: { kind: 'broker', organizationId: 'org', contractId: 'a' },
  organizationId: 'org', buildingId: 'building', roomId: 'room', roomName: '101', contractId: 'a', contractNumber: 'HD-A', customerName: 'Nguyễn Ánh',
  eventDate: '2026-08-10', recipient: { name: 'Sale A', bankName: null, bankAccount: null },
  basis: { kind: 'COMMISSION', status: 'AVAILABLE', amount: 2000000, measuredAt: null, source: 'tier', fingerprint: null, version: null, warning: null },
  createEligibility: { state: 'unavailable', reasonCodes: ['ADAPTER_REQUIRED'] },
};
const props = { scope: { organizationId: 'org', actorId: 'actor', scopeRevision: 'r1', buildingIds: ['building'] }, buildings: [{ id: 'building', name: '417LVT' }], period: '2026-09', onPeriodChange: vi.fn() };
let detail: SettlementDetailContext | null;
const renderDetail = (context: SettlementDetailContext) => { detail = context; return <div role="dialog">{JSON.stringify(context.selection)}</div>; };
beforeEach(() => { m.rows = [source]; m.fetching = false; m.error = null; detail = null; m.refresh.mockReset().mockResolvedValue(undefined); m.eventRefresh.mockReset().mockResolvedValue(undefined); });
afterEach(cleanup);
it('loads all periods, keeps payment filters across tabs and retains selected identity across refresh', () => {
  const view = render(<ContractSettlementSection {...props} renderDetail={renderDetail} />);
  expect(m.input).toMatchObject({ ...props.scope, mode: 'all', dateBasis: 'business', filters: { period: '2026-09' } });
  const search = screen.getByRole('textbox', { name: 'Tìm khoản chi' });
  fireEvent.change(search, { target: { value: 'Ánh' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Biến động' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Khoản chi' }));
  expect((screen.getByRole('textbox', { name: 'Tìm khoản chi' }) as HTMLInputElement).value).toBe('Ánh');
  fireEvent.click(screen.getByRole('button', { name: 'Xem nguồn HD-A' }));
  const selected = detail!.selection;
  m.rows = [];
  view.rerender(<ContractSettlementSection {...props} period="2026-10" renderDetail={renderDetail} />);
  expect(detail!.selection).toEqual(selected);
  expect(detail!.row).toBeUndefined();
});
it('clears selection and filters when authority scope changes', () => {
  const view = render(<ContractSettlementSection {...props} renderDetail={renderDetail} />);
  fireEvent.click(screen.getByRole('button', { name: 'Xem nguồn HD-A' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  view.rerender(<ContractSettlementSection {...props} scope={{ ...props.scope, actorId: 'another' }} renderDetail={renderDetail} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(m.input).toMatchObject({ actorId: 'another' });
});
it('reports a rejected refresh without swallowing failure for action callers', async () => {
  m.refresh.mockRejectedValue(new Error('backend detail')); m.error = 'Chưa đọc đủ dữ liệu';
  render(<ContractSettlementSection {...props} renderDetail={renderDetail} />);
  fireEvent.click(screen.getByRole('button', { name: 'Xem nguồn HD-A' }));
  await expect(detail!.refreshRequired()).rejects.toThrow();
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
  await waitFor(() => expect(screen.getByText(/Chưa tải lại đầy đủ/)).toBeTruthy());
  expect(screen.queryByText('backend detail')).toBeNull();
});

