// Trả phòng trước hạn: ba trường hợp (nhờ sale tìm khách sang phòng, tự tìm khách sang phòng, chủ nhà hỗ trợ
// thanh lý sớm), giữ phòng, phí môi giới, phiếu hoa hồng — plan sang nhượng phòng, đợt 2 (chủ duyệt 24/11/2026).
// Máy chủ: migration 20261124075933_tra_phong_truoc_han_ba_truong_hop. Luật nằm ở máy chủ; ở đây chỉ kiểm dạng dữ
// liệu, dựng tham số và đọc kết quả.
import { z } from 'zod';
import type { Json } from '@/integrations/supabase/types';
import type { ExtraChargeItem } from '@/lib/contractValidation';

export const EARLY_REASONS = ['SALE_ASSISTED', 'SELF_FOUND', 'LANDLORD_AGREEMENT'] as const;
export type EarlyReason = typeof EARLY_REASONS[number];
/** Hai trường hợp đã có khách nhận phòng: giữ phòng, chỉ quyết toán sau khi có hợp đồng khách mới. */
export const TRANSFER_REASONS: readonly EarlyReason[] = ['SALE_ASSISTED', 'SELF_FOUND'];
export const isTransferReason = (reason: EarlyReason | null | undefined): reason is 'SALE_ASSISTED' | 'SELF_FOUND' =>
  reason === 'SALE_ASSISTED' || reason === 'SELF_FOUND';

/** "HĐ <số>" cho câu chữ; số đã mang tiền tố HD/HĐ (HD-2026-00419) thì để nguyên, tránh "HĐ HD-…". */
export function contractNumberLabel(value: string | null | undefined): string {
  const number = value?.trim() ?? '';
  if (!number) return 'HĐ';
  return /^H[DĐ](?![A-Za-zÀ-ỹ])/i.test(number) ? number : `HĐ ${number}`;
}

export const EARLY_REASON_LABELS: Record<EarlyReason, string> = {
  SALE_ASSISTED: 'Nhờ sale tìm khách sang phòng',
  SELF_FOUND: 'Tự tìm khách sang phòng',
  LANDLORD_AGREEMENT: 'Chủ nhà hỗ trợ thanh lý sớm',
};
export const EARLY_REASON_NOTES: Record<EarlyReason, string> = {
  SALE_ASSISTED: 'Đã có khách nhận phòng qua sale. Phòng giữ 3 ngày cho khách nhận, không rao bán. Quyết toán sau khi có hợp đồng khách mới; phí môi giới mặc định 50% cọc cũ, phiếu hoa hồng cho sale lập sau quyết toán.',
  SELF_FOUND: 'Khách cũ tự tìm được người nhận phòng. Phòng giữ 3 ngày cho khách nhận, không rao bán. Quyết toán sau khi có hợp đồng khách mới; hợp đồng khách mới không có hoa hồng môi giới hay thưởng sale.',
  LANDLORD_AGREEMENT: 'Chủ nhà đồng ý cho thanh lý sớm. Phòng rao bán lại ngay; quyết toán như bình thường, không có phí môi giới.',
};

const uuid = z.string().guid();
const money = z.number().finite();
const earlyReasonSchema = z.enum(EARLY_REASONS);
const requestIdSchema = uuid;

