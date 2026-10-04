import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';

const uuid = z.string().uuid();
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp');
const nullableTimestamp = timestamp.nullable();
const bankAccount = z.string().regex(/^\d{6,30}$/);
const bankEmailV5ReceiptSchema = z.object({
  collection_id: uuid,
  invoice_id: uuid,
  gross_amount: z.number().int().positive(),
  applied_amount: z.number().int().positive(),
  change_amount: z.number().int(),
  credit_amount: z.number().int(),
  rounding_amount: z.number().int(),
  credit_lot_id: uuid.nullable(),
  tenders: z.array(z.object({
    tender_id: uuid,
    payment_id: uuid,
    voucher_id: uuid,
    applied_amount: z.number().int().positive(),
  })).length(1),
  invoice: z.object({ id: uuid }).passthrough(),
}).passthrough().superRefine((value, context) => {
  if (value.gross_amount !== value.applied_amount || value.tenders[0]?.applied_amount !== value.gross_amount ||
      value.change_amount !== 0 || value.credit_amount !== 0 || value.rounding_amount !== 0 ||
      value.credit_lot_id !== null || value.invoice.id !== value.invoice_id) {
    context.addIssue({ code: 'custom', message: 'V5 receipt does not confirm an exact single tender' });
  }
});

export const bankEmailConnectionSchema = z.object({
  id: uuid,
  organizationId: uuid,
  bankAccount,
  accountId: uuid,
  enabled: z.boolean(),
  autoEnabledAt: nullableTimestamp,
  status: z.enum(['DISCONNECTED', 'AUTHORIZING', 'CONNECTED', 'RECONNECT_REQUIRED']),
  email: z.string().email().nullable(),
  lastSyncedAt: nullableTimestamp,
  lastError: z.string().nullable(),
  createdAt: timestamp,
}).superRefine((value, context) => {
  if (value.enabled && (value.status !== 'CONNECTED' || value.autoEnabledAt === null)) {
    context.addIssue({ code: 'custom', message: 'Enabled connection lacks a live Gmail link or cutoff' });
  }
});

export const bankEmailTransactionSchema = z.object({
  id: uuid,
  connectionId: uuid,
  messageId: z.string().min(1),
  internalDate: timestamp,
  verified: z.boolean(),
  account: bankAccount.nullable(),
  amount: z.number().int().positive().nullable(),
  balance: z.number().int().nonnegative().nullable(),
  currency: z.string().nullable(),
  direction: z.string().nullable(),
  occurredAt: nullableTimestamp,
  bankReference: z.string().nullable(),
  description: z.string().nullable(),
  status: z.enum(['PENDING', 'POSTED', 'IGNORED']),
  reason: z.string().nullable(),
  invoiceId: uuid.nullable(),
  receipt: bankEmailV5ReceiptSchema.nullable(),
  createdAt: timestamp,
}).superRefine((value, context) => {
  if (value.status === 'POSTED' && (!value.invoiceId || !value.receipt || value.receipt.invoice_id !== value.invoiceId || value.receipt.gross_amount !== value.amount)) {
    context.addIssue({ code: 'custom', message: 'Posted transaction lacks a V5 receipt' });
  }
});

export const bankEmailReceiptSchema = z.object({
  id: uuid,
  status: z.enum(['PENDING', 'POSTED', 'IGNORED']),
  reason: z.string().nullable(),
  invoiceId: uuid.nullable(),
  receipt: bankEmailV5ReceiptSchema.nullable(),
}).superRefine((value, context) => {
  if (value.status === 'POSTED' && (!value.invoiceId || !value.receipt || value.receipt.invoice_id !== value.invoiceId)) {
    context.addIssue({ code: 'custom', message: 'Posted review lacks matching V5 receipt' });
  }
});

const bankEmailListSchema = z.object({
  connections: z.array(bankEmailConnectionSchema),
  transactions: z.array(bankEmailTransactionSchema),
  hasMore: z.boolean(),
});

export type BankEmailConnection = z.infer<typeof bankEmailConnectionSchema>;
export type BankEmailTransaction = z.infer<typeof bankEmailTransactionSchema>;
export type BankEmailList = z.infer<typeof bankEmailListSchema>;
export type BankEmailReceipt = z.infer<typeof bankEmailReceiptSchema>;
export type BankEmailReviewAction = 'post' | 'ignore';
export type BankEmailReviewExpectation =
  | { transactionId: string; action: 'post'; expectedInvoiceId: string; expectedAmount: number }
  | { transactionId: string; action: 'ignore' };

export class BankEmailUnconfirmedError extends Error {
  override name = 'BankEmailUnconfirmedError';
  constructor() {
    super('Chưa xác nhận được kết quả. Tải lại hộp giao dịch và đối chiếu trước khi thao tác tiếp.');
  }
}

