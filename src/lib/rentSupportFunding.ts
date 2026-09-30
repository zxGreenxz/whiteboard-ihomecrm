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
 via: z.enum(['CONTRACT', 'DEPOSIT']).nullable().optional(), capAmount: legacyMoney, note: z.string().optional(),
}).refine(value => value.alreadyPaid === !!value.voucherId, 'Voucher existence does not match response');
/** Legacy alreadyPaid is a duplicate-voucher marker, never actual cash evidence. */
export function parseSaleBonusStatus(value: unknown) {
 const row = saleBonusStatusSchema.parse(value);
 return { contractId: row.contractId, alreadyPaid: row.alreadyPaid, hasVoucher: row.alreadyPaid,
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
 .refine(value => new Set(value.intents.map(x=>x.kind)).size === value.intents.length && new Set(value.intents.map(x=>x.intent_id)).size === value.intents.length,'Trùng ý định chi');
/** Funding preview only. The actionable Task6 quote must also hash the full canonical payout payload. */
export type PayoutPreviewContext = z.infer<typeof payoutPreviewContextSchema>;
export const supportPartySchema = z.object({party_id:uuid.nullable(),kind:z.enum(['INTERNAL','EXTERNAL']),profile_id:uuid.nullable(),display_name:z.string()}).strict();
export const supportPartyListSchema = z.object({rows:z.array(supportPartySchema),total:z.number().int().nonnegative()}).strict();
export type SupportParty = z.infer<typeof supportPartySchema>;