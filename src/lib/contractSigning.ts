import {FinancialWorkflowError,workflowErrorMessage} from './financialWorkflow';
import {friendlyError} from './friendlyError';
import { z } from 'zod';
import type { Json } from '@/integrations/supabase/types';
import type { ContractDraft, ContractDraftDocument, ContractDraftPayload, ContractDraftSigningSource } from '@/lib/contractDrafts';
import { buildMeterBoundaryPayload, type MeterBoundaryInput } from '@/lib/contractMeterBoundaries';
import { buildFirstInvoiceItems, buildFirstInvoiceDiscount, normalizeFirstBillingPeriod, validateFirstBillingPeriod } from '@/lib/firstInvoiceBuilder';
import type { ContractCreateDepositReceiptInput, ContractCreateFirstInvoiceInput, ContractCreateRequest } from '@/lib/contractCreateRpc';

const uuid = z.string().uuid();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export interface SigningCreationOptions {
  deposit_debt_mode?: 'DEBT' | 'FIRST_INVOICE';
  deposit_debt_reason?: string;
  deposit_topup_due_date?: string;
  first_invoice?: ContractCreateFirstInvoiceInput;
  deposit_receipts?: ContractCreateDepositReceiptInput[];
  existing_deposit_voucher_ids?: string[];
  invoice_template_id?: string | null;
}
export interface PreparedSigningCreation { options: SigningCreationOptions; depositPaid: number }
/** Carry the already validated official form request into signing unchanged; no invoice rebuild. */
export function buildPreparedSigningCreation(request: ContractCreateRequest, depositPaid: number): PreparedSigningCreation {
  const paid = z.number().finite().nonnegative().parse(depositPaid);
  const { contract, first_invoice, deposit_receipts, existing_deposit_voucher_ids } = request.payload;
  return { depositPaid: paid, options: {
    ...(contract.deposit_debt_mode ? { deposit_debt_mode: contract.deposit_debt_mode } : {}),
    ...(contract.deposit_debt_reason ? { deposit_debt_reason: contract.deposit_debt_reason } : {}),
    ...(contract.deposit_topup_due_date ? { deposit_topup_due_date: contract.deposit_topup_due_date } : {}),
    ...(contract.invoice_template_id !== undefined ? { invoice_template_id: contract.invoice_template_id } : {}),
    ...(deposit_receipts ? { deposit_receipts: deposit_receipts.map(receipt => ({ ...receipt,
      ...(receipt.attachments ? { attachments: [...receipt.attachments] } : {}) })) } : {}),
    ...(existing_deposit_voucher_ids ? { existing_deposit_voucher_ids: [...existing_deposit_voucher_ids] } : {}),
    ...(first_invoice ? { first_invoice: { ...first_invoice, items: first_invoice.items.map(item => ({ ...item })) } } : {}),
  } };
}
export interface SigningCreationChoice {
  createFirstInvoice: boolean;
  depositPaid?: number;
  depositMode?: 'DEBT' | 'FIRST_INVOICE';
  debtReason?: string;
  topupDueOn?: string;
}
/** Reuses current invoice/debt choices; never creates or links a receipt. */
export function buildSigningCreationOptions(payload: ContractDraftPayload, choice: SigningCreationChoice): SigningCreationOptions {
  const options: SigningCreationOptions = {};
  const paid = z.number().finite().nonnegative().parse(choice.depositPaid ?? 0);
  if (paid > payload.form.total_deposit) throw new Error('Cọc nguồn giữ chỗ vượt cọc thoả thuận. Kiểm tra trước khi ký.');
  if (payload.form.total_deposit - paid >= 0.01) {
    if (!choice.depositMode) throw new Error('Chọn cách bổ sung khoản cọc chưa thu.');
    options.deposit_debt_mode = choice.depositMode;
    if (choice.depositMode === 'DEBT') {
      if (!choice.debtReason?.trim() || !dateOnly.safeParse(choice.topupDueOn).success) throw new Error('Nợ cọc cần lý do và hạn bổ sung.');
      options.deposit_debt_reason = choice.debtReason.trim();
      options.deposit_topup_due_date = choice.topupDueOn;
    } else if (!choice.createFirstInvoice) throw new Error('Gộp cọc cần tạo hoá đơn đầu.');
  }
  if (choice.createFirstInvoice) {
    const form = payload.form;
    const validity = validateFirstBillingPeriod(form.start_billing_date, form.end_billing_date);
    if (!validity.ok) throw new Error(validity.message);
    const period = normalizeFirstBillingPeriod(form.start_billing_date, form.end_billing_date, form.start_date);
    const support = payload.rent_support;
    const builder = { rent_support: support ? { version: support.version, start_billing_month: support.start_billing_month, segments: support.segments } : undefined, rent_price: form.rent_price, total_deposit: form.total_deposit, deposit_paid: paid,
      include_deposit: choice.depositMode === 'FIRST_INVOICE', start_billing_date: period.start_date ?? undefined,
      end_billing_date: period.end_date ?? undefined, discount_months: form.discount_months,
      discount_amount_per_month: form.discount_amount_per_month, services: payload.services.map(service => ({
        service_id: service.id, name: service.name, unit_price: service.unit_price,
        quantity: service.quantity, pricing_type: service.pricing_type,
      })) };
    const items = buildFirstInvoiceItems(builder);
    const discount = buildFirstInvoiceDiscount(builder, items);
    if ('state' in discount && discount.state === 'NEEDS_REVIEW') throw new Error(discount.notes || 'Lịch hỗ trợ cần đối chiếu.');
    if (items.length) options.first_invoice = { items: items.map(({ id: _id, ...item }) => item),
      discount_amount: discount.amount, ...(payload.rent_support ? { manual_discount_amount: '0' } : {}), discount_notes: discount.notes, issue_date: form.signed_date,
      due_date: period.end_date ?? form.start_date };
  }
  return options;
}

