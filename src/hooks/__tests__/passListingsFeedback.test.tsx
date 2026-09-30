// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ reply: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
 rpc: (...args: unknown[]) => io.reply(...args),
 from: () => { const q = { select: () => q, order: () => io.reply() }; return q; },
} }));
vi.mock('sonner', () => ({ toast: { error: io.error, success: io.success, info: io.info } }));
import { usePassListings, usePassListingFormRooms, usePassListingRoomCustomers, useUpsertPassListing, useSetPassListingActive, useDeletePassListing } from '../usePassListings';
import { useSetAccountingStandard } from '../useAccountingStandard';
function wrapper({ children }: { children: React.ReactNode }) {
 const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
 return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });
describe('pass source and feedback receipts', () => {
 it.each([null, {}, [null], [{}]])('requires actual list rows, never normalizes malformed %j to empty', async data => {
  io.reply.mockResolvedValue({ data, error: null });
  const hook = renderHook(() => usePassListings(), { wrapper });
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
 });
 it.each([null, {}, [null], [{}]])('requires actual scoped form rooms for %j', async data => {
  io.reply.mockResolvedValue({ data, error: null });
  const hook = renderHook(() => usePassListingFormRooms(), { wrapper });
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
 });
 it.each([null, {}, [null], [{}]])('requires actual customer rows for %j', async data => {
  io.reply.mockResolvedValue({ data, error: null });
  const hook = renderHook(() => usePassListingRoomCustomers('room-a'), { wrapper });
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
 });
 it('accepts genuinely empty rows from all three sources', async () => {
  io.reply.mockResolvedValue({ data: [], error: null });
  const hook = renderHook(() => [usePassListings(), usePassListingFormRooms(), usePassListingRoomCustomers('room-a')], { wrapper });
  await waitFor(() => expect(hook.result.current.every(query => query.isSuccess)).toBe(true));
  expect(hook.result.current.map(query => query.data)).toEqual([[], [], []]);
 });
 it.each(['upsert', 'active', 'delete'])('keeps original failure but displays one safe %s error', async operation => {
  const error = { code: '42501', message: 'permission denied PRIVATE_SCHEMA' };
  io.reply.mockResolvedValue({ data: null, error });
  const hook = renderHook(() => ({
   upsert: useUpsertPassListing(), active: useSetPassListingActive(), delete: useDeletePassListing(),
  }), { wrapper });
  let caught: unknown;
  await act(async () => { try {
   if (operation === 'upsert') await hook.result.current.upsert.mutateAsync({ roomId: 'room-a' });
   else if (operation === 'active') await hook.result.current.active.mutateAsync({ id: 'pass-a', active: false });
   else await hook.result.current.delete.mutateAsync('pass-a');
  } catch (failure) { caught = failure; } });
  expect(caught).toBe(error);
  expect(io.error).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(io.error.mock.calls)).not.toContain('PRIVATE_SCHEMA');
  expect(io.success).not.toHaveBeenCalled();
 });
 it.each([null, { id: 'wrong', room_id: 'room-a' }, { id: 'pass-a', room_id: 'room-b' }])('does not announce an unconfirmed upsert %j', async data => {
  io.reply.mockResolvedValue({ data, error: null });
  const hook = renderHook(() => useUpsertPassListing(), { wrapper });
  await act(async () => { await expect(hook.result.current.mutateAsync({ id: 'pass-a', roomId: 'room-a' })).rejects.toBeTruthy(); });
  expect(io.success).not.toHaveBeenCalled();
 });
 it.each([null, { id: 'pass-b', active: false }, { id: 'pass-a', active: true }])('requires the affected listing and actual active value %j', async data => {
  io.reply.mockResolvedValue({ data, error: null });
  const hook = renderHook(() => useSetPassListingActive(), { wrapper });
  await act(async () => { await expect(hook.result.current.mutateAsync({ id: 'pass-a', active: false })).rejects.toBeTruthy(); });
  expect(io.success).not.toHaveBeenCalled();
 });
 it('accepts matching positive upsert and visibility receipts', async () => {
  io.reply.mockResolvedValueOnce({ data: { id: 'pass-a', room_id: 'room-a', contact_name: null, contact_phone: null, sale_policy: null, pass_price: null, avail_date: null, active: true, contact_manager: false }, error: null });
  const hook = renderHook(() => ({ upsert: useUpsertPassListing(), active: useSetPassListingActive() }), { wrapper });
  await act(async () => { await hook.result.current.upsert.mutateAsync({ roomId: 'room-a' }); });
  expect(io.success).toHaveBeenCalledWith('Đã lưu phòng khách nhờ sale');
  io.reply.mockResolvedValueOnce({ data: { id: 'pass-a', active: false }, error: null });
  await act(async () => { await hook.result.current.active.mutateAsync({ id: 'pass-a', active: false }); });
  expect(io.success).toHaveBeenCalledWith('Đã ẩn khỏi trang công khai');
 });
 it.each([true, false])('uses understandable accounting success wording strict=%s', async strict => {
  io.reply.mockResolvedValue({ data: { organization_id: 'org-a', strict_mode: strict, changed: true }, error: null });
  const hook = renderHook(() => useSetAccountingStandard(), { wrapper });
  await act(async () => { await hook.result.current.mutateAsync({ organizationId: 'org-a', strict }); });
  expect(io.success).toHaveBeenCalledWith(strict ? 'Đã bật chế độ Chuẩn kế toán.' : 'Đã tắt chế độ Chuẩn kế toán.');
 });
 it('reports an unchanged accounting receipt as neutral information', async () => {
  io.reply.mockResolvedValue({ data: { organization_id: 'org-a', strict_mode: true, changed: false }, error: null });
  const hook = renderHook(() => useSetAccountingStandard(), { wrapper });
  await act(async () => { await hook.result.current.mutateAsync({ organizationId: 'org-a', strict: true }); });
  expect(io.info).toHaveBeenCalledWith('Chuẩn kế toán không thay đổi');
  expect(io.success).not.toHaveBeenCalled();
 });
});
