import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { confirmedRecordId, confirmedRecordBatch, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg, withOrgAll } from "@/lib/orgPayload";
import { friendlyError } from "@/lib/friendlyError";

export class ServiceLinksPartialError extends Error {
  constructor(public readonly serviceId: string, public readonly cause: unknown) {
    super(`Dịch vụ ${serviceId} đã lưu, nhưng danh sách tòa áp dụng chưa hoàn tất. Mở lại dịch vụ và kiểm tra các tòa trước khi lưu tiếp; không tạo lại dịch vụ.`);
    this.name = "ServiceLinksPartialError";
    if(cause instanceof FinancialWorkflowError && cause.completed.length)this.message+=` ID cần đối chiếu: ${cause.completed.map(step=>step.id).join(', ')}.`;
  }
}

export class ServiceQuotaPartialError extends Error {
  constructor(public readonly quotaId: string, public readonly cause: unknown) {
    super(`Định mức ${quotaId} đã lưu, nhưng các bậc giá chưa hoàn tất. Tải lại định mức để kiểm tra trước khi sửa tiếp; không tạo lại.`);
    this.name = "ServiceQuotaPartialError";
    if(cause instanceof FinancialWorkflowError && cause.completed.length)this.message+=` ID cần đối chiếu: ${cause.completed.map(step=>step.id).join(', ')}.`;
  }
}

type Service = Database["public"]["Tables"]["services"]["Row"];
type ServiceInsert = Database["public"]["Tables"]["services"]["Insert"];
type ServiceUpdate = Database["public"]["Tables"]["services"]["Update"];
type ServiceQuota = Database["public"]["Tables"]["service_quotas"]["Row"];
type ServiceQuotaTier = Database["public"]["Tables"]["service_quota_tiers"]["Row"];

export const FEE_TYPE_LABELS: Record<string, string> = {
  TIEN_PHI_DICH_VU: "Tiền phí dịch vụ",
  TIEN_DIEN: "Tiền điện",
  TIEN_NUOC: "Tiền nước",
  TIEN_PHI_KHAC: "Tiền phí khác",
  TIEN_VE_SINH: "Tiền vệ sinh",
};

export const PRICING_TYPE_LABELS: Record<string, string> = {
  DON_GIA_CO_DINH_THANG: "Đơn giá cố định theo tháng",
  DON_GIA_CO_DINH_DONG_HO: "Đơn giá cố định theo đồng hồ",
  DON_GIA_BIEN_DONG: "Đơn giá biến động",
  DON_GIA_THEO_NGUOI: "Đơn giá theo người",
  DON_GIA_THEO_PHONG: "Đơn giá theo phòng",
};

export const UNIT_OPTIONS = [
  "Phòng", "Người", "Kwh", "m³", "Lượt", "Tháng", "Chiếc",
];

export type ServiceWithBuildings = Service & {
  building_services: { building_id: string; is_active: boolean }[];
};

// Fetch services with building associations, optional filters
// options.enabled: dialog mounted-sẵn gate fetch khi đóng (default true).
export const useServices = (
  filters?: {
    building_id?: string;
    fee_type?: string;
  },
  options?: { enabled?: boolean }
) => {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: ["services", filters],
    queryFn: async () => {
      let query = supabase
        .from("services")
        .select("*, building_services(building_id, is_active)")
        .is("deleted_at", null)
        .order("name", { ascending: true });

      if (filters?.fee_type) {
        query = query.eq("fee_type", filters.fee_type as Database["public"]["Enums"]["fee_type"]);
      }

      const { data, error } = await query;

      if (error) throw error;
      if (!Array.isArray(data)) throw new TypeError('Chưa xác nhận được danh sách dịch vụ. Tải lại để kiểm tra.');
      let result = data as ServiceWithBuildings[];

      // Client-side filter by building_id through junction table (active only)
      if (filters?.building_id) {
        result = result.filter((s) =>
          s.building_services.some(
            (bs) => bs.building_id === filters.building_id && bs.is_active
          )
        );
      }

      return result;
    },
  });
};

