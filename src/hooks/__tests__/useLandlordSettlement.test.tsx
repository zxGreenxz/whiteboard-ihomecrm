// @vitest-environment jsdom
// Lớp hook quyết toán vận hành: hộp cài đặt gửi đúng tham số tiền quản lý cố định (chủ chốt 23/10/2026) và
// người giữ cọc (v3). Thiếu p_manager_fixed_amount / p_deposit_holder thì server hiểu là "giữ số cũ" ⇒ người
// dùng sửa mà không đổi gì, không lỗi — nên phải khoá bằng test. Bàn giao v3: sửa ghi chú và chủ nhà xác
// nhận gửi đúng revision; biên nhận thiếu trường là chưa xác nhận. Id / số tiền giả.
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: state.rpc } }));

import {
  landlordSettlementKeys,
  useConfirmLandlordMonth,
  useUpdateLandlordHandoverNote,
  useUpsertLandlordOperation,
} from '@/hooks/useLandlordSettlement';

const TOA = '00000000-0000-4000-8000-000000000011';
const SO = '00000000-0000-4000-8000-000000000021';
let qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

afterEach(() => { cleanup(); vi.clearAllMocks(); qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); });

it('lưu cài đặt gửi % và tiền cố định đúng tên tham số, kèm tháng đang xem', async () => {
  state.rpc.mockResolvedValue({
    data: { building_id: TOA, created: false, terms_from: '2026-11-01', opening_needs_reconfirm: false, opening_needs_confirm: false },
    error: null,
  });
  const { result } = renderHook(() => useUpsertLandlordOperation(), { wrapper });
  await result.current.mutateAsync({
    buildingId: TOA, landlordName: 'Chủ nhà A', managerPercent: 0, managerFixedAmount: 5_000_000,
    effectiveFrom: '2026-10-01', landlordAccountIds: [SO], note: null, isActive: true, openingBalance: 0,
    openingConfirmed: false, termsFrom: '2026-11-01', openingSeenPreStart: 0, expectedUpdatedAt: '2026-10-22T00:00:00Z',
    depositHolder: 'LANDLORD',
  });
  expect(state.rpc).toHaveBeenCalledWith('landlord_operation_upsert_v1', expect.objectContaining({
    p_building_id: TOA, p_manager_percent: 0, p_manager_fixed_amount: 5_000_000, p_terms_from: '2026-11-01',
    p_expected_updated_at: '2026-10-22T00:00:00Z', p_deposit_holder: 'LANDLORD',
  }));
});

it('sửa ghi chú bàn giao: gửi đúng tháng + revision; biên nhận lệch revision là chưa xác nhận', async () => {
  state.rpc.mockResolvedValue({ data: { status: 'UPDATED', revision: 3, updated_at: '2026-11-02T00:00:00Z' }, error: null });
  const { result } = renderHook(() => useUpdateLandlordHandoverNote(), { wrapper });
  await expect(result.current.mutateAsync({ buildingId: TOA, month: '2026-10-01', revision: 3, note: 'Ghi chú' }))
    .resolves.toMatchObject({ status: 'UPDATED' });
  expect(state.rpc).toHaveBeenCalledWith('landlord_settlement_note_update_v1', {
    p_building_id: TOA, p_month: '2026-10-01', p_revision: 3, p_note: 'Ghi chú',
  });
  state.rpc.mockResolvedValue({ data: { status: 'UPDATED', revision: 4, updated_at: '2026-11-02T00:00:00Z' }, error: null });
  await expect(result.current.mutateAsync({ buildingId: TOA, month: '2026-10-01', revision: 3, note: 'Ghi chú' })).rejects.toThrow();
  state.rpc.mockResolvedValue({ data: { status: 'UPDATED' }, error: null });
  await expect(result.current.mutateAsync({ buildingId: TOA, month: '2026-10-01', revision: 3, note: null })).rejects.toThrow();
});

it('chủ nhà xác nhận: gửi token + tháng + revision; lỗi 40001 vẫn nạp lại gói của link', async () => {
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  state.rpc.mockResolvedValue({ data: { status: 'CONFIRMED', confirmed_at: '2026-11-03T02:12:00Z' }, error: null });
  const { result } = renderHook(() => useConfirmLandlordMonth(), { wrapper });
  await expect(result.current.mutateAsync({ token: 'tok', month: '2026-10-01', revision: 3, note: null }))
    .resolves.toEqual({ status: 'CONFIRMED', confirmed_at: '2026-11-03T02:12:00Z' });
  expect(state.rpc).toHaveBeenCalledWith('landlord_settlement_confirm_v1', {
    p_token: 'tok', p_month: '2026-10-01', p_revision: 3, p_note: null,
  });
  state.rpc.mockResolvedValue({ data: null, error: { code: '40001', message: 'Bên quản lý vừa chốt lại tháng này' } });
  invalidate.mockClear();
  await expect(result.current.mutateAsync({ token: 'tok', month: '2026-10-01', revision: 3, note: null }))
    .rejects.toMatchObject({ code: '40001' });
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: landlordSettlementKeys.publicAll('tok') }));
  // biên nhận thiếu trường ⇒ không báo đã xác nhận
  state.rpc.mockResolvedValue({ data: { status: 'CONFIRMED' }, error: null });
  await expect(result.current.mutateAsync({ token: 'tok', month: '2026-10-01', revision: 3, note: null })).rejects.toThrow();
});
