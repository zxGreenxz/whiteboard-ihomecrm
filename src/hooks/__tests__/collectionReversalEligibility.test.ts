import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (o: unknown) => o, useMutation: (o: unknown) => o, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: m.rpc, from: vi.fn() } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org1' }) }));
// useQuery được mock thành hàm trả options, nên gọi ngoài component chỉ để lấy queryFn.
import { useCollectionReversalEligibility as eligibilityOptions } from '../useDeletePayment';

const read = () => (eligibilityOptions(['c1', 'c2']) as unknown as { queryFn: () => Promise<unknown> }).queryFn();
beforeEach(() => m.rpc.mockReset());

// Hoá đơn có 2 lần thu: lần cũ trả BLOCKED/NOT_LIFO — đúng payload prod 01/10/2026.
// Trước đây mã này làm cả hộp "các lần thanh toán và tiền cọc" báo lỗi.
it.each(['NOT_LIFO', 'NOT_COLLECTOR', 'CREDIT_USED'])('đọc được mã chặn %s mà server trả', async code => {
  m.rpc.mockResolvedValue({ data: [{ collection_id: 'c1', mode: 'BLOCKED', reason_code: code }, { collection_id: 'c2', mode: 'IN_PLACE_CANCEL', reason_code: null }], error: null });
  await expect(read()).resolves.toEqual({
    c1: { collection_id: 'c1', mode: 'BLOCKED', reason_code: code },
    c2: { collection_id: 'c2', mode: 'IN_PLACE_CANCEL', reason_code: null },
  });
});

it('mã chặn không có trong hợp đồng vẫn là phản hồi chưa xác nhận', async () => {
  m.rpc.mockResolvedValue({ data: [{ collection_id: 'c1', mode: 'BLOCKED', reason_code: 'SOMETHING_NEW' }], error: null });
  await expect(read()).rejects.toThrow('Chưa đọc được điều kiện hoàn tác');
});
