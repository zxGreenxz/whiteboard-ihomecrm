import {FinancialWorkflowError,isConfirmedFinancialRejection,type FinancialWorkflowGuard,type FinancialWorkflowProgress} from './financialWorkflow';
import {confirmedRecordId} from './recordWriteOutcome';
export interface LeadConversionProgress {
  tenantId?: string;
  depositId?: string;
}

/** Persist each confirmed write so a later retry resumes instead of inserting duplicates. */
export async function continueLeadConversion(
  initial: LeadConversionProgress,
  steps: {
    createTenant: () => Promise<string>;
    createDeposit: (tenantId: string) => Promise<string>;
    markLead: () => Promise<unknown>;
  },
  onProgress: (progress: LeadConversionProgress) => void = () => {},
  workflow?: LeadConversionWorkflowOptions,
): Promise<LeadConversionProgress> {
  if(workflow)return runDurableConversion(initial,steps,onProgress,workflow);
  let progress = { ...initial };
  if (!progress.tenantId) {
    const tenantId = await steps.createTenant();
    if (!tenantId) throw new Error('Không nhận được mã khách hàng đã tạo');
    progress = { ...progress, tenantId };
    onProgress(progress);
  }
  const selectedTenantId=progress.tenantId;
  if(!selectedTenantId)throw new Error('Chưa nhận được mã khách thuê');
  if (!progress.depositId) {
    const depositId = await steps.createDeposit(selectedTenantId);
    if (!depositId) throw new Error('Không nhận được mã phiếu đặt cọc đã tạo');
    progress = { ...progress, depositId };
    onProgress(progress);
  }
  await steps.markLead();
  return progress;
}

