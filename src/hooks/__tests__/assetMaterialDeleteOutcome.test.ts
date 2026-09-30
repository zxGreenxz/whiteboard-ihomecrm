import { afterEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (config: unknown) => config, useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: io.from } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { useDeleteAsset } from '../useAssets';
import { useSoftDeleteMaterial } from '../useMaterials';
import { useCreateMaterialCategory, useUpdateMaterialCategory, useDeleteMaterialCategory, useMaterialCategories } from '../useMaterialCategories';
import { useDeleteMaterialPurchase } from '../useMaterialPurchases';
import { useDeleteMaterialAdjustment } from '../useMaterialAdjustments';
import { useDeleteBuilding } from '../useBuildings';
import { useDeleteService, useDeleteServiceQuota } from '../useServices';

afterEach(() => io.from.mockReset());
type DeleteHook = { mutationFn: (id: string) => Promise<unknown> };
const missingRow = { data: null, error: null };

it('không báo xóa tài sản thành công khi update không ảnh hưởng hàng nào', async () => {
  const chain = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue(missingRow) };
  chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.select.mockReturnValue(chain);
  io.from.mockReturnValue(chain);
  await expect((useDeleteAsset() as unknown as DeleteHook).mutationFn('asset-1')).rejects.toThrow('Chưa xác nhận');
  expect(chain.select).toHaveBeenCalledWith('id');
});

it('không báo xóa vật tư thành công khi update không ảnh hưởng hàng nào', async () => {
  const chain = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue(missingRow) };
  chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.select.mockReturnValue(chain);
  io.from.mockReturnValue(chain);
  await expect((useSoftDeleteMaterial() as unknown as DeleteHook).mutationFn('material-1')).rejects.toThrow('Chưa xác nhận');
});

it('không báo xóa danh mục thành công khi delete không ảnh hưởng hàng nào', async () => {
  const check = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), limit: vi.fn().mockResolvedValue({ data: [], error: null }) };
  check.select.mockReturnValue(check); check.eq.mockReturnValue(check); check.is.mockReturnValue(check);
  const deletion = { delete: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue(missingRow) };
  deletion.delete.mockReturnValue(deletion); deletion.eq.mockReturnValue(deletion); deletion.select.mockReturnValue(deletion);
  io.from.mockImplementation((table: string) => table === 'materials' ? check : deletion);
  await expect((useDeleteMaterialCategory() as unknown as DeleteHook).mutationFn('category-1')).rejects.toThrow('Chưa xác nhận');
});

it('không coi danh mục vật tư null là danh sách rỗng', async () => {
  const chain = { select: vi.fn(), order: vi.fn().mockResolvedValue({ data: null, error: null }) };
  chain.select.mockReturnValue(chain); io.from.mockReturnValue(chain);
  await expect((useMaterialCategories() as unknown as { queryFn: () => Promise<unknown> }).queryFn()).rejects.toThrow('Chưa xác nhận');
});

it('không xóa danh mục khi chưa xác nhận được vật tư đang sử dụng', async () => {
  const check = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), limit: vi.fn().mockResolvedValue({ data: null, error: null }), delete: vi.fn().mockReturnValue({eq:vi.fn()}) };
  check.select.mockReturnValue(check); check.eq.mockReturnValue(check); check.is.mockReturnValue(check);
  io.from.mockReturnValue(check);
  await expect((useDeleteMaterialCategory() as unknown as DeleteHook).mutationFn('category-1')).rejects.toThrow('Chưa xác nhận');
});

it.each([['tạo', useCreateMaterialCategory], ['sửa', useUpdateMaterialCategory]])('không báo %s danh mục khi server trả null', async (_label, hook) => {
  const chain = { insert: vi.fn(), update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: null }) };
  chain.insert.mockReturnValue(chain); chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.select.mockReturnValue(chain);
  io.from.mockReturnValue(chain);
  const input = _label === 'tạo' ? { name: 'Nội thất' } : { id: 'category-1', updates: { name: 'Nội thất' } };
  await expect((hook() as unknown as { mutationFn: (value: unknown) => Promise<unknown> }).mutationFn(input)).rejects.toThrow('Chưa xác nhận');
});

it.each([
  ['phiếu nhập', useDeleteMaterialPurchase],
  ['phiếu kiểm kê', useDeleteMaterialAdjustment],
])('không báo xóa %s thành công khi delete không ảnh hưởng hàng nào', async (_label, useDelete) => {
  const chain = { delete: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue(missingRow) };
  chain.delete.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.select.mockReturnValue(chain);
  io.from.mockReturnValue(chain);
  await expect((useDelete() as unknown as DeleteHook).mutationFn('voucher-1')).rejects.toThrow('Chưa xác nhận');
});

it('không báo xóa tòa thành công khi update không ảnh hưởng hàng nào', async () => {
  const rooms = { select: vi.fn(), eq: vi.fn(), is: vi.fn().mockResolvedValue({ data: [], error: null }) };
  rooms.select.mockReturnValue(rooms); rooms.eq.mockReturnValue(rooms);
  const building = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue(missingRow) };
  building.update.mockReturnValue(building); building.eq.mockReturnValue(building); building.select.mockReturnValue(building);
  io.from.mockImplementation((table: string) => table === 'rooms' ? rooms : building);
  await expect((useDeleteBuilding() as unknown as DeleteHook).mutationFn('building-1')).rejects.toThrow('Chưa xác nhận');
});

it.each([
  ['dịch vụ', useDeleteService],
  ['định mức', useDeleteServiceQuota],
])('không báo xóa %s thành công khi update không ảnh hưởng hàng nào', async (_label, useDelete) => {
  const chain = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue(missingRow) };
  chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.select.mockReturnValue(chain);
  io.from.mockReturnValue(chain);
  await expect((useDelete() as unknown as DeleteHook).mutationFn('service-1')).rejects.toThrow('Chưa xác nhận');
});
