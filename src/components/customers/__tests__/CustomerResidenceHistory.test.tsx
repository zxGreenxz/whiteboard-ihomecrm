// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, it, expect, vi } from 'vitest';
const h = vi.hoisted(() => ({ read: vi.fn(), summaries: vi.fn(), org: '00000000-0000-4000-8000-000000000001' }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: h.org }) }));
vi.mock('@/lib/customerResidenceHistory', async (load) => ({ ...await load<typeof import('@/lib/customerResidenceHistory')>(), readResidenceHistory: h.read, readResidenceSummaries: h.summaries }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
import { CustomerResidenceCell } from '../CustomerResidenceCell';
import { CustomerResidenceHistoryDialog } from '../CustomerResidenceHistoryDialog';
const customer = '00000000-0000-4000-8000-000000000006';
const wrapper = ({ children }: {
  children: React.ReactNode;
}) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('existing room and departure cell are keyboard-accessible history buttons; failure retries', () => {
  const open = vi.fn(), retry = vi.fn();
  const { rerender } = render(<CustomerResidenceCell onOpen={open} onRetry={retry} summary={{
    customer_id: customer,
    state: 'CURRENT',
    current_accommodations: [{
      contract_id: customer,
      building_id: customer,
      room_id: customer,
      building_name: 'A',
      room_name: '101'
    }],
    departure_date: null,
    departure_kind: null,
    incomplete: true,
    last_contract_end: null
  }} />);
  fireEvent.click(screen.getByRole('button', { name: /A · Phòng 101/ }));
  expect(open).toHaveBeenCalledOnce();
  expect(screen.queryByText('Lịch sử chưa đầy đủ')).toBeNull();
  rerender(<CustomerResidenceCell onOpen={open} onRetry={retry} error />);
  fireEvent.click(screen.getByRole('button', { name: /Thử lại/ }));
  expect(retry).toHaveBeenCalledOnce();
});
it('closed dialog never reads history; opening loads pages without dropping earlier events', async () => {
  const event = (id: number) => ({
    id,
    organization_id: h.org,
    customer_id: customer,
    contract_id: customer,
    building_id: null,
    room_id: null,
    building_name: 'A',
    room_name: '101',
    contract_number: `HD${id}`,
    kind: 'MEMBER_ADDED',
    effective_date: null,
    recorded_at: '2026-10-07T00:00:00Z',
    reason: null,
    actor_id: null,
    actor_name: null,
    incomplete: true
  });
  h.read.mockResolvedValueOnce({ events: [event(2)], next_before_id: 2 }).mockResolvedValueOnce({ events: [event(1)], next_before_id: null });
  const { rerender } = render(<CustomerResidenceHistoryDialog customerId={customer} customerName="An" open={false} onOpenChange={() => {
  }} />, { wrapper });
  expect(h.read).not.toHaveBeenCalled();
  rerender(<CustomerResidenceHistoryDialog customerId={customer} customerName="An" open onOpenChange={() => {
  }} />);
  await screen.findByText('HD2');
  fireEvent.click(screen.getByRole('button', { name: 'Tải thêm lịch sử' }));
  await screen.findByText('HD1');
  expect(screen.getByText('HD2')).toBeTruthy();
  expect(screen.getAllByText('Chưa có ngày thực hiện được ghi nhận.')).toHaveLength(2);
  expect(h.read).toHaveBeenLastCalledWith(h.org, customer, 2);
});
it('history read failure is visible and recoverable', async () => {
  h.read.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ events: [], next_before_id: null });
  render(<CustomerResidenceHistoryDialog customerId={customer} customerName="An" open onOpenChange={() => {
  }} />, { wrapper });
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
  await waitFor(() => expect(screen.getByText('Chưa có hợp đồng liên kết hoặc biến động được ghi nhận trong phạm vi được phép xem.')).toBeTruthy());
});