export const earlyTermsSchema = z.object({
  exit_case_id: uuid, contract_id: uuid, organization_id: uuid, building_id: uuid, room_id: uuid,
  early_reason: earlyReasonSchema, sale_name: z.string().nullable(),
  deposit_base: money, broker_fee: money, fee_applied_at: z.string().nullable(),
  hold_until: z.string().nullable(), reopened_at: z.string().nullable(), reopened_by: uuid.nullable(),
  reopened_by_name: z.string().nullable(), expiry_notified_at: z.string().nullable(),
  new_contract_id: uuid.nullable(), new_contract_number: z.string().nullable(), linked_at: z.string().nullable(),
  new_contract_deposit_paid: money.nullable(), new_contract_total_deposit: money.nullable(),
  new_contract_start_date: z.string().nullable(), new_contract_billing_start: z.string().nullable(),
  support_amount: money, support_out_voucher_id: uuid.nullable().optional(), support_in_voucher_id: uuid.nullable().optional(),
  /** Mã hai phiếu chuyển cọc (khách cũ hỗ trợ khách nhận); có từ migration 20261124154554. */
  support_out_code: z.string().nullable().optional(), support_in_code: z.string().nullable().optional(),
  commission_voucher_id: uuid.nullable(), commission_code: z.string().nullable(),
  /** Phiếu hoa hồng đã nối còn hiệu lực (chưa huỷ/xoá). false: lập lại được phiếu mới. */
  commission_live: z.boolean().nullable().optional(),
  commission_approval_status: z.string().nullable(),
  version: z.number().int().positive(), created_by: uuid, created_by_name: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(),
  old_contract_number: z.string().nullable(), old_customer_name: z.string().nullable(),
  building_name: z.string().nullable(), room_name: z.string().nullable(), actual_move_out_on: z.string(),
  exit_state: z.enum(['PENDING', 'FINALIZED']), exit_version: z.number().int().positive(),
  current_kind: z.enum(['NATURAL_EXPIRY', 'EARLY_RETURN', 'FORFEIT']), old_contract_deposit_paid: money.nullable(),
  pending_link: z.boolean(), hold_open: z.boolean(),
  history: z.array(z.object({
    event: z.string(), version: z.number().int().positive(), reason: z.string(), actor_id: uuid.nullable(),
    actor_name: z.string().nullable(), payload: z.unknown(), created_at: z.string(),
  })),
});
export type ContractExitEarlyTerms = z.infer<typeof earlyTermsSchema>;

/** Phần trường hợp gửi kèm khi xác nhận trả phòng (confirm_contract_return_v2.p_early_terms). */
export interface EarlyTermsChoice { earlyReason: EarlyReason; saleName?: string | null }
export function buildEarlyTermsPayload(choice: EarlyTermsChoice): Json {
  const value = z.object({ earlyReason: earlyReasonSchema, saleName: z.string().trim().max(200).nullable().optional() }).strict()
    .parse(choice);
  const saleName = value.saleName?.trim() || null;
  if (value.earlyReason === 'SALE_ASSISTED' && !saleName) throw new Error('Nhờ sale tìm khách sang phòng cần ghi tên sale / môi giới');
  return value.earlyReason === 'SALE_ASSISTED'
    ? { early_reason: value.earlyReason, sale_name: saleName }
    : { early_reason: value.earlyReason };
}

export type ExitEarlyTermsRpcName =
  | 'read_contract_exit_early_terms_v1' | 'set_contract_exit_early_terms_v1' | 'update_contract_exit_broker_fee_v1'
  | 'reopen_contract_exit_hold_v1' | 'extend_contract_exit_hold_v1' | 'create_contract_exit_commission_v1'
  | 'reverse_contract_exit_support_v1';
export interface ExitEarlyTermsRpcError { code?: string; message?: string; details?: string | null; hint?: string | null }
export type ExitEarlyTermsInvoker = (name: ExitEarlyTermsRpcName, args: Record<string, Json | undefined>) =>
  PromiseLike<{ data: unknown; error: ExitEarlyTermsRpcError | null }>;

async function call(invoke: ExitEarlyTermsInvoker, name: ExitEarlyTermsRpcName, args: Record<string, Json | undefined>) {
  const result = await invoke(name, args);
  if (result.error) throw result.error;
  return result.data;
}

