// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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
    incomplete: false
  }} />);
  fireEvent.click(screen.getByRole('button', { name: /A · Phòng 101/ }));
  expect(open).toHaveBeenCalledOnce();
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
  expect(screen.getAllByText(/Chưa rõ ngày/)).toHaveLength(2);
  expect(h.read).toHaveBeenLastCalledWith(h.org, customer, 2);
});
it('history read failure is visible and recoverable', async () => {
  h.read.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ events: [], next_before_id: null });
  render(<CustomerResidenceHistoryDialog customerId={customer} customerName="An" open onOpenChange={() => {
  }} />, { wrapper });
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
  await waitFor(() => expect(screen.getByText('Chưa có lịch sử lưu trú trong phạm vi được phép xem.')).toBeTruthy());
});