// Preserve main write order; receipts retain the result of each completed step.
const refreshServices=(queryClient:ReturnType<typeof useQueryClient>)=>{queryClient.invalidateQueries({queryKey:['services']});queryClient.invalidateQueries({queryKey:['building-services']});};
const serviceWriteError=(id:string|undefined,error:unknown):unknown=>id&&error instanceof FinancialWorkflowError&&error.outcome==='partial'?new ServiceLinksPartialError(id,error):error;
function confirmIds(rows:unknown,expectedIds:string[],operation:string):void{
  const ids=confirmedRecordBatch(rows,expectedIds.length,operation);
  if(expectedIds.some(id=>!ids.includes(id)))throw new FinancialWorkflowError(`Chưa xác nhận đúng các bản ghi khi ${operation}. Tải lại để đối chiếu.`,'partial',ids.map(id=>({id,label:'Bản ghi cần đối chiếu'})));
}
export const useCreateService=()=>{
 const queryClient=useQueryClient();const {selectedOrganizationId}=useOrganization();const guard=persistentFinancialWorkflow('service-create');
 return useMutation({meta:{handlesFeedback:true},mutationFn:async(params:Omit<ServiceInsert,'user_id'>&{building_ids?:string[]})=>{
  const user=await getSessionUser();if(!user)throw new Error('Not authenticated');
  const {building_ids,...serviceData}=params;if(serviceData.unit_price!==undefined&&!Number.isFinite(serviceData.unit_price))throw new Error('Đơn giá chưa hợp lệ.');
  const payload=withOrg({...serviceData,user_id:user.id},selectedOrganizationId);let coreId:string|undefined;
  try{return await guard.run('create','tạo dịch vụ',async progress=>{
   const {data,error}=await supabase.from('services').insert(withOrg(payload,selectedOrganizationId)).select().single();
   if(error)throw error;coreId=confirmedRecordId(data,'tạo dịch vụ');progress.completed.push({id:coreId,label:'Đã tạo dịch vụ'});
   const buildings=building_ids??[];
   if(buildings.length){progress.stage='lưu tòa áp dụng';const {data:rows,error:linksError}=await supabase.from('building_services').insert(withOrgAll(buildings.map(building_id=>({service_id:coreId!,building_id,is_active:true})),selectedOrganizationId)).select('id');if(linksError)throw linksError;const ids=confirmedRecordBatch(rows,buildings.length,'lưu tòa áp dụng');progress.completed.push(...ids.map(id=>({id,label:'Đã lưu tòa áp dụng'})));}
   return data;
  },undefined,payload.organization_id);}catch(error){throw serviceWriteError(coreId,error);}
 },onSuccess:data=>{refreshServices(queryClient);toast.success(`Đã tạo dịch vụ ${data.name || data.id} và lưu tòa áp dụng.`);},onError:error=>{refreshServices(queryClient);toast.error('Chưa hoàn tất tạo dịch vụ',{description:error instanceof ServiceLinksPartialError?error.message:recordWriteMessage(error,'tạo dịch vụ')});}});
};
export const useUpdateService=()=>{
 const queryClient=useQueryClient();const {selectedOrganizationId}=useOrganization();const guard=persistentFinancialWorkflow('service-update');
 return useMutation({meta:{handlesFeedback:true},mutationFn:async({id,updates,building_ids}:{id:string;updates:ServiceUpdate;building_ids?:string[]})=>{
  if(updates.unit_price!==undefined&&!Number.isFinite(updates.unit_price))throw new Error('Đơn giá chưa hợp lệ.');let coreId:string|undefined;
  try{return await guard.run(id,'cập nhật dịch vụ',async progress=>{
   const {data,error}=await supabase.from('services').update(updates).eq('id',id).select().single();if(error)throw error;coreId=confirmedRecordId(data,'cập nhật dịch vụ',id);progress.completed.push({id,label:'Đã cập nhật dịch vụ'});
   if(building_ids!==undefined){
    progress.stage='đồng bộ tòa áp dụng';const {data:existing,error:readError}=await supabase.from('building_services').select('id,building_id,is_active').eq('service_id',id);if(readError)throw readError;
    if(!Array.isArray(existing)||existing.some(row=>typeof row?.id!=='string'||!row.id||typeof row.building_id!=='string'||typeof row.is_active!=='boolean'))throw new Error('Chưa xác nhận được tòa áp dụng hiện tại.');
    const desired=[...new Set(building_ids)];const oldMap=new Map(existing.map(row=>[row.building_id,row]));
    const activate=existing.filter(row=>desired.includes(row.building_id)&&!row.is_active).map(row=>row.id);
    const added=building_ids.filter(building=>!oldMap.has(building));
    const removed=existing.filter(row=>!desired.includes(row.building_id)).map(row=>row.id);
    if(removed.length){const {data:rows,error:writeError}=await supabase.from('building_services').delete().in('id',removed).select('id');if(writeError)throw writeError;confirmIds(rows,removed,'gỡ tòa áp dụng');progress.completed.push(...removed.map(id=>({id,label:'Đã gỡ tòa áp dụng'})));}
    if(activate.length){const {data:rows,error:writeError}=await supabase.from('building_services').update({is_active:true}).in('id',activate).select('id');if(writeError)throw writeError;confirmIds(rows,activate,'kích hoạt tòa áp dụng');progress.completed.push(...activate.map(id=>({id,label:'Đã kích hoạt tòa áp dụng'})));}
    if(added.length){const {data:rows,error:writeError}=await supabase.from('building_services').insert(withOrgAll(added.map(building_id=>({service_id:id,building_id,is_active:true})),selectedOrganizationId)).select('id');if(writeError)throw writeError;const ids=confirmedRecordBatch(rows,added.length,'thêm tòa áp dụng');progress.completed.push(...ids.map(id=>({id,label:'Đã thêm tòa áp dụng'})));}
   }
   return data;
  });}catch(error){throw serviceWriteError(coreId,error);}
 },onSuccess:data=>{refreshServices(queryClient);toast.success(`Đã cập nhật dịch vụ ${data.name || data.id} và tòa áp dụng.`);},onError:error=>{refreshServices(queryClient);toast.error('Chưa hoàn tất cập nhật dịch vụ',{description:error instanceof ServiceLinksPartialError?error.message:recordWriteMessage(error,'cập nhật dịch vụ')});}});
};
// Soft delete service
export const useDeleteService = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("services")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select('id')
        .single();

      if (error) throw error;
      if (data?.id !== id) throw new Error('Chưa xác nhận được dịch vụ đã xóa. Tải lại danh sách để kiểm tra.');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["services"] });
      toast.success("Đã xóa dịch vụ");
    },
    onError: error => { const feedback = friendlyError(error, 'Chưa xóa được dịch vụ', { operation: 'xóa dịch vụ' }); toast.error(feedback.title, { description: feedback.description }); },
  });
};

