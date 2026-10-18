import { z } from 'zod';
import { invokeBankAdmin } from '@/lib/bank-events/service';

const id = z.string().uuid();
const method = z.enum(['TK', 'TT']);
const channel = z.enum(['sms.received', 'notification.received', 'email.received']);
const factSchema = z.object({ direction: z.enum(['in','out']), amount: z.number().positive(), balance: z.number().nullable(),
  account: z.string().nullable(), description: z.string().nullable(), bank: z.string().nullable(), transactedAt: z.string().nullable(),
  origin: z.string(), reference: z.string().nullable() });
const state = z.enum(['pending','unmapped','conflict','collected','linked','other','duplicate','reversed']);
export const reconciliationEventSchema = z.object({ id, sourceId:id, source:z.string(), channel, receivedAt:z.string(), facts:factSchema,
  accountId:id.nullable(), book:z.string().nullable(), method:method.nullable(), state, revision:z.number().int(),
  invoiceId:id.nullable(), collectionId:id.nullable(), reason:z.string().nullable() });
export type ReconciliationEvent = z.infer<typeof reconciliationEventSchema>;
const ruleSchema = z.object({ id, organization_id:id, source_id:id, event_type:channel, origin:z.string(), account_hint:z.string(),
  description_contains:z.string(), account_id:id, method, valid_from:z.string(), enabled:z.boolean(), revision:z.number().int() });
export type RoutingRule = z.infer<typeof ruleSchema>;
const bookSchema = z.object({id,name:z.string(),buildings:z.array(z.object({id,name:z.string(),method}))});
const candidateSchema = z.object({id,number:z.string().nullable(),building:z.string(),buildingId:id,room:z.string(),customerId:id,
  customer:z.string(),month:z.string(),remaining:z.number(),paid:z.number(),revision:z.number().int(),delta:z.number(),
  nameMatch:z.boolean(),roomMatch:z.boolean(),buildingMatch:z.boolean(),hasCarriedDebt:z.boolean()});
export type InvoiceCandidate = z.infer<typeof candidateSchema>;
const receiptSchema=z.object({id,invoiceId:id,number:z.string().nullable(),date:z.string(),amount:z.number(),room:z.string(),building:z.string(),alreadyLinked:z.boolean()});
const detailSchema=z.object({candidates:z.array(candidateSchema),existing:z.array(receiptSchema),
  possibleDuplicates:z.array(z.object({id,state:z.string(),source:z.string()})),routeCount:z.number(),decision:z.record(z.unknown()).nullable()});
export type ReconciliationDetail=z.infer<typeof detailSchema>;
export type ReconciliationFilters={sourceId?:string;accountId?:string;buildingId?:string;method?:string;channel?:string;direction?:string;
  state?:string;from?:string;to?:string;minAmount?:number;maxAmount?:number;query?:string;offset?:number;limit?:number};
export interface RuleInput { id:string; sourceId:string;eventType:z.infer<typeof channel>;origin:string;accountHint:string;contains:string;
  accountId:string;method:z.infer<typeof method>;validFrom:string;enabled:boolean;revision:number }

export function reconciliationService(actorId:string,organizationId:string) {
  const invoke=<T>(operation:string,input:Record<string,unknown>,schema:z.ZodType<T,z.ZodTypeDef,unknown>,mutation=false) =>
    invokeBankAdmin(actorId,{action:'reconcile',organizationId,operation,input},schema,mutation);
  return {
    settings:()=>invoke('settings',{},z.object({rules:z.array(ruleSchema),books:z.array(bookSchema)})),
    list:(filters:ReconciliationFilters)=>invoke('list',{...filters},z.object({events:z.array(reconciliationEventSchema)})),
    detail:(eventId:string)=>invoke('detail',{eventId},detailSchema),
    saveRule:(rule:RuleInput)=>invoke('save_rule',{...rule},z.object({saved:z.literal(true),revision:z.number().int()}),true),
    sync:(sourceId:string,cursor?:string)=>invoke('sync',{sourceId,...(cursor?{cursor}:{})},z.object({cached:z.number(),unparsed:z.number(),failed:z.number(),nextCursor:z.string().nullable()}),true),
    act:(operation:'collect'|'link'|'classify'|'undo',input:Record<string,unknown>)=>invoke(operation,input,z.object({saved:z.literal(true),eventId:id,revision:z.number().int()}),true),
  };
}

export const reconciliationStateLabel:Record<ReconciliationEvent['state'],string>={pending:'Chờ đối chiếu',unmapped:'Chưa xác định sổ',conflict:'Trùng điều kiện nguồn',
  collected:'Đã ghi thu',linked:'Đã ghép phiếu có sẵn',other:'Khoản khác',duplicate:'Tin trùng',reversed:'Đã hoàn tác'};