export type EarlyTermsFilter = { contractId: string } | { exitCaseId: string } | { roomId: string };
export async function readExitEarlyTerms(invoke: ExitEarlyTermsInvoker, filter: EarlyTermsFilter, organizationId: string) {
  const value = z.union([
    z.object({ contractId: uuid }).strict(), z.object({ exitCaseId: uuid }).strict(), z.object({ roomId: uuid }).strict(),
  ]).parse(filter);
  return z.array(earlyTermsSchema).parse(await call(invoke, 'read_contract_exit_early_terms_v1', {
    p_organization_id: uuid.parse(organizationId),
    p_contract_id: 'contractId' in value ? value.contractId : null,
    p_exit_case_id: 'exitCaseId' in value ? value.exitCaseId : null,
    p_room_id: 'roomId' in value ? value.roomId : null,
  }));
}

export interface SetEarlyTermsInput {
  caseId: string; expectedVersion: number; requestId: string; earlyReason: EarlyReason; saleName?: string | null; reason: string;
}
export async function setExitEarlyTerms(invoke: ExitEarlyTermsInvoker, input: SetEarlyTermsInput, organizationId: string) {
  const value = z.object({ caseId: uuid, expectedVersion: z.number().int().nonnegative(), requestId: requestIdSchema,
    earlyReason: earlyReasonSchema, saleName: z.string().trim().max(200).nullable().optional(),
    reason: z.string().trim().min(1, 'Ghi lý do chọn hoặc đổi trường hợp').max(2000) }).strict().parse(input);
  const saleName = value.earlyReason === 'SALE_ASSISTED' ? value.saleName?.trim() || null : null;
  if (value.earlyReason === 'SALE_ASSISTED' && !saleName) throw new Error('Nhờ sale tìm khách sang phòng cần ghi tên sale / môi giới');
  return earlyTermsSchema.parse(await call(invoke, 'set_contract_exit_early_terms_v1', {
    p_organization_id: uuid.parse(organizationId), p_exit_case_id: value.caseId, p_expected_version: value.expectedVersion,
    p_request_id: value.requestId, p_early_reason: value.earlyReason, p_sale_name: saleName, p_reason: value.reason,
  }));
}

export interface UpdateBrokerFeeInput { caseId: string; expectedVersion: number; requestId: string; brokerFee: number; reason: string }
export async function updateExitBrokerFee(invoke: ExitEarlyTermsInvoker, input: UpdateBrokerFeeInput, organizationId: string) {
  const value = z.object({ caseId: uuid, expectedVersion: z.number().int().positive(), requestId: requestIdSchema,
    brokerFee: z.number().finite().nonnegative('Phí môi giới không được âm'),
    reason: z.string().trim().min(1, 'Ghi lý do sửa phí môi giới').max(2000) }).strict().parse(input);
  return earlyTermsSchema.parse(await call(invoke, 'update_contract_exit_broker_fee_v1', {
    p_organization_id: uuid.parse(organizationId), p_exit_case_id: value.caseId, p_expected_version: value.expectedVersion,
    p_request_id: value.requestId, p_broker_fee: value.brokerFee, p_reason: value.reason,
  }));
}

export interface HoldActionInput { caseId: string; expectedVersion: number; requestId: string; reason?: string | null; days?: number }
export async function reopenExitHold(invoke: ExitEarlyTermsInvoker, input: HoldActionInput, organizationId: string) {
  const value = z.object({ caseId: uuid, expectedVersion: z.number().int().positive(), requestId: requestIdSchema,
    reason: z.string().trim().max(2000).nullable().optional() }).strict().parse(input);
  return earlyTermsSchema.parse(await call(invoke, 'reopen_contract_exit_hold_v1', {
    p_organization_id: uuid.parse(organizationId), p_exit_case_id: value.caseId, p_expected_version: value.expectedVersion,
    p_request_id: value.requestId, p_reason: value.reason?.trim() || null,
  }));
}
export async function extendExitHold(invoke: ExitEarlyTermsInvoker, input: HoldActionInput, organizationId: string) {
  const value = z.object({ caseId: uuid, expectedVersion: z.number().int().positive(), requestId: requestIdSchema,
    days: z.number().int().min(1).max(30).default(3), reason: z.string().trim().max(2000).nullable().optional() }).strict().parse(input);
  return earlyTermsSchema.parse(await call(invoke, 'extend_contract_exit_hold_v1', {
    p_organization_id: uuid.parse(organizationId), p_exit_case_id: value.caseId, p_expected_version: value.expectedVersion,
    p_request_id: value.requestId, p_days: value.days, p_reason: value.reason?.trim() || null,
  }));
}

