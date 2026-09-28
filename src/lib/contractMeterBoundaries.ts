import { z } from 'zod';
import type { Json } from '@/integrations/supabase/types';
export type MeterBoundaryKind='MOVE_IN'|'MOVE_OUT';
export type MeterBoundaryState='VERIFIED'|'MISSING'|'REVIEW';
export interface MeterBoundaryReadingInput {meterId:string;reading:number;measuredAt:string;evidence?:string|null}
export type MeterBoundaryInput={state:'VERIFIED';readings:MeterBoundaryReadingInput[]} | {state:'MISSING';reason:string};
const uuid=z.string().uuid();
const inputSchema=z.discriminatedUnion('state',[
  z.object({state:z.literal('VERIFIED'),readings:z.array(z.object({meterId:uuid,reading:z.number().finite().nonnegative(),measuredAt:z.string().datetime({offset:true}),evidence:z.string().nullable().optional()}).strict())}).strict(),
  z.object({state:z.literal('MISSING'),reason:z.string().trim().min(1)}).strict(),
]);
export function buildMeterBoundaryPayload(input:MeterBoundaryInput):Json {
  const value=inputSchema.parse(input);
  return value.state==='MISSING'?{state:value.state,reason:value.reason,readings:[]}:
    {state:value.state,reason:null,readings:value.readings.map(r=>({meter_id:r.meterId,reading:r.reading,measured_at:r.measuredAt,evidence:r.evidence??null}))};
}
const stateSchema=z.enum(['VERIFIED','MISSING','REVIEW']);
const readingSchema=z.object({id:uuid,meter_id:uuid,meter_code:z.string().nullable().optional(),meter_type:z.string().nullable().optional(),reading:z.number().finite().nonnegative().nullable(),measured_at:z.string().nullable(),evidence:z.string().nullable(),state:stateSchema,recorded_by:uuid,recorded_at:z.string()});
const setSchema=z.object({id:uuid,organization_id:uuid,building_id:uuid,room_id:uuid,contract_id:uuid,kind:z.enum(['MOVE_IN','MOVE_OUT']),effective_on:z.string(),state:stateSchema,revision:z.number().int().positive(),reason:z.string().nullable(),recorded_by:uuid,created_at:z.string(),updated_at:z.string(),readings:z.array(readingSchema),affected_invoice_ids:z.array(uuid),history:z.array(z.object({revision:z.number().int().positive(),reason:z.string(),changed_by:uuid,changed_at:z.string()})).default([])});
export type ContractMeterBoundarySet=z.infer<typeof setSchema>;
export interface ReviseMeterBoundaryInput {setId:string;expectedRevision:number;idempotencyKey:string;reason:string;boundary:MeterBoundaryInput}
export type MeterBoundaryRpcName='read_contract_meter_boundary_set_v1'|'revise_contract_meter_boundary_set_v1'|'read_contract_meter_interval_v1';
export interface MeterBoundaryError {code?:string;message?:string}
export type MeterBoundaryInvoker=(name:MeterBoundaryRpcName,args:Record<string,Json>)=>PromiseLike<{data:unknown;error:MeterBoundaryError|null}>;
async function call(invoke:MeterBoundaryInvoker,name:MeterBoundaryRpcName,args:Record<string,Json>){const result=await invoke(name,args);if(result.error)throw result.error;return result.data;}
export async function readMeterBoundarySet(invoke:MeterBoundaryInvoker,organizationId:string,contractId:string,kind:MeterBoundaryKind):Promise<ContractMeterBoundarySet|null>{
  const result=await call(invoke,'read_contract_meter_boundary_set_v1',{p_organization_id:uuid.parse(organizationId),p_contract_id:uuid.parse(contractId),p_kind:z.enum(['MOVE_IN','MOVE_OUT']).parse(kind)});
  return result===null?null:setSchema.parse(result);
}
export function buildReviseMeterBoundaryArgs(organizationId:string,input:ReviseMeterBoundaryInput){
  const value=z.object({setId:uuid,expectedRevision:z.number().int().positive(),idempotencyKey:z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/),reason:z.string().trim().min(1),boundary:z.unknown()}).strict().parse(input);
  return {p_organization_id:uuid.parse(organizationId),p_set_id:value.setId,p_expected_revision:value.expectedRevision,p_idempotency_key:value.idempotencyKey,p_reason:value.reason,p_payload:buildMeterBoundaryPayload(input.boundary)};
}
export async function reviseMeterBoundarySet(invoke:MeterBoundaryInvoker,organizationId:string,input:ReviseMeterBoundaryInput):Promise<ContractMeterBoundarySet>{
  return setSchema.parse(await call(invoke,'revise_contract_meter_boundary_set_v1',buildReviseMeterBoundaryArgs(organizationId,input)));
}
const pointSchema=z.object({id:uuid,kind:z.enum(['MOVE_IN','MOVE_OUT']),reading:z.number().finite().nonnegative(),measured_at:z.string()});
const intervalSchema=z.object({contract_id:uuid,meter_id:uuid,state:z.literal('VERIFIED'),predecessor:pointSchema,end:pointSchema.nullable()});
export type ContractMeterInterval=z.infer<typeof intervalSchema>;
export async function readMeterInterval(invoke:MeterBoundaryInvoker,organizationId:string,contractId:string,meterId:string,at:string):Promise<ContractMeterInterval>{
  return intervalSchema.parse(await call(invoke,'read_contract_meter_interval_v1',{p_organization_id:uuid.parse(organizationId),p_contract_id:uuid.parse(contractId),p_meter_id:uuid.parse(meterId),p_at:z.string().datetime({offset:true}).parse(at)}));
}
