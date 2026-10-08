import { z } from 'zod';

const uuid = z.string().uuid();
export const companyWalletKindSchema = z.enum(['cash', 'bank', 'sp_card', 'credit_card']);
export type CompanyWalletKind = z.infer<typeof companyWalletKindSchema>;
const fields = z.object({
 name: z.string().trim().min(1).max(80), icon: z.string().trim().min(1).max(32).optional(),
 kind: companyWalletKindSchema, account_id: uuid, is_preferred: z.boolean().optional(), hidden: z.boolean().optional(),
}).strict();
export type CompanyWalletData = z.infer<typeof fields>;
export const companyWalletMutationSchema = z.object({
 requestKey: uuid, action: z.enum(['create', 'update', 'delete']), id: uuid.optional(),
 expectedVersion: z.number().int().positive().optional(), data: fields.partial().optional(),
}).strict().superRefine((input, ctx) => {
 const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
 if (input.action === 'create') {
  if (input.id || input.expectedVersion) fail('Ví mới không nhận mã hoặc phiên bản cũ.');
  if (!fields.safeParse(input.data).success) fail('Ví mới cần tên, loại ví và sổ quỹ.');
 } else if (!input.id || !input.expectedVersion) fail('Cần mã ví và phiên bản hiện tại.');
 if (input.action === 'update' && !Object.keys(input.data ?? {}).length) fail('Cần ít nhất một thay đổi.');
 if (input.action === 'delete' && Object.keys(input.data ?? {}).length) fail('Xóa ví không nhận dữ liệu sửa.');
});
export type CompanyWalletMutation = z.infer<typeof companyWalletMutationSchema>;
export const companyWalletRecordSchema = z.object({
 id: uuid, user_id: uuid, organization_id: uuid, name: z.string(), icon: z.string(), kind: companyWalletKindSchema,
 account_id: uuid, is_preferred: z.boolean(), hidden: z.boolean(), version: z.number().int().positive(),
});
export const companyWalletSchema = companyWalletRecordSchema.extend({
 account_name: z.string().nullable(), balance: z.number().finite().nullable(), balance_visible: z.boolean(), can_use: z.boolean(),
}).superRefine((wallet, ctx) => {
 if (wallet.balance_visible !== (wallet.balance !== null)) ctx.addIssue({ code: 'custom', message: 'Quyền xem số dư không khớp dữ liệu.' });
});
export type CompanyWallet = z.infer<typeof companyWalletSchema>;
export const companyWalletTransactionSchema = z.object({
 id: uuid, wallet_id: uuid, user_id: uuid, organization_id: uuid, code: z.string().nullable(),
 type: z.enum(['INCOME', 'EXPENSE']), name: z.string(), total_amount: z.number().finite().nonnegative(),
 voucher_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), approval_status: z.enum(['UNAPPROVED', 'APPROVED', 'CANCELLED']),
 posting_status: z.string().nullable(), review_state: z.string().nullable(), attachments: z.array(z.string()),
 created_at: z.string(), deleted_at: z.string().nullable(),
});
export type CompanyWalletTransaction = z.infer<typeof companyWalletTransactionSchema>;
export const companyWalletSnapshotSchema = z.object({
 owner_id: uuid, organization_id: uuid, schema_version: z.literal(1),
 wallets: z.array(companyWalletSchema), transactions: z.array(companyWalletTransactionSchema),
});
export type CompanyWalletSnapshot = z.infer<typeof companyWalletSnapshotSchema>;
export function parseCompanyWalletSnapshot(input: unknown, ownerId: string, organizationId: string): CompanyWalletSnapshot {
 const result = companyWalletSnapshotSchema.parse(input);
 if (result.owner_id !== ownerId || result.organization_id !== organizationId ||
  [...result.wallets, ...result.transactions].some(row => row.user_id !== ownerId || row.organization_id !== organizationId) ||
  result.transactions.some(row => !result.wallets.some(wallet => wallet.id === row.wallet_id))) throw new Error('Company wallet snapshot scope mismatch');
 return result;
}
export const companyWalletMutationReceiptSchema = z.object({
 owner_id: uuid, organization_id: uuid, request_key: uuid, action: z.enum(['create', 'update', 'delete']),
 wallet: z.union([companyWalletRecordSchema, z.object({ id: uuid, user_id: uuid, organization_id: uuid, version: z.number().int().positive(), deleted: z.literal(true) })]),
});
export type CompanyWalletMutationReceipt = z.infer<typeof companyWalletMutationReceiptSchema>;
export const companyWalletVoucherReceiptSchema = z.object({
 id: uuid, organization_id: uuid, wallet_id: uuid, account_id: uuid, user_id: uuid, maker_user_id: uuid.nullable().optional(),
 code: z.string().nullable(), approval_status: z.enum(['UNAPPROVED', 'APPROVED', 'CANCELLED']), posting_status: z.string().nullable(), origin: z.literal('personal_wallet'),
}).passthrough();
export type CompanyWalletVoucherReceipt = z.infer<typeof companyWalletVoucherReceiptSchema>;