export interface SigningConfirmation { receivedOn: string; roomReady: boolean; termsConfirmed: boolean; metersConfirmed: boolean }
export function validateSigningConfirmation(draft: ContractDraft, document: ContractDraftDocument | undefined, confirmation: SigningConfirmation, serverToday?: string): string[] {
  const errors: string[] = [];
  if (!document || document.draft_id !== draft.id || (document.revision < (draft.customer_revision ?? draft.revision) || document.revision > draft.revision)) errors.push('Lưu và xuất đúng phiên bản nháp trước khi ký.');
  if (!dateOnly.safeParse(confirmation.receivedOn).success || confirmation.receivedOn !== draft.payload.form.start_date
    || !serverToday || confirmation.receivedOn > serverToday || draft.payload.form.signed_date > serverToday) errors.push('Ngày nhận phải trùng ngày bắt đầu đã xuất và không ở tương lai. Đổi ngày cần lưu và xuất lại nháp.');
  if (!confirmation.roomReady) errors.push('Xác nhận phòng đã sẵn sàng bàn giao.');
  if (!confirmation.termsConfirmed) errors.push('Xác nhận khách đã ký đúng tài liệu này.');
  if (!confirmation.metersConfirmed) errors.push('Cần đủ chỉ số riêng của lượt nhận phòng mới.');
  return errors;
}
export interface ContractSigningInput {
  source: ContractDraftSigningSource;
  requestId: string;
  receivedOn: string;
  roomReady: boolean;
  termsConfirmed: boolean;
  boundary: MeterBoundaryInput;
  creationOptions: SigningCreationOptions;
  reservationSource?: ReservationSigningSource;
}
export interface ReservationSigningSource { reservationId: string; revision: number; sourceVoucherIds: string[] }
export interface SigningReservationIdentity {
  id: string; organization_id: string; building_id: string; room_id: string; customer_id: string;
  status: string; claim_status: string; revision: number; received_amount: number; source_voucher_ids: string[];
  receipts: Array<{ received: boolean; approval_status: string | null }>;
}
export function matchingSigningReservations<T extends SigningReservationIdentity>(draft: ContractDraft, reservations: T[]): T[] {
  const parties = new Set(draft.payload.customers.map(customer => customer.id));
  return reservations.filter(reservation => reservation.organization_id === draft.organization_id
    && reservation.building_id === draft.building_id && reservation.room_id === draft.room_id
    && parties.has(reservation.customer_id) && reservation.status === 'HOLD' && reservation.claim_status === 'LIVE');
}
export function signingReservationReady(reservation: SigningReservationIdentity): boolean {
  return reservation.receipts.every(receipt => receipt.received && receipt.approval_status === 'APPROVED');
}
export function buildContractSigningArgs(organizationId: string, input: ContractSigningInput) {
  uuid.parse(organizationId); uuid.parse(input.source.draftId); uuid.parse(input.source.documentId); uuid.parse(input.requestId);
  sha.parse(input.source.documentSha256); z.number().int().positive().parse(input.source.revision); dateOnly.parse(input.receivedOn);
  if (!input.roomReady || !input.termsConfirmed || input.boundary.state !== 'VERIFIED') throw new Error('Chưa xác nhận đủ điều kiện nhận phòng.');
  const options = input.creationOptions;
  const reservation = input.reservationSource;
  if (reservation) {
    uuid.parse(reservation.reservationId); z.number().int().positive().parse(reservation.revision);
    z.array(uuid).parse(reservation.sourceVoucherIds);
    if (new Set(reservation.sourceVoucherIds).size !== reservation.sourceVoucherIds.length) throw new Error('Nguồn cọc bị trùng. Tải lại giữ chỗ.');
  }
  const json: Json = { ...(options.deposit_debt_mode ? { deposit_debt_mode: options.deposit_debt_mode } : {}),
    ...(options.deposit_debt_reason ? { deposit_debt_reason: options.deposit_debt_reason } : {}),
    ...(options.deposit_topup_due_date ? { deposit_topup_due_date: options.deposit_topup_due_date } : {}),
    ...(options.first_invoice ? { first_invoice: { ...options.first_invoice,
      items: options.first_invoice.items.map(item => ({ ...item })) } } : {}),
    ...(options.deposit_receipts ? { deposit_receipts: options.deposit_receipts.map(receipt => ({ ...receipt,
      ...(receipt.attachments ? { attachments: [...receipt.attachments] } : {}) })) } : {}),
    ...(options.existing_deposit_voucher_ids ? { existing_deposit_voucher_ids: [...options.existing_deposit_voucher_ids] } : {}),
    ...(options.invoice_template_id !== undefined ? { invoice_template_id: options.invoice_template_id } : {}) };
  return { p_organization_id: organizationId, p_draft_id: input.source.draftId, p_expected_revision: input.source.revision,
    p_document_id: input.source.documentId, p_document_sha256: input.source.documentSha256, p_request_id: input.requestId,
    p_received_on: input.receivedOn, p_room_ready: input.roomReady, p_terms_confirmed: input.termsConfirmed,
    p_boundary: buildMeterBoundaryPayload(input.boundary), p_creation_options: json,
    ...(reservation ? { p_reservation_id: reservation.reservationId, p_reservation_revision: reservation.revision,
      p_source_voucher_ids: [...reservation.sourceVoucherIds] } : {}) };
}

