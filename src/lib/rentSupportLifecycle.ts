import { z } from 'zod';

const uuid=z.string().uuid();
const money=z.string().max(100).regex(/^\d+(?:\.\d+)?$/);
const state=z.enum(['READY','NEEDS_REVIEW']);
const reason=z.string().trim().min(8).max(2000);
const issues=z.array(z.object({code:z.string(),message:z.string()}).strict());
const source=z.object({source_id:uuid,voucher_id:uuid.nullable(),gross:money,withheld:money,net:money,state,proof_hash:z.string().min(1)}).strict();
export const lifecycleReadSchema=z.object({version:z.literal(1),contract_id:uuid,plan_revision:z.number().int().positive().nullable(),
 termination:z.object({effective_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),cutoff_month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),proof_hash:z.string().min(1)}).strict().nullable(),
 committed:money,consumed:money,unused_committed:money,state,issues,sources:z.array(source)}).strict();
export type RentSupportLifecycle=z.infer<typeof lifecycleReadSchema>;
export const reconciliationDocumentSchema=z.object({signing_id:uuid,document_id:uuid,sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
const identity={source_id:uuid,contract_id:uuid,voucher_id:uuid,party_id:uuid,kind:z.enum(['COMMISSION','BONUS'])};
export const reconciliationContextSchema=z.object({...identity,engine_net:money,expected_approval_version:z.number().int().nonnegative(),expected_posting_version:z.number().int().nonnegative(),documents:z.array(reconciliationDocumentSchema)}).strict().nullable();
export type ReconciliationContext=NonNullable<z.infer<typeof reconciliationContextSchema>>;
function balances(gross:string,held:string,net:string) {
 const values=[gross,held,net],scale=Math.max(...values.map(v=>v.split('.')[1]?.length??0));
 const units=values.map(v=>{const [whole,fraction='']=v.split('.');return BigInt(whole+fraction.padEnd(scale,'0'));});
 return units[0]===units[1]!+units[2]!;
}
export const reconciliationEntrySchema=z.object({...identity,gross:money,previous_withheld:money,net:money,
 documents:z.array(reconciliationDocumentSchema).max(20),confirmed:z.boolean(),expected_approval_version:z.number().int().nonnegative(),expected_posting_version:z.number().int().nonnegative(),reason,
}).strict().refine(v=>balances(v.gross,v.previous_withheld,v.net),'Tổng quyền lợi phải bằng phần đã giữ cộng thực nhận.');
export type ReconciliationEntry=z.infer<typeof reconciliationEntrySchema>;
const row=z.object({...identity,plan_id:uuid.nullable(),gross:money,previous_withheld:money,net:money,engine_net:money,already_paid:money.nullable(),state,issue:z.string().nullable(),proof_hash:z.string().min(1)}).strict();
export const reconciliationPreviewSchema=z.object({version:z.literal(1),state,batch_hash:z.string().min(1),rows:z.array(row),totals:z.object({gross:money,previous_withheld:money,net:money}).strict()}).strict();
export type ReconciliationPreview=z.infer<typeof reconciliationPreviewSchema>;
export const reconciliationResultSchema=z.object({version:z.literal(1),batch_id:uuid,request_id:uuid,state:z.enum(['COMPLETED','NEEDS_REVIEW']),rows:z.array(row)}).strict();
export const lifecycleRequestSchema=z.object({sourceId:uuid,action:z.enum(['CANCEL','RESTORE','REVISE']),expectedFactsHash:z.string().min(1),reason,requestId:uuid}).strict();
export type LifecycleRequest=z.infer<typeof lifecycleRequestSchema>;
const requestResult=z.object({request_id:uuid,state:z.literal('NEEDS_REVIEW'),issue:z.literal('REVERSAL_REVIEW')}).strict();
export async function readRentSupportLifecycle(organizationId:string,contractId:string) {
 const {supabase}=await import('@/integrations/supabase/client');
 const {data,error}=await supabase.rpc('read_contract_rent_support_lifecycle_v1',{p_organization_id:uuid.parse(organizationId),p_contract_id:uuid.parse(contractId)});
 if(error)throw error;return lifecycleReadSchema.parse(data);
}
export async function readRentSupportReconciliationContext(organizationId:string,contractId:string,voucherId:string) {
 const {supabase}=await import('@/integrations/supabase/client');
 const {data,error}=await supabase.rpc('read_rent_support_reconciliation_context_v1',{p_organization_id:uuid.parse(organizationId),p_contract_id:uuid.parse(contractId),p_voucher_id:uuid.parse(voucherId)});
 if(error)throw error;return reconciliationContextSchema.parse(data);
}
export async function requestRentSupportLifecycle(organizationId:string,input:LifecycleRequest) {
 const i=lifecycleRequestSchema.parse(input);const {supabase}=await import('@/integrations/supabase/client');
 const {data,error}=await supabase.rpc('request_rent_support_source_lifecycle_v1',{p_organization_id:uuid.parse(organizationId),p_source_id:i.sourceId,p_action:i.action,p_expected_facts_hash:i.expectedFactsHash,p_reason:i.reason,p_request_id:i.requestId});
 if(error)throw error;return requestResult.parse(data);
}
export async function previewRentSupportReconciliation(organizationId:string,entries:ReconciliationEntry[]) {
 const parsed=z.array(reconciliationEntrySchema).min(1).max(100).parse(entries);const {supabase}=await import('@/integrations/supabase/client');
 const {data,error}=await supabase.rpc('dry_run_rent_support_reconciliation_v1',{p_organization_id:uuid.parse(organizationId),p_entries:parsed});
 if(error)throw error;return reconciliationPreviewSchema.parse(data);
}
export async function applyRentSupportReconciliation(organizationId:string,input:{entries:ReconciliationEntry[];batchHash:string;reason:string;requestId:string}) {
 const parsed=z.array(reconciliationEntrySchema).min(1).max(100).parse(input.entries);const {supabase}=await import('@/integrations/supabase/client');
 const {data,error}=await supabase.rpc('apply_rent_support_reconciliation_v1',{p_organization_id:uuid.parse(organizationId),p_entries:parsed,p_batch_hash:z.string().min(1).parse(input.batchHash),p_reason:reason.parse(input.reason),p_request_id:uuid.parse(input.requestId)});
 if(error)throw error;return reconciliationResultSchema.parse(data);
}