// Fetch service quotas with tiers
export type ServiceQuotaWithTiers = ServiceQuota & {
  service_quota_tiers: ServiceQuotaTier[];
};

export const useServiceQuotas = () => {
  return useQuery({
    queryKey: ["service_quotas"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("service_quotas")
        .select("*, service_quota_tiers(*)")
        .is("deleted_at", null)
        .order("name", { ascending: true });

      if (error) throw error;
      if (!Array.isArray(data)) throw new TypeError('Chưa xác nhận được danh sách định mức dịch vụ. Tải lại để kiểm tra.');
      return data as ServiceQuotaWithTiers[];
    },
  });
};

interface QuotaTierInput{tier_number:number;from_value:number;to_value:number|null;unit_price:number}
interface QuotaInput{name:string;description?:string|null;tiers:QuotaTierInput[]}
const quotaWriteError=(id:string|undefined,error:unknown):unknown=>id&&error instanceof FinancialWorkflowError&&error.outcome==='partial'?new ServiceQuotaPartialError(id,error):error;
export const useCreateServiceQuota=()=>{
 const queryClient=useQueryClient();const {selectedOrganizationId}=useOrganization();const guard=persistentFinancialWorkflow('quota-create');
 const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
 const savedTier=(value:unknown,quotaId:string):value is Pick<ServiceQuotaTier,'id'|'quota_id'|'tier_number'|'from_value'|'to_value'|'unit_price'>=>record(value)&&typeof value.id==='string'&&!!value.id&&value.quota_id===quotaId&&typeof value.tier_number==='number'&&typeof value.from_value==='number'&&(value.to_value===null||typeof value.to_value==='number')&&typeof value.unit_price==='number';
 return useMutation({meta:{handlesFeedback:true},mutationFn:async(params:QuotaInput)=>{
  const user=await getSessionUser();if(!user)throw new Error('Not authenticated');let coreId:string|undefined;
  try{return await guard.run('create','tạo định mức dịch vụ',async progress=>{
   const {data,error}=await supabase.from('service_quotas')
    .insert({name:params.name,description:params.description||null,user_id:user.id}).select().single();
   if(error)throw error;
   coreId=confirmedRecordId(data,'tạo định mức');progress.completed.push({id:coreId,label:'Định mức đã nhận mã; cần đối chiếu nội dung'});
   if(data.name!==params.name||data.description!==(params.description||null)||data.user_id!==user.id)throw new FinancialWorkflowError('Chưa xác nhận đúng định mức đã tạo; chưa gửi các bậc giá.','unknown',[],new TypeError('Mismatched created quota receipt'));
   progress.completed[0]!.label='Đã tạo định mức';
   if(params.tiers.length>0){
    progress.stage='lưu các bậc giá';
    const {data:inserted,error:tierError}=await supabase.from('service_quota_tiers')
     .insert(params.tiers.map((t)=>({
      quota_id:data.id,
      tier_number:t.tier_number,
      from_value:t.from_value,
      to_value:t.to_value,
      unit_price:t.unit_price,
     }))).select('id,quota_id,tier_number,from_value,to_value,unit_price');
    if(tierError)throw tierError;
    if(Array.isArray(inserted)){const rows:unknown[]=inserted;const ids=[...new Set(rows.flatMap(row=>record(row)&&typeof row.id==='string'&&row.id?[row.id]:[]))];progress.completed.push(...ids.map(id=>({id,label:'Đã nhận mã bậc giá; chưa xác nhận đủ danh sách'})));}
    if(!Array.isArray(inserted))throw new FinancialWorkflowError('Chưa xác nhận được các bậc giá đã lưu. Giữ mã định mức và đối chiếu trước khi thực hiện tiếp.','unknown',[],new TypeError('Unconfirmed created quota tier receipt'));
    const rows:unknown[]=inserted;
    if(!rows.every(row=>savedTier(row,data.id))||rows.length!==params.tiers.length||new Set(rows.map(row=>row.id)).size!==rows.length)throw new FinancialWorkflowError('Chưa xác nhận đủ và đúng các bậc giá đã lưu.','unknown',[],new TypeError('Incomplete created quota tier receipt'));
    const expected=[...params.tiers];
    for(const row of rows){const index=expected.findIndex(t=>t.tier_number===row.tier_number&&t.from_value===row.from_value&&t.to_value===row.to_value&&t.unit_price===row.unit_price);if(index<0)throw new FinancialWorkflowError('Biên nhận bậc giá chưa khớp các giá trị đã gửi.','unknown',[],new TypeError('Mismatched created quota tier values'));expected.splice(index,1);}
   }
   return data;
  },undefined,selectedOrganizationId??undefined);}catch(error){const feedback=quotaWriteError(coreId,error);if(feedback instanceof ServiceQuotaPartialError&&error instanceof FinancialWorkflowError)feedback.message=recordWriteMessage(error,'tạo định mức');throw feedback;}
 },onSuccess:data=>{queryClient.invalidateQueries({queryKey:['service_quotas']});toast.success(`Đã tạo định mức ${data.name || data.id} và các bậc giá.`);},onError:error=>{queryClient.invalidateQueries({queryKey:['service_quotas']});toast.error('Chưa hoàn tất tạo định mức',{description:error instanceof ServiceQuotaPartialError?error.message:recordWriteMessage(error,'tạo định mức')});}});
};
export const useUpdateServiceQuota=()=>{
 const queryClient=useQueryClient();const guard=persistentFinancialWorkflow('quota-update',{scope:'actor'});
 const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
 const ids=(value:unknown):string[]=>{if(!Array.isArray(value))return [];const rows:unknown[]=value;return [...new Set(rows.flatMap(row=>record(row)&&typeof row.id==='string'&&row.id?[row.id]:[]))];};
 const removedTier=(value:unknown,quotaId:string):value is Pick<ServiceQuotaTier,'id'|'quota_id'|'tier_number'>=>record(value)&&typeof value.id==='string'&&!!value.id&&value.quota_id===quotaId&&typeof value.tier_number==='number';
 const savedTier=(value:unknown,quotaId:string):value is Pick<ServiceQuotaTier,'id'|'quota_id'|'tier_number'|'from_value'|'to_value'|'unit_price'>=>{
  if(!record(value))return false;const from=value.from_value,to=value.to_value,price=value.unit_price;
  return removedTier(value,quotaId)&&typeof from==='number'&&(to===null||typeof to==='number')&&typeof price==='number';
 };
 return useMutation({meta:{handlesFeedback:true},mutationFn:async(params:QuotaInput&{id:string})=>{
  let coreId:string|undefined;
  try{return await guard.run(params.id,'cập nhật định mức dịch vụ',async progress=>{
   // Main sequence and payload: UPDATE header, DELETE all old tiers, INSERT the new set.
   const {data,error}=await supabase.from('service_quotas')
    .update({name:params.name,description:params.description||null}).eq('id',params.id)
    .select('id,name,description').single();
   if(error)throw error;
   coreId=confirmedRecordId(data,'cập nhật định mức',params.id);
   progress.completed.push({id:coreId,label:'Định mức đã nhận mã; cần đối chiếu nội dung'});
   if(data.name!==params.name||data.description!==(params.description||null))throw new FinancialWorkflowError('Chưa xác nhận đúng nội dung định mức đã cập nhật; chưa gỡ các bậc giá.','unknown',[],new TypeError('Mismatched quota header receipt'));
   progress.completed[0]!.label='Đã cập nhật định mức';

   progress.stage='gỡ các bậc giá cũ';
   const {data:deleted,error:deleteError}=await supabase.from('service_quota_tiers')
    .delete().eq('quota_id',params.id).select('id,quota_id,tier_number');
   if(deleteError)throw deleteError;
   const deletedIds=ids(deleted);progress.completed.push(...deletedIds.map(id=>({id,label:'Mã bậc nhận sau bước gỡ; cần đối chiếu'})));
   if(!Array.isArray(deleted))throw new FinancialWorkflowError('Chưa xác nhận được việc gỡ bậc giá cũ; chưa gửi danh sách bậc mới.','unknown',[],new TypeError('Unconfirmed quota tier deletion receipt'));
   const oldRows:unknown[]=deleted;
   if(!oldRows.every(row=>removedTier(row,params.id))||new Set(oldRows.map(row=>row.id)).size!==oldRows.length)throw new FinancialWorkflowError('Chưa xác nhận đúng các bậc giá đã gỡ; chưa gửi danh sách mới.','unknown',[],new TypeError('Mismatched quota tier deletion receipt'));
   for(const step of progress.completed)if(deletedIds.includes(step.id))step.label='Đã gỡ bậc giá cũ';

   if(params.tiers.length>0){
    progress.stage='lưu các bậc giá mới';
    const {data:inserted,error:tierError}=await supabase.from('service_quota_tiers')
     .insert(params.tiers.map((t)=>({
      quota_id:params.id,
      tier_number:t.tier_number,
      from_value:t.from_value,
      to_value:t.to_value,
      unit_price:t.unit_price,
     }))).select('id,quota_id,tier_number,from_value,to_value,unit_price');
    if(tierError)throw tierError;
    progress.completed.push(...ids(inserted).map(id=>({id,label:'Đã nhận mã bậc giá mới; chưa xác nhận đủ danh sách'})));
    if(!Array.isArray(inserted))throw new FinancialWorkflowError('Chưa xác nhận được các bậc giá mới đã lưu. Giữ mã đã nhận và đối chiếu trước khi thực hiện tiếp.','unknown',[],new TypeError('Unconfirmed quota tier insert receipt'));
    const newRows:unknown[]=inserted;
    if(!newRows.every(row=>savedTier(row,params.id))||newRows.length!==params.tiers.length||new Set(newRows.map(row=>row.id)).size!==newRows.length)throw new FinancialWorkflowError('Chưa xác nhận đủ và đúng các bậc giá mới đã lưu.','unknown',[],new TypeError('Incomplete quota tier insert receipt'));
    const expected=[...params.tiers];
    for(const row of newRows){const index=expected.findIndex(t=>t.tier_number===row.tier_number&&t.from_value===row.from_value&&t.to_value===row.to_value&&t.unit_price===row.unit_price);if(index<0)throw new FinancialWorkflowError('Biên nhận bậc giá mới chưa khớp các giá trị đã gửi.','unknown',[],new TypeError('Mismatched quota tier insert values'));expected.splice(index,1);}
   }
   return data;
  });}catch(error){const feedback=quotaWriteError(coreId,error);if(feedback instanceof ServiceQuotaPartialError&&error instanceof FinancialWorkflowError)feedback.message=recordWriteMessage(error,'cập nhật định mức');throw feedback;}
 },onSuccess:()=>{queryClient.invalidateQueries({queryKey:['service_quotas']});toast.success('Đã cập nhật định mức và các bậc giá.');},onError:error=>{queryClient.invalidateQueries({queryKey:['service_quotas']});toast.error('Chưa hoàn tất cập nhật định mức',{description:error instanceof ServiceQuotaPartialError?error.message:recordWriteMessage(error,'cập nhật định mức')});}});
};
// Soft delete quota
export const useDeleteServiceQuota = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("service_quotas")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select('id')
        .single();

      if (error) throw error;
      if (data?.id !== id) throw new Error('Chưa xác nhận được định mức đã xóa. Tải lại danh sách để kiểm tra.');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service_quotas"] });
      toast.success("Định mức đã được xóa thành công");
    },
    onError: error => { const feedback = friendlyError(error, 'Chưa xóa được định mức', { operation: 'xóa định mức' }); toast.error(feedback.title, { description: feedback.description }); },
  });
};
