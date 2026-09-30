import { z } from 'zod';
const uuid = z.string().uuid();
const money = z.string().regex(/^\d+(?:\.\d+)?$/);
export const fundingSourceQuoteSchema = z.object({
 source_id: uuid, kind: z.enum(['COMMISSION', 'BONUS']), gross_original: money,
 already_paid: money, prior_withheld: money, remaining_payable: money, available_to_withhold: money,
 current_withheld: money, net_this_operation: money, origin: z.enum(['EXISTING', 'PROPOSED']), intent_id: uuid.nullable(), route: z.enum(['CASHBOOK', 'MANAGER_PAYROLL']),
}).strict();
export type FundingSourceQuote = z.infer<typeof fundingSourceQuoteSchema>;
const legacyMoney = z.union([z.number().finite().nonnegative(), money]).transform(Number).pipe(z.number().finite().nonnegative()).nullable().optional();
const saleBonusStatusSchema = z.object({
 contractId: uuid, alreadyPaid: z.boolean(), voucherId: uuid.nullable().optional(),
 code: z.string().nullable().optional(), amount: legacyMoney, voucherDate: z.string().nullable().optional(),
 createdAt: z.string().nullable().optional(), status: z.string().nullable().optional(),
 via: z.enum(['CONTRACT', 'DEPOSIT']).nullable().optional(), capAmount: legacyMoney, note: z.string().optional(), settledBySupport:z.boolean().optional(),
}).refine(value => value.alreadyPaid === !!value.voucherId, 'Voucher existence does not match response');
/** Legacy alreadyPaid is a duplicate-voucher marker, never actual cash evidence. */
export function parseSaleBonusStatus(value: unknown) {
 const row = saleBonusStatusSchema.parse(value);
 return { contractId: row.contractId, alreadyPaid: row.alreadyPaid, hasVoucher: row.alreadyPaid, settledBySupport:row.settledBySupport ?? false,
  cashPaymentStatus: 'UNVERIFIED' as const, voucherId: row.voucherId ?? null, code: row.code ?? null,
  amount: row.amount ?? null, voucherDate: row.voucherDate ?? null, createdAt: row.createdAt ?? null,
  status: row.status ?? null, via: row.via ?? null, capAmount: row.capAmount ?? null, note: row.note ?? '' };
}

export const payoutPreviewIntentSchema = z.object({
 intent_id: uuid, kind: z.enum(['COMMISSION','BONUS']), party_id: uuid,
 gross_amount: money.refine(value => /[1-9]/.test(value), 'Số tiền phải lớn hơn 0'),
 route: z.enum(['CASHBOOK','MANAGER_PAYROLL']), manager_id: uuid.nullable(), account_id: uuid.nullable(),
 voucher_date: z.string().date(),
}).strict().refine(value => (value.route === 'MANAGER_PAYROLL') === (value.manager_id !== null), 'Quản lý không khớp luồng chi');
export const payoutPreviewContextSchema = z.object({version:z.literal(1),intents:z.array(payoutPreviewIntentSchema).max(2)}).strict()
 .refine(value => new Set((value.intents??[]).map(x=>x.kind)).size === (value.intents??[]).length && new Set((value.intents??[]).map(x=>x.intent_id)).size === (value.intents??[]).length,'Trùng ý định chi');