export interface CreateExitCommissionInput {
  caseId: string; expectedVersion: number; requestId: string;
  accountId?: string | null; recipientBank?: string | null; recipientAccount?: string | null;
}
export async function createExitCommission(invoke: ExitEarlyTermsInvoker, input: CreateExitCommissionInput, organizationId: string) {
  const value = z.object({ caseId: uuid, expectedVersion: z.number().int().positive(), requestId: requestIdSchema,
    accountId: uuid.nullable().optional(), recipientBank: z.string().trim().max(200).nullable().optional(),
    recipientAccount: z.string().trim().max(200).nullable().optional() }).strict().parse(input);
  return earlyTermsSchema.parse(await call(invoke, 'create_contract_exit_commission_v1', {
    p_organization_id: uuid.parse(organizationId), p_exit_case_id: value.caseId, p_expected_version: value.expectedVersion,
    p_request_id: value.requestId, p_account_id: value.accountId ?? null,
    p_recipient_bank: value.recipientBank?.trim() || null, p_recipient_account: value.recipientAccount?.trim() || null,
  }));
}

export interface ReverseExitSupportInput { caseId: string; expectedVersion: number; requestId: string; reason: string }
/** Đảo số tiền khách cũ hỗ trợ khách mới: huỷ đúng cặp phiếu chuyển cọc, cọc hai bên về như trước (hồ sơ còn chờ quyết toán). */
export async function reverseExitSupport(invoke: ExitEarlyTermsInvoker, input: ReverseExitSupportInput, organizationId: string) {
  const value = z.object({ caseId: uuid, expectedVersion: z.number().int().positive(), requestId: requestIdSchema,
    reason: z.string().trim().min(1, 'Ghi lý do đảo số tiền khách cũ hỗ trợ').max(2000) }).strict().parse(input);
  return earlyTermsSchema.parse(await call(invoke, 'reverse_contract_exit_support_v1', {
    p_organization_id: uuid.parse(organizationId), p_exit_case_id: value.caseId, p_expected_version: value.expectedVersion,
    p_request_id: value.requestId, p_reason: value.reason,
  }));
}
/** Hồ sơ có số hỗ trợ còn đảo được (chưa quyết toán khách cũ). */
export function canReverseExitSupport(terms: Pick<ContractExitEarlyTerms, 'support_amount' | 'exit_state'> | null | undefined) {
  return !!terms && terms.support_amount > 0 && terms.exit_state === 'PENDING';
}