export class BankEmailActualOutcomeError extends Error {
  override name = 'BankEmailActualOutcomeError';
  constructor(readonly actual: BankEmailReceipt) {
    super(actual.status === 'POSTED'
      ? `Kết quả ghi thu khác lựa chọn vừa gửi: giao dịch đã ghi thu ${actual.receipt ? `${new Intl.NumberFormat('vi-VN').format(actual.receipt.gross_amount)} ₫` : 'một khoản tiền'}. Xem hóa đơn đã ghi thu để đối chiếu.`
      : `Giao dịch hiện ở trạng thái ${actual.status === 'IGNORED' ? 'đã bỏ qua' : 'chờ đối soát'}; khác thao tác vừa gửi. Tải lại để đối chiếu.`);
  }
}

export class BankEmailReviewPendingError extends Error {
  override name = 'BankEmailReviewPendingError';
  constructor(readonly reason: string | null) {
    super('Máy chủ chưa ghi thu giao dịch. Kiểm tra mã hóa đơn, số còn phải thu và quyền nhận tiền trước khi thử lại.');
  }
}

export function bankEmailQueryKey(actorId: string | null, organizationId: string | null) {
  return ['bank-email', actorId, organizationId] as const;
}

export function parseBankEmailList(payload: unknown, organizationId: string): BankEmailList {
  const parsed = bankEmailListSchema.parse(payload);
  if (parsed.connections.some(connection => connection.organizationId !== organizationId)) throw new TypeError('Bank email response crosses organization');
  const connectionIds = new Set(parsed.connections.map(connection => connection.id));
  if (parsed.transactions.some(transaction => !connectionIds.has(transaction.connectionId))) throw new TypeError('Bank email transaction lacks owning connection');
  return parsed;
}

export function parseBankEmailReceipt(payload: unknown, transactionId: string): BankEmailReceipt {
  const parsed = bankEmailReceiptSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== transactionId) throw new BankEmailUnconfirmedError();
  return parsed.data;
}

export function parseBankEmailReview(payload: unknown, expected: BankEmailReviewExpectation): BankEmailReceipt {
  const receipt = parseBankEmailReceipt(payload, expected.transactionId);
  if (expected.action === 'post') {
    if (receipt.status === 'PENDING') throw new BankEmailReviewPendingError(receipt.reason);
    if (receipt.status !== 'POSTED') throw new BankEmailActualOutcomeError(receipt);
    if (receipt.invoiceId !== expected.expectedInvoiceId || !receipt.receipt || receipt.receipt.gross_amount !== expected.expectedAmount) throw new BankEmailActualOutcomeError(receipt);
  } else if (receipt.status !== 'IGNORED') {
    if (receipt.status === 'PENDING') throw new BankEmailReviewPendingError(receipt.reason);
    throw new BankEmailActualOutcomeError(receipt);
  }
  return receipt;
}

type BankEmailRpcName =
  | 'bank_email_setup_v1'
  | 'bank_email_set_enabled_v1'
  | 'bank_email_disconnect_v1'
  | 'bank_email_review_v1'
  | 'bank_email_list_v1'
  | 'bank_email_transaction_v1'
  | 'bank_email_my_connections_v1';
type BankEmailRpc = (name: BankEmailRpcName, args: Record<string, unknown>) => PromiseLike<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

// Schema is generated from production, while these RPCs first land on the TEST project.
const callBankEmailRpc: BankEmailRpc = (name, args) =>
  (supabase.rpc as unknown as BankEmailRpc)(name, args);

async function rpc(name: BankEmailRpcName, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await callBankEmailRpc(name, args);
  if (error) throw error;
  return data;
}

export async function listBankEmail(organizationId: string, before: string | null = null): Promise<BankEmailList> {
  uuid.parse(organizationId);
  return parseBankEmailList(await rpc('bank_email_list_v1', {
    p_organization_id: organizationId,
    p_before: before,
    p_limit: 30,
  }), organizationId);
}

export async function setupBankEmail(organizationId: string, accountNumber: string, cashbookId: string): Promise<BankEmailConnection> {
  uuid.parse(organizationId);
  uuid.parse(cashbookId);
  const number = bankAccount.parse(accountNumber.trim());
  const connection = bankEmailConnectionSchema.parse(await rpc('bank_email_setup_v1', {
    p_organization_id: organizationId,
    p_bank_account: number,
    p_account_id: cashbookId,
  }));
  if (connection.organizationId !== organizationId || connection.bankAccount !== number || connection.accountId !== cashbookId) throw new BankEmailUnconfirmedError();
  return connection;
}

