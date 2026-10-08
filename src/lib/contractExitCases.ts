import { z } from 'zod';
import type { Json } from '@/integrations/supabase/types';
import type { ExtraChargeItem, RefundItem } from '@/lib/contractValidation';
import { buildMeterBoundaryPayload,type MeterBoundaryInput } from '@/lib/contractMeterBoundaries';

export const EXIT_KINDS = ['NATURAL_EXPIRY', 'EARLY_RETURN', 'FORFEIT'] as const;
export type ExitKind = typeof EXIT_KINDS[number];
export type ExitSettlementMode = 'DEFERRED' | 'IMMEDIATE';
export type ExitCaseState = 'PENDING' | 'FINALIZED';
const kindSchema = z.enum(EXIT_KINDS);
const keySchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/, 'Mã yêu cầu không hợp lệ');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Ngày trả thực tế không hợp lệ');
const moneySchema = z.number().finite().nonnegative();
const lineSchema = z.object({description:z.string(),amount:moneySchema}).passthrough();
const moneyInputSchema = z.object({
  depositRefund:moneySchema.optional(), penaltyFee:moneySchema.optional(), excessRent:moneySchema.optional(),
  outstandingDebt:moneySchema.optional(), notes:z.string().nullable().optional(),
  extraCharges:z.array(lineSchema).optional(), refundItems:z.array(lineSchema).optional(),
  shortfallMode:z.enum(['PAID','DEBT']).optional(), receiptAccountId:z.string().uuid().nullable().optional(),
}).strict();
const forfeitInputSchema = z.object({extraCharges:z.array(lineSchema).optional()}).strict();

export interface ContractExitSettlementInput {
  depositRefund?: number; penaltyFee?: number; excessRent?: number; outstandingDebt?: number;
  notes?: string | null; extraCharges?: ExtraChargeItem[]; refundItems?: RefundItem[];
  shortfallMode?: 'PAID' | 'DEBT'; receiptAccountId?: string | null;
}
export type ExitSettlementInput = ContractExitSettlementInput;
interface ReturnBase {
  contractId:string; expectedContractUpdatedAt:string; idempotencyKey:string;
  actualMoveOutOn:string; initialKind:ExitKind;returnNote:string;meterBoundary?:MeterBoundaryInput;
}
export type ConfirmContractReturnInput = ReturnBase & (
  {settlementMode:'DEFERRED'; settlement?:never} |
  {settlementMode:'IMMEDIATE'; settlement:ContractExitSettlementInput}
);
export interface FinalizeContractExitCaseInput {
  caseId:string; expectedVersion:number; idempotencyKey:string; currentKind:ExitKind;
  reason?:string|null; settlement:ContractExitSettlementInput;
}
export interface UpdateContractExitKindInput {
  caseId:string; expectedVersion:number; idempotencyKey:string; kind:ExitKind; reason:string;
}
export interface ContractExitCaseFilters { buildingId?:string; buildingIds?:string[]; contractId?:string; state?:ExitCaseState; limit?:number; offset?:number }