/** Phí mặc định của máy chủ: 50% cọc theo hợp đồng cũ (làm tròn đồng), không vượt cọc đã thu. */
export function isDefaultBrokerFee(terms: Pick<ContractExitEarlyTerms, 'broker_fee' | 'deposit_base' | 'old_contract_deposit_paid'>) {
  const half = Math.round(terms.deposit_base * 0.5);
  return terms.broker_fee === Math.min(half, Math.max(terms.old_contract_deposit_paid ?? half, 0));
}
/** Dòng phí môi giới bắt buộc ở quyết toán ca nhờ sale (kind BROKER_FEE, đúng số đã ghi ở hồ sơ). */
export function brokerFeeLine(terms: Pick<ContractExitEarlyTerms, 'early_reason' | 'broker_fee' | 'deposit_base' | 'old_contract_deposit_paid'>): ExtraChargeItem | null {
  if (terms.early_reason !== 'SALE_ASSISTED' || !(terms.broker_fee > 0)) return null;
  return {
    kind: 'BROKER_FEE',
    description: isDefaultBrokerFee(terms) ? 'Phí môi giới (50% cọc cũ)' : 'Phí môi giới sang nhượng phòng',
    amount: terms.broker_fee,
  };
}
/** Khoản thu thêm gửi máy chủ: bỏ mọi dòng BROKER_FEE do người dùng tự thêm, nối đúng một dòng của hồ sơ. */
export function withBrokerFeeLine(charges: ExtraChargeItem[], line: ExtraChargeItem | null): ExtraChargeItem[] {
  const rest = charges.filter(item => item.kind !== 'BROKER_FEE');
  return line ? [...rest, line] : rest;
}
/** Hồ sơ sang nhượng mà hợp đồng mới tính tiền từ chính ngày bàn giao ⇒ khách cũ được hoàn tiền phòng từ ngày đó. */
export function refundFromHandoverDate(terms: Pick<ContractExitEarlyTerms, 'early_reason' | 'new_contract_billing_start' | 'actual_move_out_on'> | null | undefined) {
  return !!terms && isTransferReason(terms.early_reason) && !!terms.new_contract_billing_start
    && terms.new_contract_billing_start === terms.actual_move_out_on;
}
/** Đã nối phiếu hoa hồng còn hiệu lực (phiếu đã huỷ/xoá thì coi như chưa có, lập lại được). */
export function hasLiveExitCommission(terms: Pick<ContractExitEarlyTerms, 'commission_voucher_id' | 'commission_live'>) {
  return !!terms.commission_voucher_id && terms.commission_live !== false;
}
/** Hồ sơ nhờ sale đã quyết toán, có phí mà chưa có phiếu hoa hồng còn hiệu lực. */
export function needsExitCommission(terms: Pick<ContractExitEarlyTerms, 'early_reason' | 'broker_fee' | 'exit_state' | 'commission_voucher_id' | 'commission_live' | 'new_contract_id'> | null | undefined) {
  return !!terms && terms.early_reason === 'SALE_ASSISTED' && terms.broker_fee > 0 && terms.exit_state === 'FINALIZED'
    && !hasLiveExitCommission(terms) && !!terms.new_contract_id;
}
export function newContractDepositFull(terms: Pick<ContractExitEarlyTerms, 'new_contract_deposit_paid' | 'new_contract_total_deposit'>) {
  return terms.new_contract_deposit_paid !== null && terms.new_contract_total_deposit !== null
    && terms.new_contract_deposit_paid >= terms.new_contract_total_deposit;
}

/** Câu báo phân biệt lỗi quyền, lỗi kiểm tra dữ liệu, lỗi phiên bản và luật nghiệp vụ của máy chủ. */
export function exitEarlyTermsErrorMessage(error: unknown): string {
  const e = error as ExitEarlyTermsRpcError | null;
  if (error instanceof z.ZodError) return error.issues[0]?.message || 'Dữ liệu chưa hợp lệ.';
  if (e?.code === 'PT409' || e?.code === '40001') return 'Hồ sơ vừa thay đổi ở nơi khác. Tải lại hồ sơ rồi làm lại.';
  if (e?.code === '42501') return 'Bạn không có quyền xử lý hồ sơ trả phòng ở toà này (cần quyền thanh lý hợp đồng).';
  if (e?.code === '23505') return 'Mã yêu cầu đã dùng cho dữ liệu khác. Tải lại hồ sơ rồi làm lại.';
  if (e?.code === '22023') return e.message ? `Dữ liệu chưa hợp lệ: ${e.message}` : 'Dữ liệu chưa hợp lệ.';
  if (e?.code === '55000') return e.message || 'Hồ sơ chưa đủ điều kiện cho thao tác này.';
  return e?.message || (error instanceof Error ? error.message : 'Chưa xử lý được hồ sơ trả phòng trước hạn.');
}
