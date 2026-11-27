// @vitest-environment jsdom
// Đợt 7: hết phiên khi sửa hợp đồng là TỪ CHỐI RÕ (chưa gửi gì), để kho dấu sửa hợp đồng gỡ dấu thay vì giữ pha «đang gửi».
import { renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: h.from } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => null }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (options: unknown) => options, useQuery: vi.fn(), useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { useUpdateContract } from '../useContracts';
import { isConfirmedFinancialRejection } from '@/lib/financialWorkflow';

it('hết phiên: ném PGRST301 (từ chối rõ), không gửi lệnh sửa nào', async () => {
  const update = renderHook(() => useUpdateContract()).result.current as unknown as { mutationFn: (input: unknown) => Promise<unknown> };
  const error = await update.mutationFn({ id: 'c1', updates: { rent_price: 200 } }).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: 'PGRST301' });
  expect(isConfirmedFinancialRejection(error)).toBe(true);
  expect(h.from).not.toHaveBeenCalled();
});
