import { friendlyError } from '@/lib/friendlyError';
import { z } from 'zod';
import type { Json } from '@/integrations/supabase/types';
import type { ExtraChargeItem } from '@/lib/contractValidation';
import { buildFinalizeContractExitCaseArgs, parseContractExitCase, type FinalizeContractExitCaseInput } from '@/lib/contractExitCases';

const uuid=z.string().uuid();
const createSchema=z.object({oldExitCaseId:uuid,newDraftId:uuid,expectedExitVersion:z.number().int().positive(),
  expectedDraftRevision:z.number().int().positive(),mode:z.enum(['SELF_FOUND','BROKER']),
  depositMode:z.enum(['NEW_PAYMENT','OLD_DEPOSIT_OFFSET']),termMode:z.enum(['KEEP_OLD_END_DATE','NEW_TERM']),
  brokerName:z.string().trim().max(200).nullable(),reason:z.string().trim().min(1).max(2000),requestId:uuid}).strict()
  .refine(x=>x.mode!=='BROKER'||(x.depositMode==='NEW_PAYMENT'&&!!x.brokerName),'Môi giới cần tên và khách mới nộp đủ cọc mới');
export type CreateContractTransferInput=z.infer<typeof createSchema>;
export interface TransferFilter {contractId?:string;draftId?:string;exitCaseId?:string}
const linkSchema=z.object({id:uuid,organization_id:uuid,building_id:uuid,room_id:uuid,old_contract_id:uuid,old_exit_case_id:uuid,
  new_draft_id:uuid,new_contract_id:uuid.nullable(),new_draft_revision:z.number().int().positive(),
  old_contract_number:z.string().nullable(),new_contract_number:z.string().nullable(),old_customer_name:z.string().nullable(),new_customer_name:z.string(),
  mode:z.enum(['SELF_FOUND','BROKER']),deposit_mode:z.enum(['NEW_PAYMENT','OLD_DEPOSIT_OFFSET']),term_mode:z.enum(['KEEP_OLD_END_DATE','NEW_TERM']),
  starts_on:z.string(),ends_on:z.string(),broker_name:z.string().nullable(),
  deposit_base:z.number().nonnegative().nullable(),broker_fee:z.number().nonnegative().nullable(),
  fee_state:z.enum(['NOT_REQUIRED','PENDING','APPLIED']),commission_voucher_id:uuid.nullable(),commission_code:z.string().nullable(),commission_approval_status:z.string().nullable(),
  state:z.enum(['LINKED','CANCELLED']),version:z.number().int().positive(),money_state:z.enum(['INDEPENDENT','NEEDS_REVIEW','FEE_PENDING','COMMISSION_PENDING','COMMISSION_LINKED']),
  created_at:z.string(),reason:z.string(),history:z.array(z.object({event:z.string(),version:z.number().int().positive(),reason:z.string(),actor_id:uuid,actor_name:z.string().nullable(),created_at:z.string()}))});