export async function setBankEmailEnabled(connectionId: string, enabled: boolean): Promise<BankEmailConnection> {
  uuid.parse(connectionId);
  const connection = bankEmailConnectionSchema.parse(await rpc('bank_email_set_enabled_v1', {
    p_connection_id: connectionId,
    p_enabled: enabled,
  }));
  if (connection.id !== connectionId || connection.enabled !== enabled) throw new BankEmailUnconfirmedError();
  return connection;
}

export async function disconnectBankEmail(connectionId: string): Promise<BankEmailConnection> {
  uuid.parse(connectionId);
  const connection = bankEmailConnectionSchema.parse(await rpc('bank_email_disconnect_v1', { p_connection_id: connectionId }));
  if (connection.id !== connectionId || connection.enabled || connection.status !== 'DISCONNECTED') throw new BankEmailUnconfirmedError();
  return connection;
}

export async function reviewBankEmail(input: BankEmailReviewExpectation & { invoiceNumber?: string }): Promise<BankEmailReceipt> {
  uuid.parse(input.transactionId);
  const exactNumber = input.invoiceNumber?.trim() ?? '';
  if (input.action === 'post') {
    uuid.parse(input.expectedInvoiceId);
    if (!Number.isSafeInteger(input.expectedAmount) || input.expectedAmount <= 0 || !exactNumber) throw new Error('Chọn đúng hóa đơn và kiểm tra số tiền giao dịch trước khi xác nhận.');
  }
  return parseBankEmailReceipt(await rpc('bank_email_review_v1', {
    p_transaction_id: input.transactionId,
    p_invoice_number: input.action === 'ignore' ? '' : exactNumber,
    p_ignore: input.action === 'ignore',
    p_expected_invoice_id: input.action === 'post' ? input.expectedInvoiceId : null,
    p_expected_amount: input.action === 'post' ? input.expectedAmount : null,
  }), input.transactionId);
}

export async function readBankEmailTransaction(transactionId: string): Promise<BankEmailTransaction> {
  uuid.parse(transactionId);
  const transaction = bankEmailTransactionSchema.parse(await rpc('bank_email_transaction_v1', { p_transaction_id: transactionId }));
  if (transaction.id !== transactionId) throw new BankEmailUnconfirmedError();
  return transaction;
}

export const bankEmailOwnedConnectionSchema = z.object({
  id: uuid,
  organizationId: uuid,
  email: z.string().email().nullable(),
  status: z.enum(['DISCONNECTED', 'AUTHORIZING', 'CONNECTED', 'RECONNECT_REQUIRED']),
});
export type BankEmailOwnedConnection = z.infer<typeof bankEmailOwnedConnectionSchema>;

export async function listOwnedBankEmailConnections(): Promise<BankEmailOwnedConnection[]> {
  const result = z.object({ connections: z.array(bankEmailOwnedConnectionSchema) }).parse(await rpc('bank_email_my_connections_v1', {}));
  return result.connections;
}

export function bankEmailWorkerUrl(): string | null {
  const configured = import.meta.env.VITE_BANK_EMAIL_WORKER_URL?.trim();
  if (!configured) return null;
  const relativeProxy = configured === '/api/bank-email' || configured === '/api/bank-email/';
  if (configured.startsWith('/') && !relativeProxy) return null;
  // Invalid optional configuration is an explicit unavailable state, shown by the panel.
  const parsed = z.string().url().safeParse(relativeProxy ? globalThis.location?.origin : configured);
  if (!parsed.success) return null;
  const url = relativeProxy ? new URL('/api/bank-email/', parsed.data) : new URL(parsed.data);
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
  return url.toString();
}

export async function startBankEmailOAuth(connectionId: string): Promise<string> {
  uuid.parse(connectionId);
  const worker = bankEmailWorkerUrl();
  if (!worker) throw new Error('Máy chủ kết nối Gmail chưa được cấu hình.');
  const { data: session, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const token = session.session?.access_token;
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  const endpoint = new URL('oauth/start', worker.endsWith('/') ? worker : `${worker}/`);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId }),
      credentials: 'omit',
    });
  } catch {
    throw new Error('Chưa liên hệ được máy chủ kết nối Gmail.');
  }
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Phiên hoặc quyền kết nối Gmail không hợp lệ.' : 'Chưa bắt đầu được kết nối Gmail.');
  const payload: unknown = await response.json();
  const result = z.object({ url: z.string().url() }).parse(payload);
  const redirect = new URL(result.url);
  if (redirect.origin !== 'https://accounts.google.com') throw new TypeError('Unexpected Gmail authorization destination');
  return redirect.toString();
}