/** Funding preview only. The actionable Task6 quote must also hash the full canonical payout payload. */
export type PayoutPreviewContext = z.infer<typeof payoutPreviewContextSchema>;
const payoutIntentFieldsSchema = payoutPreviewIntentSchema.innerType().extend({
 source_id:uuid.nullable(),payer_name:z.string().nullable(),recipient_name:z.string().nullable(),
 recipient_bank:z.string().nullable(),recipient_account:z.string().nullable(),item_description:z.string().nullable(),attachments:z.array(z.string()),
}).strict();
const routeMatches=(value:{route?:string;manager_id?:string|null})=>(value.route==='MANAGER_PAYROLL')===(value.manager_id!=null);
const uniqueIntents=(value:{intents?:Array<{kind?:string;intent_id?:string}>})=>{const intents=value.intents??[];return new Set(intents.map(x=>x.kind)).size===intents.length && new Set(intents.map(x=>x.intent_id)).size===intents.length;};
export const payoutContextV2Schema=z.object({version:z.literal(2),intents:z.array(payoutIntentFieldsSchema.refine(routeMatches,'Quản lý không khớp luồng chi')).min(1).max(2)}).strict().refine(uniqueIntents,'Trùng ý định chi');
export const depositAdoptionIntentFieldsSchema=payoutIntentFieldsSchema.extend({
 action:z.literal('ADOPT_DEPOSIT_BONUS'),kind:z.literal('BONUS'),source_id:uuid,
 route:z.literal('CASHBOOK'),manager_id:z.null(),
 deposit_claim_id:uuid,deposit_voucher_id:uuid,bonus_voucher_id:uuid,
 expected_approval_version:z.number().int().nonnegative(),expected_posting_version:z.number().int().nonnegative(),
 item_ids:z.array(uuid).min(1).refine(ids=>new Set(ids).size===ids.length,'Trùng phần quyền lợi'),
 source_facts_hash:z.string().min(1),reason:z.string().trim().min(8).max(1000),
}).strict();
export const payoutContextV3Schema=z.object({version:z.literal(3),intents:z.array(z.union([
 payoutIntentFieldsSchema.extend({action:z.literal('ISSUE_NEW'),source_id:z.null()}).strict().refine(routeMatches,'Quản lý không khớp luồng chi'),
 depositAdoptionIntentFieldsSchema,
])).min(1).max(2)}).strict().refine(uniqueIntents,'Trùng ý định chi');
export const payoutContextSchema=z.union([payoutContextV2Schema,payoutContextV3Schema]);
export type PayoutContext=z.infer<typeof payoutContextSchema>;
export const depositPayeeVerificationFactsSchema=z.object({
 source_id:uuid,claim_id:uuid,deposit_voucher_id:uuid,bonus_voucher_id:uuid,item_ids:z.array(uuid).min(1),
 approval_version:z.number().int().nonnegative(),posting_version:z.number().int().nonnegative(),gross:money,proof_hash:z.string().min(1),
}).strict();
export const depositPayeeVerificationSchema=z.object({binding_id:uuid,party_id:uuid,status:z.literal('MANUALLY_VERIFIED'),proof_hash:z.string().min(1)}).strict();
export const depositAdoptionCandidateSchema=z.object({
 verification:depositPayeeVerificationFactsSchema.nullable().optional(),

 version:z.literal(1),state:z.enum(['READY','NO_CANDIDATE','NEEDS_REVIEW']),plan_revision:z.number().int().positive(),
 candidate:z.object({source_id:uuid,claim_id:uuid,deposit_voucher_id:uuid,bonus_voucher_id:uuid,item_ids:z.array(uuid).min(1),
 approval_version:z.number().int().nonnegative(),posting_version:z.number().int().nonnegative(),
 gross:money,current_net:money,already_paid:money,proof_hash:z.string().min(1),
 intent_template:depositAdoptionIntentFieldsSchema.omit({intent_id:true,reason:true}),
 }).strict().nullable(),issues:z.array(z.object({code:z.string(),message:z.string()}).strict()),
}).strict().refine(r=>(r.state==='READY')===(r.candidate!==null),'Nguồn chưa sẵn sàng để tiếp nhận')
 .refine(r=>{
 const c=r.candidate;if(!c)return true;const t=c.intent_template;
 return c.source_id===t.source_id&&c.claim_id===t.deposit_claim_id&&c.deposit_voucher_id===t.deposit_voucher_id&&c.bonus_voucher_id===t.bonus_voucher_id
 &&c.approval_version===t.expected_approval_version&&c.posting_version===t.expected_posting_version&&c.proof_hash===t.source_facts_hash
 &&c.gross===t.gross_amount&&!/[1-9]/.test(c.already_paid)&&c.item_ids.join('|')===t.item_ids.join('|');
 },'Bằng chứng nguồn không khớp ý định tiếp nhận');

export type DepositAdoptionCandidate=z.infer<typeof depositAdoptionCandidateSchema>;
/** Compare decimal money without losing precision through Number conversion. */
function moneyBalances(gross:string,held:string,net:string) {
 const values=[gross,held,net],scale=Math.max(...values.map(x=>(x.split('.')[1]??'').length));
 const scaled=(x:string)=>{const [whole='',fraction='']=x.split('.');return BigInt(whole+fraction.padEnd(scale,'0'));};
 const g=scaled(gross),h=scaled(held),n=scaled(net);
 return g===h+n;
}
export const payoutSourceReceiptSchema=z.object({source_id:uuid,operation_id:uuid,kind:z.enum(['broker','sale']),gross:money,withheld:money,net:money,
 status:z.enum(['COMPLETED','SETTLED_BY_SUPPORT']),voucher_id:uuid.nullable(),id:uuid.nullable(),code:z.string().nullable(),
}).strict().refine(s=>moneyBalances(s.gross,s.withheld,s.net) && s.voucher_id===s.id &&
 (s.status==='SETTLED_BY_SUPPORT' ? !/[1-9]/.test(s.net)&&s.id===null&&s.code===null : /[1-9]/.test(s.net)&&s.id!==null),'Phiếu không khớp số tiền hoặc trạng thái');
const payoutPendingSchema=z.object({operation_id:uuid,status:z.enum(['READY','FAILED']),sources:z.array(payoutSourceReceiptSchema).length(0),
 issue:z.object({code:z.literal('PAYOUT_FAILED'),message:z.string()}).strict().optional(),
}).strict();
export const payoutOperationSchema=z.union([
 z.object({operation_id:uuid,status:z.literal('COMPLETED'),sources:z.array(payoutSourceReceiptSchema).min(1).max(2)}).strict()
  .refine(r=>r.sources.every(s=>s.operation_id===r.operation_id)&&new Set(r.sources.map(s=>s.source_id)).size===r.sources.length,'Nguồn không khớp thao tác'),
 payoutPendingSchema,
 z.object({operation_id:uuid.nullable(),status:z.literal('NOT_FOUND')}).strict(),
]);
export type PayoutOperation=z.infer<typeof payoutOperationSchema>;
export const payoutPreparationSchema=z.object({operation_id:uuid,status:z.enum(['READY','COMPLETED'])}).strict();
export type PayoutPreparation=z.infer<typeof payoutPreparationSchema>;
export const supportPartySchema = z.object({party_id:uuid.nullable(),kind:z.enum(['INTERNAL','EXTERNAL']),profile_id:uuid.nullable(),display_name:z.string()}).strict();
export const supportPartyListSchema = z.object({rows:z.array(supportPartySchema),total:z.number().int().nonnegative()}).strict();
export type SupportParty = z.infer<typeof supportPartySchema>;