const responseSchema = z.object({
  id:z.string().uuid(), organization_id:z.string().uuid(), building_id:z.string().uuid(),
  contract_id:z.string().uuid(), room_at_handover_id:z.string().uuid(), actual_move_out_on:dateSchema,
  initial_kind:kindSchema, current_kind:kindSchema, settlement_mode:z.enum(['DEFERRED','IMMEDIATE']),
  state:z.enum(['PENDING','FINALIZED']), version:z.number().int().positive(),
  created_at:z.string(),updated_at:z.string(),
  contract_number:z.string().nullable().optional(),building_name:z.string().nullable().optional(),
  room_name:z.string().nullable().optional(),customer_name:z.string().nullable().optional(),
  return_note:z.string().nullable().default(null),
  settlement_result:z.custom<Json>(value=>value===null || (typeof value==='object' && !Array.isArray(value))),
  kind_history:z.array(z.object({before_kind:kindSchema,after_kind:kindSchema,reason:z.string(),version:z.number().int().positive(),changed_at:z.string(),changed_by:z.string().uuid(),actor_name:z.string().nullable().optional()})),
});
export type ContractExitCase = z.infer<typeof responseSchema>;
export interface ContractExitCasePage {items:ContractExitCase[];total:number;limit:number;offset:number;server_today?:string;server_now?:string}
export type ContractExitRpcName = 'confirm_contract_return_v1'|'finalize_contract_exit_case_v1'|'update_contract_exit_case_kind_v1'|'list_contract_exit_cases_v1'|'get_contract_exit_case_v1';
export interface ContractExitRpcError {code?:string;message?:string;details?:string;hint?:string}
export type ContractExitRpcInvoker = (name:ContractExitRpcName,args:Record<string,Json|undefined>) => PromiseLike<{data:unknown;error:ContractExitRpcError|null}>;

