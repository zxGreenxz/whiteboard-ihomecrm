import type {Mock} from 'vitest';
// @vitest-environment jsdom
import {beforeEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn(),invalidate:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:h.from,rpc:h.rpc}}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'selected-b'})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(options:unknown)=>options,useQuery:vi.fn(),useQueryClient:()=>({invalidateQueries:h.invalidate})}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
import {useUpdateContract,useSyncContractCustomers,useSyncContractServices} from '../useContracts';
type Mutation={mutationFn:(input:unknown)=>Promise<unknown>};
type ReadResponse={data:unknown;error:unknown};
interface Builder {update:Mock<(...args:unknown[])=>Builder>;eq:Mock<(...args:unknown[])=>Builder>;select:Mock<(...args:unknown[])=>Builder>;delete:Mock<(...args:unknown[])=>Builder>;insert:Mock<(...args:unknown[])=>Builder>;single?:()=>Promise<ReadResponse>;then?:(resolve:(response:ReadResponse)=>unknown)=>Promise<unknown>}
let builder:Builder;
beforeEach(()=>{vi.clearAllMocks();builder={update:vi.fn(()=>builder),eq:vi.fn(()=>builder),select:vi.fn(()=>builder),delete:vi.fn(()=>builder),insert:vi.fn(()=>builder)};h.from.mockReturnValue(builder);});
it.each([null,{id:'other',rent_price:200},{id:'c1',rent_price:null}])('update receipt %s không thành saved',async row=>{builder.single=async()=>({data:row,error:null});await expect((useUpdateContract() as unknown as Mutation).mutationFn({id:'c1',updates:{rent_price:200}})).rejects.toThrow(/Chưa xác nhận/);});
it('update exact core receipt xác nhận đúng fields không chỉ ID',async()=>{builder.single=async()=>({data:{id:'c1',rent_price:200},error:null});await expect((useUpdateContract() as unknown as Mutation).mutationFn({id:'c1',updates:{rent_price:200}})).resolves.toMatchObject({id:'c1'});});
it('atomic customer receipt null never becomes done and no direct DML',async()=>{h.rpc.mockResolvedValue({data:null,error:null});const onPhase=vi.fn();await expect((useSyncContractCustomers() as unknown as Mutation).mutationFn({contractId:'c1',organizationId:'actual-a',expectedCustomers:[],customers:[{customer_id:'customer1',is_representative:true}],onPhase})).rejects.toThrow();expect(onPhase.mock.calls.flat()).toEqual(['reconciling']);expect(builder.delete).not.toHaveBeenCalled();});
it('atomic customer failure preserves original baseline and organization',async()=>{h.rpc.mockResolvedValue({data:null,error:{code:'PT409',message:'Conflict'}});const onPhase=vi.fn();const expectedCustomers=[{customer_id:'old',is_representative:true,notes:null}];await expect((useSyncContractCustomers() as unknown as Mutation).mutationFn({contractId:'c1',organizationId:'actual-a',expectedCustomers,customers:[{customer_id:'customer1',is_representative:true}],onPhase})).rejects.toMatchObject({code:'PT409'});expect(onPhase.mock.calls.flat()).toEqual(['reconciling']);expect(h.rpc).toHaveBeenCalledWith('reconcile_contract_customers_v1',expect.objectContaining({p_organization_id:'actual-a',p_expected:expectedCustomers}));expect(builder.delete).not.toHaveBeenCalled();});
// Đợt 10b: dịch vụ của hợp đồng khi sửa là MỘT hàm máy chủ thay nguyên tử (replace_contract_services_v1), pha «reconciling»
// như phần khách. Trước đợt 10b hai test dưới tên «confirmed missing insert chỉ insert, không xóa lại old rows» (skipDelete chỉ
// chèn) và «service insert receipt thiếu dòng không đánh done» (pha deleting/deleted/inserting); không còn pha xoá / chèn riêng.
it('skipDelete không còn nghĩa: vẫn MỘT lệnh thay nguyên tử, không ghi thẳng bảng; pha reconciling rồi done',async()=>{h.rpc.mockResolvedValue({data:[{id:'cs1',contract_id:'c1',service_id:'s1',unit_price:50,initial_reading:null}],error:null});const onPhase=vi.fn();await expect((useSyncContractServices() as unknown as Mutation).mutationFn({contractId:'c1',organizationId:'actual-a',services:[{service_id:'s1',unit_price:50}],skipDelete:true,onPhase})).resolves.toBeUndefined();expect(h.rpc).toHaveBeenCalledWith('replace_contract_services_v1',{p_contract_id:'c1',p_services:[{service_id:'s1',unit_price:50,initial_reading:null}]});expect(h.from).not.toHaveBeenCalled();expect(onPhase.mock.calls.flat()).toEqual(['reconciling','done']);});
it('service receipt thiếu dòng không đánh done',async()=>{h.rpc.mockResolvedValue({data:[],error:null});const onPhase=vi.fn();await expect((useSyncContractServices() as unknown as Mutation).mutationFn({contractId:'c1',organizationId:'actual-a',services:[{service_id:'s1',unit_price:50}],onPhase})).rejects.toThrow();expect(onPhase.mock.calls.flat()).toEqual(['reconciling']);});

it.each([null,false,''])('service receipt price %s cannot become the requested zero',async unit_price=>{
 h.rpc.mockResolvedValue({data:[{id:'cs1',contract_id:'c1',service_id:'s1',unit_price,initial_reading:null}],error:null});const onPhase=vi.fn();
 await expect((useSyncContractServices() as unknown as Mutation).mutationFn({contractId:'c1',organizationId:'actual-a',services:[{service_id:'s1',unit_price:0}],skipDelete:true,onPhase})).rejects.toThrow();expect(onPhase.mock.calls.flat()).toEqual(['reconciling']);
});