export interface LeadConversionWorkflowOptions {
 guard:FinancialWorkflowGuard;leadId:string;organizationId:string;
 readTenant:(id:string)=>Promise<unknown>;readDeposit:(id:string)=>Promise<unknown>;readLead:()=>Promise<unknown>;
 validateDeposit?:(row:Record<string,unknown>)=>boolean;
}
export interface LeadConversionTrace extends LeadConversionProgress {leadId:string;stage:'tenant'|'deposit'|'lead'|'complete';canResume:boolean}
const traceKey=(requestKey:string)=>`ihome:lead-conversion-trace:v1:${requestKey}`;
function rememberTrace(requestKey:string,trace:LeadConversionTrace){
 try{localStorage.setItem(traceKey(requestKey),JSON.stringify(trace));}
 catch{throw new FinancialWorkflowError('Chưa lưu được tiến độ chuyển khách hẹn trong trình duyệt. Giữ các mã đã nhận trước khi đóng trang.','failure',[]);}
}
export function readLeadConversionTrace(requestKey:string|undefined):LeadConversionTrace|null{
 if(!requestKey)return null;
 try{
  const value=JSON.parse(localStorage.getItem(traceKey(requestKey)) ?? 'null') as LeadConversionTrace|null;
  if(!value || typeof value.leadId!=='string' || !value.leadId || !['tenant','deposit','lead','complete'].includes(value.stage) || typeof value.canResume!=='boolean' || (value.tenantId!==undefined && (typeof value.tenantId!=='string' || !value.tenantId)) || (value.depositId!==undefined && (typeof value.depositId!=='string' || !value.depositId)))return null;
  return value;
 }catch{
  // An unreadable optional trace cannot authorize recovery. Returning null keeps the durable pending guard blocked and its user-facing reconciliation warning; it never starts the writers again.
  return null;
 }
}
function positiveIdentity(value:unknown,id:string,organizationId:string):value is Record<string,unknown>{
 return !!value && typeof value==='object' && (value as Record<string,unknown>).id===id && (value as Record<string,unknown>).organization_id===organizationId && (value as Record<string,unknown>).deleted_at===null;
}
async function runDurableConversion(initial:LeadConversionProgress,steps:{createTenant:()=>Promise<string>;createDeposit:(id:string)=>Promise<string>;markLead:()=>Promise<unknown>},onProgress:(progress:LeadConversionProgress)=>void,options:LeadConversionWorkflowOptions){
 const finish=async(trace:LeadConversionTrace,progress:FinancialWorkflowProgress):Promise<LeadConversionProgress>=>{
  const save=(patch:Partial<LeadConversionTrace>)=>{Object.assign(trace,patch);rememberTrace(progress.requestKey,trace);};
  const write=async<T>(stage:'tenant'|'deposit'|'lead',operation:()=>Promise<T>)=>{
   progress.stage=stage==='tenant'?'tạo khách thuê':stage==='deposit'?'tạo phiếu đặt cọc':'cập nhật khách hẹn';
   save({stage,canResume:false});
   try{return await operation();}
   catch(error){save({canResume:isConfirmedFinancialRejection(error)});throw error;}
  };
  if(!trace.tenantId){
   if(!trace.canResume || trace.stage!=='tenant')throw new FinancialWorkflowError('Chưa xác nhận được bước tạo khách thuê trước. Đối chiếu khách và phiếu trước khi tiếp tục.','unknown',progress.completed);
   const tenantId=await write('tenant',steps.createTenant);confirmedRecordId({id:tenantId},'tạo khách thuê');
   progress.completed.push({id:tenantId,label:'Khách thuê đã nhận mã'});save({tenantId,stage:'deposit',canResume:true});onProgress({...trace});
  }
  const tenantId = trace.tenantId;
  if (!tenantId) throw new FinancialWorkflowError('Chưa nhận mã khách thuê cần đối chiếu.', 'unknown', progress.completed);
  const tenant=await options.readTenant(tenantId);
  if(!positiveIdentity(tenant,tenantId,options.organizationId))throw new FinancialWorkflowError('Chưa đối chiếu được đúng khách thuê trong tổ chức. Giữ mã khách trước khi tiếp tục.','unknown',progress.completed);
  if(!trace.depositId){
   if(!trace.canResume || trace.stage!=='deposit')throw new FinancialWorkflowError('Chưa xác nhận được việc tạo phiếu đặt cọc trước. Đối chiếu phiếu trước khi tiếp tục, không lập phiếu khác.','unknown',progress.completed);
   const depositId=await write('deposit',()=>steps.createDeposit(tenantId));confirmedRecordId({id:depositId},'tạo phiếu đặt cọc');
   progress.completed.push({id:depositId,label:'Phiếu đặt cọc đã nhận mã'});save({depositId,stage:'lead',canResume:true});onProgress({...trace});
  }
  const depositId = trace.depositId;
  if (!depositId) throw new FinancialWorkflowError('Chưa nhận mã phiếu đặt cọc cần đối chiếu.', 'unknown', progress.completed);
  const deposit=await options.readDeposit(depositId);
  if(!positiveIdentity(deposit,depositId,options.organizationId) || deposit.tenant_id!==trace.tenantId || (options.validateDeposit && !options.validateDeposit(deposit)))throw new FinancialWorkflowError('Chưa đối chiếu được đúng phiếu đặt cọc và khách thuê. Giữ các mã đã nhận trước khi tiếp tục.','unknown',progress.completed);
  const lead=await options.readLead();
  if(!positiveIdentity(lead,options.leadId,options.organizationId))throw new FinancialWorkflowError('Chưa đối chiếu được đúng khách hẹn trong tổ chức. Tải lại thông tin trước khi tiếp tục.','unknown',progress.completed);
  if(lead.status==='CONVERTED'){save({stage:'complete',canResume:false});return {tenantId,depositId};}
  if(!trace.canResume || trace.stage!=='lead')throw new FinancialWorkflowError('Phiếu đặt cọc đã có, nhưng chưa xác nhận kết quả cập nhật khách hẹn trước. Đối chiếu trạng thái trước khi tiếp tục.','unknown',progress.completed);
  const result=await write('lead',steps.markLead);
  const converted=result && typeof result==='object' && 'lead' in result ? (result as {lead:unknown}).lead : result;
  if(!positiveIdentity(converted,options.leadId,options.organizationId) || converted.status!=='CONVERTED')throw new FinancialWorkflowError('Chưa xác nhận trạng thái khách hẹn đã chuyển. Giữ mã phiếu đã có và đối chiếu trước khi tiếp tục.','unknown',progress.completed);
  progress.completed.push({id:options.leadId,label:'Khách hẹn đã chuyển'});save({stage:'complete',canResume:false});
  return {tenantId,depositId};
 };
 return options.guard.run(options.leadId,'chuyển khách hẹn thành đặt cọc',async progress=>{
  const lead=await options.readLead();
  if(!positiveIdentity(lead,options.leadId,options.organizationId) || (lead.status==='CONVERTED' && !initial.depositId))throw new FinancialWorkflowError('Chưa xác nhận khách hẹn còn có thể chuyển sang đặt cọc. Tải lại thông tin trước khi tiếp tục.','failure',[]);
  const trace:LeadConversionTrace={leadId:options.leadId,...initial,stage:initial.depositId?'lead':initial.tenantId?'deposit':'tenant',canResume:true};
  if(initial.tenantId)progress.completed.push({id:initial.tenantId,label:'Khách thuê đã chọn'});
  if(initial.depositId)progress.completed.push({id:initial.depositId,label:'Phiếu đã có'});
  rememberTrace(progress.requestKey,trace);return finish(trace,progress);
 },async(pending,progress)=>{
  const trace=readLeadConversionTrace(pending.requestKey);
  if(!trace || trace.leadId!==options.leadId || (trace.tenantId && !pending.completedIds.includes(trace.tenantId)) || (trace.depositId && !pending.completedIds.includes(trace.depositId)))return null;
  if(trace.tenantId || trace.depositId)onProgress({tenantId:trace.tenantId,depositId:trace.depositId});
  return {result:await finish(trace,progress)};
 },options.organizationId);
}