function settlementPayload(kind:ExitKind,input:ContractExitSettlementInput): Json {
  if(kind==='FORFEIT') {
    const value=forfeitInputSchema.parse(input);
    return {extra_charges:value.extraCharges??[]} as Json;
  }
  const value=moneyInputSchema.parse(input);
  return {deposit_refund:value.depositRefund??0,penalty_fee:value.penaltyFee??0,
    excess_rent:value.excessRent??0,outstanding_debt:value.outstandingDebt??0,
    notes:value.notes??null,extra_charges:value.extraCharges??[],shortfall_mode:value.shortfallMode??'PAID',
    receipt_account_id:value.receiptAccountId??null,refund_items:value.refundItems??[]} as Json;
}
export function buildConfirmContractReturnArgs(input:ConfirmContractReturnInput,organizationId:string) {
  const base=z.object({contractId:z.string().uuid(),expectedContractUpdatedAt:z.string().datetime({offset:true}),
    idempotencyKey:keySchema,actualMoveOutOn:dateSchema,initialKind:kindSchema,
    returnNote:z.string().trim().min(1,'Vui lòng ghi nội dung thanh lý để đối chiếu'),
    settlementMode:z.enum(['DEFERRED','IMMEDIATE']),settlement:z.unknown().optional(),meterBoundary:z.unknown().optional()}).strict().parse(input);
  if(base.settlementMode==='DEFERRED' && base.settlement!==undefined) throw new Error('Trả phòng, quyết toán sau không nhận dữ liệu tiền');
  if(base.settlementMode==='IMMEDIATE' && (base.settlement===undefined || base.settlement===null)) throw new Error('Quyết toán ngay cần dữ liệu quyết toán');
  return {p_organization_id:z.string().uuid().parse(organizationId),p_contract_id:base.contractId,p_expected_contract_updated_at:base.expectedContractUpdatedAt,
    p_idempotency_key:base.idempotencyKey,p_actual_move_out_on:base.actualMoveOutOn,p_initial_kind:base.initialKind,p_return_note:base.returnNote,
    p_settlement_mode:base.settlementMode,p_settlement:base.settlementMode==='IMMEDIATE'?settlementPayload(base.initialKind,input.settlement!):null,
    p_meter_boundary:base.meterBoundary===undefined?null:buildMeterBoundaryPayload(input.meterBoundary!)};
}
export function buildFinalizeContractExitCaseArgs(input:FinalizeContractExitCaseInput,organizationId:string) {
  const value=z.object({caseId:z.string().uuid(),expectedVersion:z.number().int().positive(),idempotencyKey:keySchema,
    currentKind:kindSchema,reason:z.string().nullable().optional(),settlement:z.unknown()}).strict().parse(input);
  return {p_organization_id:z.string().uuid().parse(organizationId),p_case_id:value.caseId,p_expected_version:value.expectedVersion,p_idempotency_key:value.idempotencyKey,
    p_current_kind:value.currentKind,p_reason:value.reason??null,p_settlement:settlementPayload(value.currentKind,input.settlement)};
}
export function parseContractExitCase(value:unknown):ContractExitCase {return responseSchema.parse(value);}
async function call(invoke:ContractExitRpcInvoker,name:ContractExitRpcName,args:Record<string,Json|undefined>):Promise<unknown>{
  const result=await invoke(name,args); if(result.error) throw result.error; return result.data;
}
export async function confirmContractReturn(invoke:ContractExitRpcInvoker,input:ConfirmContractReturnInput,organizationId:string):Promise<ContractExitCase>{
  return parseContractExitCase(await call(invoke,'confirm_contract_return_v1',buildConfirmContractReturnArgs(input,organizationId)));
}
export async function finalizeContractExitCase(invoke:ContractExitRpcInvoker,input:FinalizeContractExitCaseInput,organizationId:string):Promise<ContractExitCase>{
  return parseContractExitCase(await call(invoke,'finalize_contract_exit_case_v1',buildFinalizeContractExitCaseArgs(input,organizationId)));
}
export async function updateContractExitKind(invoke:ContractExitRpcInvoker,input:UpdateContractExitKindInput,organizationId:string):Promise<ContractExitCase>{
  const value=z.object({caseId:z.string().uuid(),expectedVersion:z.number().int().positive(),idempotencyKey:keySchema,kind:kindSchema,reason:z.string().trim().min(1)}).strict().parse(input);
  return parseContractExitCase(await call(invoke,'update_contract_exit_case_kind_v1',{p_organization_id:z.string().uuid().parse(organizationId),p_case_id:value.caseId,p_expected_version:value.expectedVersion,p_kind:value.kind,p_reason:value.reason,p_idempotency_key:value.idempotencyKey}));
}
export async function getContractExitCase(invoke:ContractExitRpcInvoker,caseId:string,organizationId:string):Promise<ContractExitCase>{
  return parseContractExitCase(await call(invoke,'get_contract_exit_case_v1',{p_organization_id:z.string().uuid().parse(organizationId),p_case_id:z.string().uuid().parse(caseId)}));
}
export async function listContractExitCases(invoke:ContractExitRpcInvoker,filters:ContractExitCaseFilters,organizationId:string):Promise<ContractExitCasePage>{
  const value=z.object({buildingId:z.string().uuid().optional(),buildingIds:z.array(z.string().uuid()).optional(),contractId:z.string().uuid().optional(),state:z.enum(['PENDING','FINALIZED']).optional(),limit:z.number().int().min(1).max(100).default(50),offset:z.number().int().nonnegative().default(0)}).strict().parse(filters);
  const result=z.object({items:z.array(responseSchema),total:z.number().int().nonnegative(),limit:z.number().int(),offset:z.number().int(),server_today:dateSchema.optional(),server_now:z.string().optional()}).parse(await call(invoke,'list_contract_exit_cases_v1',{p_organization_id:z.string().uuid().parse(organizationId),p_building_id:value.buildingId??null,p_building_ids:value.buildingIds?.length?value.buildingIds:null,p_contract_id:value.contractId??null,p_state:value.state??null,p_limit:value.limit,p_offset:value.offset}));
  return {items:result.items!,total:result.total!,limit:result.limit!,offset:result.offset!,server_today:result.server_today,server_now:result.server_now};
}
export function contractExitErrorMessage(error:unknown):string {
  const code=(error as ContractExitRpcError|null)?.code;
  if(code==='PT409'||code==='40001') return 'Hồ sơ đã thay đổi. Vui lòng tải lại trước khi tiếp tục.';
  if(code==='42501') return 'Bạn không có quyền thực hiện thao tác trong tổ chức hoặc tòa nhà này.';
  if(code==='23505') return 'Mã yêu cầu đã được dùng với dữ liệu khác. Vui lòng tải lại hồ sơ.';
  return (error as ContractExitRpcError|null)?.message || 'Không thể xử lý hồ sơ trả phòng.';
}
