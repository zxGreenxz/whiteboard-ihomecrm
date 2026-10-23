// @vitest-environment jsdom
// Lớp hook quyết toán vận hành: hộp cài đặt gửi đúng tham số tiền quản lý cố định (chủ chốt 23/10/2026).
// Thiếu p_manager_fixed_amount thì server hiểu là "giữ số cũ" ⇒ người dùng sửa mà không đổi gì, không lỗi —
// nên phải khoá bằng test. Id / số tiền giả.
import { cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: state.rpc } }));

import { useUpsertLandlordOperation } from '@/hooks/useLandlordSettlement';

const TOA = '00000000-0000-4000-8000-000000000011';
const SO = '00000000-0000-4000-8000-000000000021';
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>
);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

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
  });
  expect(state.rpc).toHaveBeenCalledWith('landlord_operation_upsert_v1', expect.objectContaining({
    p_building_id: TOA, p_manager_percent: 0, p_manager_fixed_amount: 5_000_000, p_terms_from: '2026-11-01',
    p_expected_updated_at: '2026-10-22T00:00:00Z',
  }));
});
