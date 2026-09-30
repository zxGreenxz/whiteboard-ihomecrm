// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (config: unknown) => config, useMutation: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: io }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn().mockResolvedValue({ id: 'user-1' }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-1' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { useUnrecordedMeters, useCreateMeter, useUpdateMeter, useDeleteMeter } from '../useMeters';
beforeEach(()=>{localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-1');});
afterEach(() => { io.from.mockReset(); io.rpc.mockReset(); });

it('không coi RPC công tơ chưa chốt null là không có công tơ', async () => {
  io.rpc.mockResolvedValue({ data: null, error: null });
  await expect((useUnrecordedMeters({ month: '2026-09' }) as unknown as { queryFn: () => Promise<unknown> }).queryFn()).rejects.toThrow('Chưa xác nhận');
});

it('xóa công tơ cần hàng trả về đúng ID', async () => {
  const chain = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: null }) };
  chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.select.mockReturnValue(chain); io.from.mockReturnValue(chain);
  await expect((useDeleteMeter() as unknown as { mutationFn: (id: string) => Promise<unknown> }).mutationFn('meter-1')).rejects.toThrow('Chưa xác nhận');
});

it('cập nhật công tơ cần hàng trả về đúng ID', async () => {
  const chain = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: null }) };
  chain.update.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.select.mockReturnValue(chain); io.from.mockReturnValue(chain);
  await expect((useUpdateMeter() as unknown as { mutationFn: (x: unknown) => Promise<unknown> }).mutationFn({ id: 'meter-1', updates: { code: 'CT-01' } })).rejects.toThrow('Chưa xác nhận');
});

it('tạo công tơ cần bản ghi mới được xác nhận sau khi tìm dịch vụ', async () => {
  const services = { select: vi.fn(), is: vi.fn(), order: vi.fn(), limit: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'service-1' }, error: null }) };
  services.select.mockReturnValue(services); services.is.mockReturnValue(services); services.order.mockReturnValue(services); services.limit.mockReturnValue(services); services.eq.mockReturnValue(services);
  const meter = { insert: vi.fn(), select: vi.fn(), single: vi.fn().mockResolvedValue({ data: null, error: null }) };
  meter.insert.mockReturnValue(meter); meter.select.mockReturnValue(meter);
  io.from.mockImplementation((table: string) => table === 'services' ? services : meter);
  await expect((useCreateMeter() as unknown as { mutationFn: (x: unknown) => Promise<unknown> }).mutationFn({ room_id: 'room-1', meter_type: 'ELECTRICITY', code: 'CT-01' })).rejects.toThrow('Chưa xác nhận');
});

it('missing created meter ID is durable and cannot replay after remount',async()=>{
 const service={select:vi.fn(),is:vi.fn(),order:vi.fn(),limit:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn().mockResolvedValue({data:{id:'s1'},error:null})};for(const method of ['select','is','order','limit','eq'] as const)service[method].mockReturnValue(service);
 const writer={insert:vi.fn(),select:vi.fn(),single:vi.fn().mockResolvedValue({data:null,error:null})};writer.insert.mockReturnValue(writer);writer.select.mockReturnValue(writer);io.from.mockImplementation(table=>table==='services'?service:writer);
 const input={room_id:'r1',meter_type:'ELECTRICITY',code:'CT-1'};const useMeterMutation=()=>useCreateMeter() as unknown as {mutationFn:(input:unknown)=>Promise<unknown>};
 await expect(useMeterMutation().mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});await expect(useMeterMutation().mutationFn(input)).rejects.toMatchObject({outcome:'unknown'});expect(writer.insert).toHaveBeenCalledTimes(1);
});
