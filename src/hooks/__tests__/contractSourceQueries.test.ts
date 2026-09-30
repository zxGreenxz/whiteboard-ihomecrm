import { expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (config: unknown) => config }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: io }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn().mockResolvedValue({ email: 'staff@example.com' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
import { useBuildings } from '../useBuildings';
import { useBuildingServices } from '../useBuildingServices';
import { useAccounts } from '../useAccounts';

it.each([['tòa', () => useBuildings()], ['dịch vụ tòa', () => useBuildingServices('building-1')]])('%s không biến response null thành danh sách rỗng', async (_label, hook) => {
  const chain = { select: vi.fn(), is: vi.fn(), eq: vi.fn(), order: vi.fn().mockResolvedValue({ data: null, error: null }) };
  chain.select.mockReturnValue(chain); chain.is.mockReturnValue(chain); chain.eq.mockReturnValue(chain);
  // Building-service query awaits eq directly; make the chain thenable.
  Object.assign(chain, { then: (resolve: (value: unknown) => void) => resolve({ data: null, error: null }) });
  io.from.mockReturnValue(chain);
  await expect((hook() as unknown as { queryFn: () => Promise<unknown> }).queryFn()).rejects.toThrow('Chưa xác nhận');
});

it('sổ quỹ không biến response null thành không có sổ nhận cọc', async () => {
  const chain = { select: vi.fn(), is: vi.fn(), order: vi.fn(), not: vi.fn().mockResolvedValue({ data: null, error: null }) };
  chain.select.mockReturnValue(chain); chain.is.mockReturnValue(chain); chain.order.mockReturnValue(chain);
  io.from.mockReturnValue(chain);
  await expect((useAccounts() as unknown as { queryFn: () => Promise<unknown> }).queryFn()).rejects.toThrow('Chưa xác nhận');
});
