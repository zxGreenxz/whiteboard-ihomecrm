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
it('confirmed missing insert chỉ insert, không xóa lại old rows',async()=>{builder.then=(resolve:(response:ReadResponse)=>unknown)=>Promise.resolve({data:[{service_id:'s1',unit_price:50,initial_reading:null}],error:null}).then(resolve);const onPhase=vi.fn();await expect((useSyncContractServices() as unknown as Mutation).mutationFn({contractId:'c1',organizationId:'actual-a',services:[{service_id:'s1',unit_price:50}],skipDelete:true,onPhase})).resolves.toBeUndefined();expect(builder.delete).not.toHaveBeenCalled();expect(onPhase.mock.calls.flat()).toEqual(['inserting','done']);});
it('service insert receipt thiếu dòng không đánh done',async()=>{builder.then=(resolve:(response:ReadResponse)=>unknown)=>Promise.resolve({data:[],error:null}).then(resolve);const onPhase=vi.fn();await expect((useSyncContractServices() as unknown as Mutation).mutationFn({contractId:'c1',organizationId:'actual-a',services:[{service_id:'s1',unit_price:50}],onPhase})).rejects.toThrow();expect(onPhase.mock.calls.flat()).toEqual(['deleting','deleted','inserting']);});

it.each([null,false,''])('service receipt price %s cannot become the requested zero',async unit_price=>{
 builder.then=(resolve:(response:ReadResponse)=>unknown)=>Promise.resolve({data:[{service_id:'s1',unit_price,initial_reading:null}],error:null}).then(resolve);const onPhase=vi.fn();
 await expect((useSyncContractServices() as unknown as Mutation).mutationFn({contractId:'c1',organizationId:'actual-a',services:[{service_id:'s1',unit_price:0}],skipDelete:true,onPhase})).rejects.toThrow();expect(onPhase.mock.calls.flat()).toEqual(['inserting']);
});