const contractContext = {
  contract_id: customer, contract_number: 'HD-2026-00387', status: 'ACTIVE',
  building_id: customer, room_id: customer, building_name: '1392QT', room_name: '203',
  signed_date: '2026-10-03', start_date: '2026-10-03', end_date: '2027-08-30', actual_end_date: null,
  room_segments: [],
};
const observed = {
  id: 9, organization_id: h.org, customer_id: customer, contract_id: customer,
  building_id: customer, room_id: customer, building_name: '1392QT', room_name: '203',
  contract_number: 'HD-2026-00387', kind: 'OBSERVED', effective_date: null,
  recorded_at: '2026-10-07T07:53:14Z', reason: null, actor_id: null, actor_name: null, incomplete: true,
};
it('shows known active contract dates without presenting the imported capture as an unknown stay', async () => {
  h.read.mockResolvedValueOnce({ events: [observed], next_before_id: null, contract_contexts: [contractContext] });
  render(<CustomerResidenceHistoryDialog customerId={customer} customerName="Phạm Khánh Hưng" open onOpenChange={() => {}} />, { wrapper });
  const contract = await screen.findByRole('article', { name: 'Hợp đồng HD-2026-00387' });
  expect(within(contract).getByText('Đang hiệu lực')).toBeTruthy();
  expect(within(contract).getByText('Ngày ký HĐ').nextElementSibling?.textContent).toBe('03/10/2026');
  expect(within(contract).getByText('Bắt đầu HĐ').nextElementSibling?.textContent).toBe('03/10/2026');
  expect(within(contract).getByText('Hết hạn HĐ').nextElementSibling?.textContent).toBe('30/08/2027');
  expect(screen.queryByText(/Chưa rõ ngày|Thông tin lần lưu trú này chưa đầy đủ|Ghi nhận từ dữ liệu cũ|7\/10\/2026/)).toBeNull();
  expect(screen.getByText('Hồ sơ này chưa có xác nhận ngày nhận/trả phòng riêng của khách. Các ngày trên là mốc của hợp đồng.')).toBeTruthy();
});
it('distinguishes the actual contract end from its scheduled expiry', async () => {
  h.read.mockResolvedValueOnce({ events: [observed], next_before_id: null, contract_contexts: [{ ...contractContext, status: 'TERMINATED', start_date: '2026-03-14', signed_date: '2026-03-14', end_date: '2026-06-30', actual_end_date: '2026-06-27' }] });
  render(<CustomerResidenceHistoryDialog customerId={customer} customerName="Nguyễn Dương Thanh Tùng" open onOpenChange={() => {}} />, { wrapper });
  const contract = await screen.findByRole('article');
  expect(within(contract).getByText('Hết hạn HĐ').nextElementSibling?.textContent).toBe('30/06/2026');
  expect(within(contract).getByText('Kết thúc thực tế ghi trên HĐ').nextElementSibling?.textContent).toBe('27/06/2026');
  expect(screen.queryByText(/Đã rời|Chưa rõ ngày/)).toBeNull();
});
it('merges contract context across pages and keeps actions when an older page fails and retries', async () => {
  h.read.mockResolvedValueOnce({ events: [{ ...observed, kind: 'MEMBER_ADDED', effective_date: '2026-10-03', incomplete: false }], next_before_id: 9, contract_contexts: [contractContext] })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ events: [{ ...observed, id: 8 }], next_before_id: null, contract_contexts: [contractContext] });
  render(<CustomerResidenceHistoryDialog customerId={customer} customerName="An" open onOpenChange={() => {}} />, { wrapper });
  await screen.findByText('Được thêm vào hợp đồng · 03/10/2026');
  fireEvent.click(screen.getByRole('button', { name: 'Tải thêm lịch sử' }));
  await screen.findByRole('alert');
  expect(screen.getByText('Được thêm vào hợp đồng · 03/10/2026')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(screen.getAllByRole('article', { name: 'Hợp đồng HD-2026-00387' })).toHaveLength(1);
  expect(h.read).toHaveBeenLastCalledWith(h.org, customer, 9);
});
it('labels room segments as contract records and does not invent an end for an open segment', async () => {
  h.read.mockResolvedValueOnce({ events: [], next_before_id: null, contract_contexts: [{ ...contractContext, room_segments: [
    { room_id: customer, room_name: '201', building_name: '1392QT', from_date: '2026-10-03', to_date: '2026-10-05', source_path: 'TRANSFER', trusted: true, diagnostic: null },
    { room_id: customer, room_name: '203', building_name: '1392QT', from_date: '2026-10-05', to_date: null, source_path: 'TRANSFER', trusted: true, diagnostic: null },
  ] }] });
  render(<CustomerResidenceHistoryDialog customerId={customer} customerName="An" open onOpenChange={() => {}} />, { wrapper });
  await screen.findByText('Lịch sử phòng của hợp đồng');
  expect(screen.getByText('Từ 05/10/2026 · Phòng hiện tại của HĐ')).toBeTruthy();
  expect(screen.queryByText(/Đang ở từ|Nhận phòng.*03\/10/)).toBeNull();
});
it('retains a single scoped room segment whose transfer date differs from the contract start', async () => {
  h.read.mockResolvedValueOnce({ events: [], next_before_id: null, contract_contexts: [{ ...contractContext, room_segments: [
    { room_id: customer, room_name: '203', building_name: '1392QT', from_date: '2026-10-05', to_date: null, source_path: 'TRANSFER', trusted: true, diagnostic: null },
  ] }] });
  render(<CustomerResidenceHistoryDialog customerId={customer} customerName="An" open onOpenChange={() => {}} />, { wrapper });
  await screen.findByText('Từ 05/10/2026 · Phòng hiện tại của HĐ');
  expect(screen.getByText('Bắt đầu HĐ').nextElementSibling?.textContent).toBe('03/10/2026');
});