export type ContractTransferLink=z.infer<typeof linkSchema>;
export type TransferRpcName='create_contract_transfer_link_v1'|'read_contract_transfer_links_v1'|'cancel_contract_transfer_link_v1'|'finalize_contract_transfer_exit_v1'|'create_contract_transfer_commission_v1';
export type TransferInvoker=(name:TransferRpcName,args:Record<string,Json|undefined>)=>PromiseLike<{data:unknown;error:{code?:string;message?:string}|null}>;
export function buildCreateTransferArgs(input:CreateContractTransferInput,organizationId:string){
  const x=createSchema.parse(input);return {p_organization_id:uuid.parse(organizationId),p_old_exit_case_id:x.oldExitCaseId,p_new_draft_id:x.newDraftId,
    p_expected_exit_version:x.expectedExitVersion,p_expected_draft_revision:x.expectedDraftRevision,p_mode:x.mode,p_deposit_mode:x.depositMode,
    p_term_mode:x.termMode,p_broker_name:x.brokerName,p_reason:x.reason,p_request_id:x.requestId};
}
async function call(invoke:TransferInvoker,name:TransferRpcName,args:Record<string,Json|undefined>){const result=await invoke(name,args);if(result.error)throw result.error;return result.data;}
export async function createContractTransferLink(invoke:TransferInvoker,input:CreateContractTransferInput,org:string){return linkSchema.parse(await call(invoke,'create_contract_transfer_link_v1',buildCreateTransferArgs(input,org)));}
export async function readContractTransferLinks(invoke:TransferInvoker,filter:TransferFilter,org:string){
  const x=z.object({contractId:uuid.optional(),draftId:uuid.optional(),exitCaseId:uuid.optional()}).strict().refine(v=>Object.values(v).filter(Boolean).length===1).parse(filter);
  return z.array(linkSchema).parse(await call(invoke,'read_contract_transfer_links_v1',{p_organization_id:uuid.parse(org),p_contract_id:x.contractId??null,p_draft_id:x.draftId??null,p_exit_case_id:x.exitCaseId??null}));
}
export interface CancelTransferInput {linkId:string;expectedVersion:number;reason:string;requestId:string}
export async function cancelContractTransferLink(invoke:TransferInvoker,input:CancelTransferInput,org:string){
  const x=z.object({linkId:uuid,expectedVersion:z.number().int().positive(),reason:z.string().trim().min(1).max(2000),requestId:uuid}).strict().parse(input);
  return linkSchema.parse(await call(invoke,'cancel_contract_transfer_link_v1',{p_organization_id:uuid.parse(org),p_link_id:x.linkId,p_expected_version:x.expectedVersion,p_reason:x.reason,p_request_id:x.requestId}));
}
export function transferBrokerFeeLine(link:Pick<ContractTransferLink,'id'|'mode'|'broker_fee'>):ExtraChargeItem|null{
  if(link.mode!=='BROKER')return null;
  if(link.broker_fee===null||!Number.isFinite(link.broker_fee)||link.broker_fee<0)throw new Error('Chưa xác minh được phí nhượng');
  return {kind:'CUSTOM',description:`TRANSFER_BROKER_FEE:${link.id}`,amount:link.broker_fee};
}
export function withTransferBrokerFee(charges:ExtraChargeItem[],fee:ExtraChargeItem|null):ExtraChargeItem[]{
  if(!fee)return charges;
  const matches=charges.filter(x=>x.description.startsWith('TRANSFER_BROKER_FEE:'));
  if(matches.length>1||matches.some(x=>x.description!==fee.description||x.amount!==fee.amount||x.kind!=='CUSTOM'))throw new Error('Phí nhượng không đúng hoặc bị trùng');
  return matches.length?charges:[...charges,fee];
}
export type FinalizeTransferInput=FinalizeContractExitCaseInput&{linkId:string;expectedLinkVersion:number};
export async function finalizeContractTransferExit(invoke:TransferInvoker,input:FinalizeTransferInput,org:string){
  const {linkId,expectedLinkVersion,...existing}=input;
  return parseContractExitCase(await call(invoke,'finalize_contract_transfer_exit_v1',{...buildFinalizeContractExitCaseArgs(existing,org),p_link_id:uuid.parse(linkId),p_expected_link_version:z.number().int().positive().parse(expectedLinkVersion)}));
}
export interface CreateTransferCommissionInput {linkId:string;expectedVersion:number;requestId:string;accountId?:string|null;recipientBank?:string|null;recipientAccount?:string|null}
export async function createContractTransferCommission(invoke:TransferInvoker,input:CreateTransferCommissionInput,org:string){
  const x=z.object({linkId:uuid,expectedVersion:z.number().int().positive(),requestId:uuid,accountId:uuid.nullable().optional(),recipientBank:z.string().max(200).nullable().optional(),recipientAccount:z.string().max(200).nullable().optional()}).strict().parse(input);
  return linkSchema.parse(await call(invoke,'create_contract_transfer_commission_v1',{p_organization_id:uuid.parse(org),p_link_id:x.linkId,p_expected_version:x.expectedVersion,p_request_id:x.requestId,p_account_id:x.accountId??null,p_recipient_bank:x.recipientBank??null,p_recipient_account:x.recipientAccount??null}));
}
export function transferErrorMessage(error:unknown){const e=error as {code?:string;message?:string}|null;
  if(e?.code==='PT409')return 'Hồ sơ nhượng đã thay đổi. Vui lòng tải lại.';
  if(e?.code==='42501')return 'Bạn không có quyền xử lý hồ sơ nhượng tại tổ chức hoặc tòa nhà này.';
  return friendlyError(error, 'Chưa xử lý được hồ sơ nhượng', {operation:'xử lý hồ sơ nhượng hợp đồng'}).description;
}