const templateDataSchema = z.record(z.union([z.string(), z.number().finite(), z.array(z.record(z.union([z.string(), z.number().finite()]))) ]));
export const contractSigningSchema = z.object({
  id: uuid, organization_id: uuid, building_id: uuid, room_id: uuid, draft_id: uuid,
  revision: z.number().int().positive(), document_id: uuid, document_sha256: sha, template_sha256: sha,
  template_path: z.string(), template_snapshot: z.object({ id: uuid, name: z.string(), updated_at: z.string() }),
  document_data: templateDataSchema, terms: z.unknown(), party_snapshot: z.array(z.record(z.unknown())), creation_options: z.record(z.unknown()),
  reservation_id: uuid.nullable().default(null), reservation_revision: z.number().int().positive().nullable().default(null), source_voucher_ids: z.array(uuid).default([]),
  received_on: dateOnly, contract_id: uuid, contract_number: z.string().min(1), request_id: uuid, signed_by: uuid, signed_at: z.string(),
  official_document_path: z.string(), official_document_sha256: sha.nullable(),
});
export type ContractSigning = z.infer<typeof contractSigningSchema>;
export const contractSigningSnapshotSchema = z.object({ server_today: dateOnly, signing: contractSigningSchema.nullable() });
export type ContractSigningSnapshot = z.infer<typeof contractSigningSnapshotSchema>;

export function signingErrorMessage(error: unknown): string {
  if(error instanceof FinancialWorkflowError)return workflowErrorMessage(error,'ghi nhận ký hợp đồng');
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === '40001') return 'Phiên bản nháp, tài liệu hoặc thông tin khách đã thay đổi. Tải lại, kiểm tra và xuất lại trước khi ký.';
  if (code === '42501' || code === '28000') return 'Bạn không có quyền thực hiện thao tác này.';
  if (code === '55P03') return 'Phòng đang có cọc hoặc giữ chỗ. Nhánh ký từ nháp chưa hỗ trợ chuyển nguồn giữ chỗ này.';
  if (code === '55000') {
    const message = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : '';
    if (message.includes('RENT_SUPPORT_WRITERS_DISABLED')) return 'Chức năng lưu lịch hỗ trợ tiền thuê chưa được bật. Nội dung đang nhập vẫn được giữ; chưa ghi nhận ký.';
    return 'Phòng hoặc mốc chỉ số chưa đủ điều kiện nhận phòng. Tải lại và kiểm tra việc bàn giao.';
  }
  if (code === '23505') return 'Bản nháp hoặc lần ký đã được dùng với nội dung khác. Tải lại để xem hợp đồng đã ghi nhận.';
  const feedback=friendlyError(error,'Chưa ghi nhận được ký hợp đồng',{operation:'ghi nhận ký hợp đồng',financial:true});
  return `${feedback.title}. ${feedback.description}`;
}
