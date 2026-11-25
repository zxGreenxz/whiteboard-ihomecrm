// @vitest-environment jsdom
import {beforeEach,expect,it,vi,type Mock} from 'vitest';
import type {CT01FormData} from '@/types/customer';
interface ResidenceReply { data: unknown; error: unknown }
type ResidenceQueryMock = PromiseLike<ResidenceReply> & {
 [Method in 'select' | 'eq' | 'is' | 'gte' | 'order' | 'insert' | 'update' | 'upsert' | 'single' | 'maybeSingle']: Mock<() => ResidenceQueryMock>;
};

const io=vi.hoisted(()=>({from:vi.fn(),upload:vi.fn(),remove:vi.fn(),toast:vi.fn()}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-a'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from}}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
vi.mock('@tanstack/react-query',()=>({useMutation:(config:unknown)=>config,useQuery:(config:unknown)=>config,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('sonner',()=>({toast:{error:io.toast,success:vi.fn()}}));
vi.mock('@/lib/storage',()=>({uploadFile:io.upload,deleteFile:io.remove,getPublicUrl:(b:string,p:string)=>b+'/'+p,parseStorageRef:(v:string)=>({path:v}),sanitizeStorageFileName:(v:string)=>v}));
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {forgetUnconfirmedCt01,useCreateCT01Declaration,useCT01Declarations} from '../useCT01Declarations';
import {ghiHoSoTamTru,listCustomerRegistrations} from '@/lib/residenceRegistrations';
import {listCustomerDossierFiles,listBuildingOwnershipFiles,uploadDossierFile,removeDossierFile,luuHanHopDong} from '@/lib/residenceDossierFiles';
function chain(data:unknown,error:unknown=null){const q:ResidenceQueryMock={then:(resolve,reject)=>Promise.resolve({data,error}).then(resolve,reject),select:vi.fn(()=>q),eq:vi.fn(()=>q),is:vi.fn(()=>q),gte:vi.fn(()=>q),order:vi.fn(()=>q),insert:vi.fn(()=>q),update:vi.fn(()=>q),upsert:vi.fn(()=>q),single:vi.fn(()=>q),maybeSingle:vi.fn(()=>q)};return q;}
beforeEach(()=>{vi.resetAllMocks();localStorage.clear();forgetUnconfirmedCt01();io.upload.mockResolvedValue('actor/ct01/known.jpg');});
it('required residence lists reject null instead of pretending empty',async()=>{io.from.mockReturnValue(chain(null));const declarations=useCT01Declarations('c1') as unknown as {queryFn:()=>Promise<unknown>};await expect(declarations.queryFn()).rejects.toThrow();await expect(listCustomerRegistrations('c1')).rejects.toThrow();await expect(listCustomerDossierFiles('c1')).rejects.toThrow();await expect(listBuildingOwnershipFiles('b1')).rejects.toThrow();});
// Đợt 7 (luật 5, cách D): CT01 không giữ dấu; lần lưu sau gửi lại ĐÚNG mã tờ khai do trình duyệt sinh (khoá chính chặn bản thứ hai).
it('CT01 null receipt: lần lưu sau gửi lại đúng mã tờ khai, không giữ dấu chờ đối chiếu',async()=>{const q=chain(null);io.from.mockReturnValue(q);const input={customerId:'c1',data:{registration_authority:'',full_name:'',date_of_birth:'',gender:'',id_number:'',family_members:[]} satisfies CT01FormData};const createAndRun=()=> (useCreateCT01Declaration() as unknown as {mutationFn:(v:typeof input)=>Promise<unknown>}).mutationFn(input);await expect(createAndRun()).rejects.toMatchObject({outcome:'unknown'});await expect(createAndRun()).rejects.toMatchObject({outcome:'unknown'});expect(q.insert).toHaveBeenCalledTimes(2);const ids=q.insert.mock.calls.map(call=>(call as unknown as [{id:string}])[0].id);expect(ids[0]).toBeTruthy();expect(ids[1]).toBe(ids[0]);expect(Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'))).toEqual([]);});
// Đợt 7 (luật 5, cách A): hồ sơ tạm trú ghi theo mã hồ sơ (upsert), không giữ dấu; lưu lại ghi đè đúng dòng đó.
it('registration malformed receipt báo mã vừa ghi, không giữ dấu; lần lưu sau ghi lại theo mã hồ sơ',async()=>{const q=chain({id:'reg1',subm_code:'OTHER',procedure_code:'TAMTRU_01'});io.from.mockReturnValue(q);const input={customerId:'c1',buildingId:'b1',organizationId:'o1',submCode:'G01.899.909-260916-890028'};let failure:unknown;try{await ghiHoSoTamTru(input);}catch(error){failure=error;}expect(failure).toBeInstanceOf(FinancialWorkflowError);if(!(failure instanceof FinancialWorkflowError))throw new Error('Expected a financial workflow error');expect(failure.completed.map((v:{id:string})=>v.id)).toContain('reg1');await expect(ghiHoSoTamTru(input)).rejects.toBeInstanceOf(FinancialWorkflowError);expect(q.upsert).toHaveBeenCalledTimes(2);expect(q.upsert.mock.calls[1]).toEqual(q.upsert.mock.calls[0].map((value,index)=>index===0?{...(value as object),submitted_at:expect.any(String)}:value));expect(Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'))).toEqual([]);});
it('uploaded object is preserved on unknown insert receipt; another upload needs a positive server read first',async()=>{const building=chain({organization_id:'o1',name:'A'});const count=chain([]);const insert=chain(null);let calls=0;io.from.mockImplementation((name:string)=>name==='buildings'?building:++calls===1?count:insert);const input={kind:'CT01' as const,buildingId:'b1',customerId:'c1',file:new File(['x'],'a.jpg',{type:'image/jpeg'})};let failure:unknown;try{await uploadDossierFile(input);}catch(error){failure=error;}expect(failure).toBeInstanceOf(FinancialWorkflowError);if(!(failure instanceof FinancialWorkflowError))throw new Error('Expected a financial workflow error');expect(failure.completed.map((v:{id:string})=>v.id)).toContain('actor/ct01/known.jpg');expect(io.remove).not.toHaveBeenCalled();
 // Đọc lại máy chủ hụt (không ra danh sách): giữ dấu, không gửi lại mù.
 await expect(uploadDossierFile(input)).rejects.toThrow(/lần tải trước/);expect(io.upload).toHaveBeenCalledTimes(1);
 // Đọc được (kể cả chưa có dòng nào) là kết quả lần trước đã rõ: lần này mới được tải.
 const read=chain([]);const saved=chain({id:'f1',object_name:'actor/ct01/known.jpg',bucket_id:'residence-docs'});const after=[count,read,saved];let step=0;io.from.mockImplementation((name:string)=>name==='buildings'?building:after[Math.min(step++,2)]);
 await expect(uploadDossierFile(input)).resolves.toMatchObject({id:'f1'});expect(read.eq).toHaveBeenCalledWith('created_by','actor');expect(read.eq).toHaveBeenCalledWith('customer_id','c1');expect(io.upload).toHaveBeenCalledTimes(2);expect(Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'))).toEqual([]);});
it('dossier deletion and lease dates require exact positive IDs',async()=>{io.from.mockReturnValue(chain({id:'other'}));await expect(removeDossierFile('f1')).rejects.toBeInstanceOf(FinancialWorkflowError);await expect(luuHanHopDong('f2','30/09/2026','30/09/2028')).rejects.toBeInstanceOf(FinancialWorkflowError);});

it('registration: lần chưa rõ kết quả rồi lưu lại ghi đè đúng mã hồ sơ (một dòng), dấu bản trước của mã đó được gỡ',async()=>{
 // Mỗi lượt ghi đọc trước dòng cùng mã (chặn đổi thủ tục). Lượt đầu ghi mà không có biên nhận; lượt sau ghi lại và nhận dòng.
 const saved={id:'reg1',organization_id:'o1',customer_id:'c1',building_id:'b1',contract_id:null,subm_code:'G01.899.909-260916-890028',receive_org:'',temp_resident_from:null,temp_resident_to:null,procedure_code:'TAMTRU_01'};
 const pre=chain(null);const write=chain(null);const pre2=chain({procedure_code:'TAMTRU_01'});const write2=chain(saved);io.from.mockReturnValueOnce(pre).mockReturnValueOnce(write).mockReturnValueOnce(pre2).mockReturnValueOnce(write2);
 const marker='ihome:financial-pending:v1:'+['residence-registration-save','actor','o1','G01.899.909-260916-890028'].map(encodeURIComponent).join(':');
 localStorage.setItem(marker,JSON.stringify({namespace:'residence-registration-save',userId:'actor',organizationId:'o1',businessKey:'G01.899.909-260916-890028',attemptId:'legacy',requestKey:'legacy',completedIds:[],startedAt:new Date(Date.now()-10*60_000).toISOString()}));
 const input={customerId:'c1',buildingId:'b1',organizationId:'o1',submCode:'G01.899.909-260916-890028'};
 await expect(ghiHoSoTamTru(input)).rejects.toBeInstanceOf(FinancialWorkflowError);
 expect(await ghiHoSoTamTru(input)).toMatchObject({id:'reg1'});
 expect(write.upsert).toHaveBeenCalledTimes(1);expect(write2.upsert).toHaveBeenCalledTimes(1);expect(write2.upsert.mock.calls[0][1]).toEqual({onConflict:'organization_id,subm_code'});
 expect(localStorage.getItem(marker)).toBeNull();
});
