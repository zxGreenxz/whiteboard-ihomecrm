import { expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: io.error } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { useDossierFileMutations } from '../useResidenceDossierFiles';
import { useGhiHoSoTamTru } from '../useResidenceRegistrations';

it('lỗi storage không xác định không lộ message thô trong hồ sơ', () => {
  const hooks = useDossierFileMutations({ customerId: 'u1', buildingId: 'b1' });
  (hooks.upload as unknown as { onError: (error: Error) => void }).onError(new Error('StorageServiceError bucket SQL secret'));
  expect(String(io.error.mock.lastCall?.[0])).not.toContain('StorageServiceError');
});

it('lỗi ghi mã không xác định không lộ message thô', () => {
  const hook = useGhiHoSoTamTru('u1') as unknown as { onError: (error: Error) => void };
  hook.onError(new Error('DB raw detail'));
  expect(String(io.error.mock.lastCall?.[0])).not.toContain('DB raw detail');
});
