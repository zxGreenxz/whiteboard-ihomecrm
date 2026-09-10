import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const database = vi.hoisted(() => ({ single: vi.fn(), in: vi.fn(), from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: database.from } }));
import { storageUploadMetadata } from '../storageOrganization';
import { setWorkingOrganization, syncWorkingOrganizationUser } from '../workingOrganization';
const orgA = 'dddd0000-0000-4000-8000-000000000001';
const orgB = 'cccc0000-0000-4000-8000-000000000001';
beforeEach(() => {
  vi.clearAllMocks();
  syncWorkingOrganizationUser(null);
  database.from.mockReturnValue({ select: () => ({ eq: () => ({ single: database.single }), in: database.in }) });
});
afterEach(() => syncWorkingOrganizationUser(null));
it('requires a company for new private uploads while unrelated buckets remain unchanged', async () => {
  await expect(storageUploadMetadata('income-expense-attachments')).rejects.toThrow('chọn công ty');
  expect(await storageUploadMetadata('avatars')).toBeUndefined();
  setWorkingOrganization('fixture', orgA);
  expect(await storageUploadMetadata('payment-receipts')).toEqual({ ihomecrm_organization_id: orgA });
  expect(database.from).not.toHaveBeenCalled();
});
it('uses the parent company despite another selected company and never falls back after lookup failure', async () => {
  setWorkingOrganization('fixture', orgB);
  database.single.mockResolvedValue({ data: { organization_id: orgA }, error: null });
  const source = { table: 'income_expenses', id: 'voucher' } as const;
  expect(await storageUploadMetadata('income-expense-attachments', source)).toEqual({ ihomecrm_organization_id: orgA });
  expect(database.from).toHaveBeenCalledWith('income_expenses');
  database.single.mockResolvedValue({ data: null, error: new Error('permission denied') });
  await expect(storageUploadMetadata('income-expense-attachments', source)).rejects.toThrow('permission denied');
  await expect(storageUploadMetadata('payment-receipts', { organizationId: null })).rejects.toThrow('chưa có công ty');
});
it('shared batch images require every selected parent to exist in the same company', async () => {
  const source = { table: 'buildings', ids: ['one', 'two'] } as const;
  const check = () => storageUploadMetadata('payment-receipts', { ...source, ids: [...source.ids] });
  database.in.mockResolvedValue({ data: [{ id: 'one', organization_id: orgA }, { id: 'two', organization_id: orgB }], error: null });
  await expect(check()).rejects.toThrow('cùng một công ty');
  database.in.mockResolvedValue({ data: [{ id: 'one', organization_id: orgA }], error: null });
  await expect(check()).rejects.toThrow('cùng một công ty');
  database.in.mockResolvedValue({ data: source.ids.map(id => ({ id, organization_id: orgA })), error: null });
  expect(await check()).toEqual({ ihomecrm_organization_id: orgA });
});
