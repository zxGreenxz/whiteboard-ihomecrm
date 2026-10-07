// @vitest-environment jsdom
import {beforeEach,expect,it,vi,type Mock} from 'vitest';
import type {CT01FormData} from '@/types/customer';
interface ResidenceReply { data: unknown; error: unknown }
type ResidenceQueryMock = PromiseLike<ResidenceReply> & {
 [Method in 'select' | 'eq' | 'is' | 'order' | 'insert' | 'update' | 'upsert' | 'single' | 'maybeSingle']: Mock<() => ResidenceQueryMock>;
};

const io=vi.hoisted(()=>({from:vi.fn(),upload:vi.fn(),remove:vi.fn(),toast:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from}}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(config:unknown)=>config,useQuery:(config:unknown)=>config,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('sonner',()=>({toast:{error:io.toast,success:vi.fn()}}));
vi.mock('@/lib/storage',()=>({uploadFile:io.upload,deleteFile:io.remove,getPublicUrl:(b:string,p:string)=>b+'/'+p,parseStorageRef:(v:string)=>({path:v}),sanitizeStorageFileName:(v:string)=>v}));
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {useCreateCT01Declaration,useCT01Declarations} from '../useCT01Declarations';
import {ghiHoSoTamTru,listCustomerRegistrations} from '@/lib/residenceRegistrations';
import {listCustomerDossierFiles,listBuildingOwnershipFiles,uploadDossierFile,removeDossierFile,luuHanHopDong} from '@/lib/residenceDossierFiles';
function chain(data:unknown,error:unknown=null){const q:ResidenceQueryMock={then:(resolve,reject)=>Promise.resolve({data,error}).then(resolve,reject),select:vi.fn(()=>q),eq:vi.fn(()=>q),is:vi.fn(()=>q),order:vi.fn(()=>q),insert:vi.fn(()=>q),update:vi.fn(()=>q),upsert:vi.fn(()=>q),single:vi.fn(()=>q),maybeSingle:vi.fn(()=>q)};return q;}
beforeEach(()=>{vi.resetAllMocks();localStorage.clear();io.upload.mockResolvedValue('actor/ct01/known.jpg');});
it('required residence lists reject null instead of pretending empty',async()=>{io.from.mockReturnValue(chain(null));const declarations=useCT01Declarations('c1') as unknown as {queryFn:()=>Promise<unknown>};await expect(declarations.queryFn()).rejects.toThrow();await expect(listCustomerRegistrations('c1')).rejects.toThrow();await expect(listCustomerDossierFiles('c1')).rejects.toThrow();await expect(listBuildingOwnershipFiles('b1')).rejects.toThrow();});
it('CT01 null receipt blocks recreation after constructing another hook',async()=>{const q=chain(null);io.from.mockReturnValue(q);const input={customerId:'c1',data:{registration_authority:'',full_name:'',date_of_birth:'',gender:'',id_number:'',family_members:[]} satisfies CT01FormData};const useCreateAndRun=()=> (useCreateCT01Declaration() as unknown as {mutationFn:(v:typeof input)=>Promise<unknown>}).mutationFn(input);await expect(useCreateAndRun()).rejects.toBeInstanceOf(FinancialWorkflowError);await expect(useCreateAndRun()).rejects.toBeInstanceOf(FinancialWorkflowError);expect(q.insert).toHaveBeenCalledTimes(1);});
it('registration malformed receipt retains its ID and blocks another upsert',async()=>{const q=chain({id:'reg1',subm_code:'OTHER',procedure_code:'TAMTRU_01'});io.from.mockReturnValue(q);const input={customerId:'c1',buildingId:'b1',organizationId:'o1',submCode:'G01.899.909-260916-890028'};let failure:unknown;try{await ghiHoSoTamTru(input);}catch(error){failure=error;}expect(failure).toBeInstanceOf(FinancialWorkflowError);if(!(failure instanceof FinancialWorkflowError))throw new Error('Expected a financial workflow error');expect(failure.completed.map((v:{id:string})=>v.id)).toContain('reg1');await expect(ghiHoSoTamTru(input)).rejects.toBeInstanceOf(FinancialWorkflowError);expect(q.upsert).toHaveBeenCalledTimes(1);});
it('uploaded object is preserved on unknown insert receipt and cannot upload again',async()=>{const building=chain({organization_id:'o1',name:'A'});const count=chain([]);const insert=chain(null);let calls=0;io.from.mockImplementation((name:string)=>name==='buildings'?building:++calls===1?count:insert);const input={kind:'CT01' as const,buildingId:'b1',customerId:'c1',file:new File(['x'],'a.jpg',{type:'image/jpeg'})};let failure:unknown;try{await uploadDossierFile(input);}catch(error){failure=error;}expect(failure).toBeInstanceOf(FinancialWorkflowError);if(!(failure instanceof FinancialWorkflowError))throw new Error('Expected a financial workflow error');expect(failure.completed.map((v:{id:string})=>v.id)).toContain('actor/ct01/known.jpg');expect(io.remove).not.toHaveBeenCalled();await expect(uploadDossierFile(input)).rejects.toBeInstanceOf(FinancialWorkflowError);expect(io.upload).toHaveBeenCalledTimes(1);});
it('dossier deletion and lease dates require exact positive IDs',async()=>{io.from.mockReturnValue(chain({id:'other'}));await expect(removeDossierFile('f1')).rejects.toBeInstanceOf(FinancialWorkflowError);await expect(luuHanHopDong('f2','30/09/2026','30/09/2028')).rejects.toBeInstanceOf(FinancialWorkflowError);});

it('registration recovery releases only a matching positive read, without replaying upsert',async()=>{
 // Mỗi lượt ghi đọc trước dòng cùng mã (chặn đổi thủ tục): lượt đầu chưa có gì, lượt sau đọc thấy dòng đã ghi.
 const pre=chain(null);const write=chain(null);const read=chain({id:'reg1',organization_id:'o1',customer_id:'c1',building_id:'b1',contract_id:null,subm_code:'G01.899.909-260916-890028',receive_org:'',temp_resident_from:null,temp_resident_to:null,procedure_code:'TAMTRU_01'});io.from.mockReturnValueOnce(pre).mockReturnValueOnce(write).mockReturnValue(read);
 const input={customerId:'c1',buildingId:'b1',organizationId:'o1',submCode:'G01.899.909-260916-890028'};
 await expect(ghiHoSoTamTru(input)).rejects.toBeInstanceOf(FinancialWorkflowError);expect(await ghiHoSoTamTru(input)).toMatchObject({id:'reg1'});expect(pre.upsert).not.toHaveBeenCalled();expect(write.upsert).toHaveBeenCalledTimes(1);expect(read.upsert).not.toHaveBeenCalled();
});
