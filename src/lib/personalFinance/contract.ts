import { z } from 'zod';

const uuid = z.string().uuid();
const version = z.number().int().positive();
const name = z.string().trim().min(1).max(80);
const icon = z.string().trim().min(1).max(32);
const amount = z.number().int().positive().max(1e12);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => s >= '1900-01-01' && s <= '9999-12-31' && Number.isFinite(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s, 'Ngày không hợp lệ');
const type = z.enum(['INCOME', 'EXPENSE']);
const walletData = z.object({ name, kind: z.enum(['cash', 'bank', 'ewallet', 'saving', 'other']).optional(), icon: icon.optional(), opening_balance: z.number().int().min(-1e12).max(1e12).optional(), hidden: z.boolean().optional() }).strict();
const categoryData = z.object({ type, name, icon: icon.optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), hidden: z.boolean().optional() }).strict();
const budgetData = z.object({ category_id: uuid.nullable().optional(), amount }).strict();
const goalData = z.object({ name, icon: icon.optional(), target: amount, target_date: dateSchema.nullable().optional(), wallet_id: uuid }).strict();
const transferData = z.object({ source_wallet_id: uuid, target_wallet_id: uuid, amount, txn_date: dateSchema, note: z.string().trim().max(500).nullable().optional(), goal_id: uuid.nullable().optional() }).strict();
export const personalAttachmentPathSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|jpeg|png|webp)$/);
export const personalAttachmentPathsSchema = z.array(personalAttachmentPathSchema).max(20);
export const transactionDataSchema = z.object({ type, amount, txn_date: dateSchema, description: z.string().trim().max(500).nullable().optional(), wallet_id: uuid, category_id: uuid, attachment_paths: personalAttachmentPathsSchema.optional() }).strict();
const definitions = { wallet: walletData, category: categoryData, budget: budgetData, goal: goalData, transfer: transferData, transaction: transactionDataSchema };
export type Entity = keyof typeof definitions;
export type Mutation = {
 action: `${Entity}.${'create' | 'update' | 'delete'}` | 'transaction.batch';
 id?: string; expected_version?: number; data?: Record<string, unknown>; rows?: z.infer<typeof transactionDataSchema>[];
};
// A concrete common shape keeps caller construction ergonomic; superRefine dispatches to strict entity schemas.
export const mutationSchema = z.object({
 action: z.string(), id: uuid.optional(), expected_version: version.optional(), data: z.record(z.unknown()).optional(), rows: z.array(transactionDataSchema).min(1).max(200).optional(),
}).strict().superRefine((input, ctx) => {
 const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
 if (input.action === 'transaction.batch') {
  if (!input.rows || input.data || input.id || input.expected_version) fail('Batch chỉ nhận rows');
  return;
 }
 const [entity, op, extra] = input.action.split('.');
 if (!entity || !(entity in definitions) || !['create', 'update', 'delete'].includes(op ?? '') || extra) { fail('Thao tác không hợp lệ'); return; }
 if (input.rows || !input.data) { fail('Cần data'); return; }
 if (op === 'create' && (input.id || input.expected_version)) fail('Create không nhận id/version');
 if (op !== 'create' && (!input.id || !input.expected_version)) fail('Cần id và expected_version');
 const schema = definitions[entity as Entity];
 const parsed = op === 'delete' ? z.object({}).strict().safeParse(input.data) : (op === 'update' ? schema.partial() : schema).safeParse(input.data);
 if (!parsed.success) parsed.error.issues.forEach(issue => ctx.addIssue({ ...issue, path: ['data', ...issue.path] }));
 if (op === 'update' && !Object.keys(input.data).length) fail('Cần ít nhất một thay đổi');
 if (entity === 'transfer' && input.data.source_wallet_id && input.data.source_wallet_id === input.data.target_wallet_id) fail('Ví nhận phải khác ví gửi');
}).transform(input => {
 const data = input.data && Object.fromEntries(Object.entries(input.data).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
 return { ...input, ...(data ? { data } : {}) } as Mutation;
});
export const normalizeMutation = (input: unknown): Mutation => mutationSchema.parse(input);
const base = z.object({ id: uuid, user_id: uuid, version });
export const walletSchema = base.extend({ name, kind: z.enum(['cash', 'bank', 'ewallet', 'saving', 'other']), icon, opening_balance: z.number().finite(), hidden: z.boolean(), is_default: z.boolean(), balance: z.number().finite() });
// Legacy labels use PostgreSQL character/space rules; output must not trim or apply new-input UTF-16 limits.
export const categorySchema = base.extend({ type, name: z.string().min(1), icon, color: z.string(), hidden: z.boolean(), seed_key: z.string().nullable(), legacy_name: z.string().nullable() });
export const transactionSchema = base.extend({ type, amount: z.number().finite().nonnegative(), txn_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), description: z.string().nullable(), category: z.string().nullable(), wallet_id: uuid.nullable(), category_id: uuid.nullable(), resolved_wallet_id: uuid, resolved_category_id: uuid.nullable(), attachment_paths: personalAttachmentPathsSchema.default([]), created_at: z.string().datetime({ offset: true }), updated_at: z.string().datetime({ offset: true }), deleted_at: z.string().datetime({ offset: true }).nullable() });
export const transferSchema = base.extend({ source_wallet_id: uuid, target_wallet_id: uuid, amount, txn_date: dateSchema, note: z.string().nullable(), goal_id: uuid.nullable(), deleted_at: z.string().nullable() });
export const budgetSchema = base.extend({ category_id: uuid.nullable(), amount, type: z.literal('EXPENSE') });
export const goalSchema = base.extend({ name, icon, target: amount, target_date: dateSchema.nullable(), wallet_id: uuid, saved: z.number().finite().nonnegative() });
export const snapshotSchema = z.object({ owner_id: uuid, schema_version: z.literal(1), wallets: z.array(walletSchema), categories: z.array(categorySchema), transactions: z.array(transactionSchema), transfers: z.array(transferSchema), budgets: z.array(budgetSchema), goals: z.array(goalSchema) });
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Wallet = z.infer<typeof walletSchema>;
export type Category = z.infer<typeof categorySchema>;
export type PersonalTransaction = z.infer<typeof transactionSchema>;
export type Transfer = z.infer<typeof transferSchema>;
export type Budget = z.infer<typeof budgetSchema>;
export type Goal = z.infer<typeof goalSchema>;
export const receiptSchema = z.object({ owner_id: uuid, request_key: uuid, action: z.string(), entities: z.array(base.passthrough()).min(1).max(200) });
export type Receipt = z.infer<typeof receiptSchema>;
export function parseSnapshot(input: unknown, owner: string): Snapshot {
 const result = snapshotSchema.parse(input);
 if (result.owner_id !== owner || [...result.wallets, ...result.categories, ...result.transactions, ...result.transfers, ...result.budgets, ...result.goals].some(row => row.user_id !== owner)) throw new Error('Snapshot owner mismatch');
 return result;
}
export function parseReceipt(input: unknown, owner: string, key: string, action: string): Receipt {
 const result = receiptSchema.parse(input);
 if (result.owner_id !== owner || result.request_key !== key || result.action !== action || result.entities.some(row => row.user_id !== owner)) throw new Error('Receipt mismatch');
 const [entity, op] = action.split('.');
 const schemas = { wallet: walletSchema.omit({ balance: true }), category: categorySchema, transaction: transactionSchema.omit({ resolved_wallet_id: true, resolved_category_id: true }), transfer: transferSchema, budget: budgetSchema, goal: goalSchema.omit({ saved: true }) };
 if (!entity || !(entity in schemas)) throw new Error('Unknown receipt entity');
 if (op !== 'batch' && result.entities.length !== 1) throw new Error('Unexpected receipt count');
 for (const row of result.entities) {
  if (op === 'delete') base.extend({ deleted: z.literal(true) }).parse(row);
  else {
   schemas[entity as Entity].parse(row);
   if(entity==='transaction'&&row.attachment_paths===undefined)row.attachment_paths=[];
  }
 }
 return result;
}
