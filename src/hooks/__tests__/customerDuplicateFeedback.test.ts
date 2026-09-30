import { expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org' }) }));
vi.mock('sonner', () => ({ toast: { error: io.error, success: vi.fn() } }));
import { useCreateCustomer, useUpdateCustomer } from '../useCustomers';

it.each([useCreateCustomer, useUpdateCustomer])('không đoán 23505 là trùng SĐT hoặc CCCD', (useHook) => {
  io.error.mockClear();
  const hook = useHook() as unknown as { onError: (error: unknown) => void };
  hook.onError({ code: '23505', message: 'duplicate key value violates unique constraint unknown_key' });
  const text = String(io.error.mock.lastCall?.[0]);
  expect(text).not.toMatch(/Số điện thoại|CCCD/);
  expect(text).not.toContain('unknown_key');
});
