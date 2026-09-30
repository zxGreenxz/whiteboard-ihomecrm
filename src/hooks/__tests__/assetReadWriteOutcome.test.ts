// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (config: unknown) => config, useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: io }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn().mockResolvedValue({ id: 'user-1' }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-1' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { useAssetHandovers, useAssetMovements, useAssetMaintenance, useCreateAsset, useUpdateAsset, useCreateAssetHandover, useCreateAssetMovement, useCreateAssetMaintenance, useUpdateAssetMaintenance } from '../useAssets';

beforeEach(()=>{localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-1');});
afterEach(() => io.from.mockReset());
it.each([['bàn giao', useAssetHandovers], ['di chuyển', useAssetMovements], ['bảo trì', useAssetMaintenance]])('không coi dữ liệu %s null là chưa có bản ghi', async (_label, hook) => {
  const chain = { select: vi.fn(), order: vi.fn(), eq: vi.fn() };
  chain.select.mockReturnValue(chain); chain.order.mockReturnValue(chain); chain.eq.mockReturnValue(chain);
  Object.assign(chain, { then: (resolve: (value: unknown) => void) => resolve({ data: null, error: null }) });
  io.from.mockReturnValue(chain);
  await expect((hook() as unknown as { queryFn: () => Promise<unknown> }).queryFn()).rejects.toThrow('Chưa xác nhận');
});

it.each([
  ['tạo tài sản', useCreateAsset, { name: 'Ghế' }],
  ['sửa tài sản', useUpdateAsset, { id: 'asset-1', name: 'Ghế' }],
  ['tạo bàn giao', useCreateAssetHandover, { contract_id: 'contract-1' }],
  ['ghi di chuyển', useCreateAssetMovement, { asset_id: 'asset-1' }],
  ['tạo bảo trì', useCreateAssetMaintenance, { asset_id: 'asset-1' }],
  ['sửa bảo trì', useUpdateAssetMaintenance, { id: 'maintenance-1', status: 'DONE' }],
])('%s cần response có ID trước success', async (_label, hook, input) => {
  const chain = { insert: vi.fn(), update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: null }) };
  chain.insert.mockReturnValue(chain); chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.select.mockReturnValue(chain);
  io.from.mockReturnValue(chain);
  await expect((hook() as unknown as { mutationFn: (value: unknown) => Promise<unknown> }).mutationFn(input)).rejects.toThrow('Chưa xác nhận');
});

it.each([
 ['asset',useCreateAsset,{name:'Ghế'}],['handover',useCreateAssetHandover,{contract_id:'c1'}],['movement',useCreateAssetMovement,{asset_id:'a1'}],['maintenance',useCreateAssetMaintenance,{asset_id:'a1'}],
])('%s unknown receipt is durable and cannot be created again by a new hook',async(_name,hook,input)=>{
 const writer={insert:vi.fn(),select:vi.fn(),single:vi.fn().mockResolvedValue({data:null,error:null})};writer.insert.mockReturnValue(writer);writer.select.mockReturnValue(writer);io.from.mockReturnValue(writer);
 const mutation=()=>hook() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
 await expect(mutation().mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});await expect(mutation().mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});expect(writer.insert).toHaveBeenCalledTimes(1);
});