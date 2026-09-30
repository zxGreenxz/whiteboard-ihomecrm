import {FinancialWorkflowError,workflowFeedbackDescription} from '@/lib/financialWorkflowError';
import { z } from 'zod';
import { supportCustomerScheduleSchema, supportPlanInputSchema } from './rentSupport';
import { todayISO } from '@/lib/collect';

const customerSchema = z.object({
  id: z.string().uuid(), full_name: z.string(), phone: z.string(), id_number: z.string().nullable(),
  is_representative: z.boolean(), notes: z.string().nullable(),
}).strict();
const serviceSchema = z.object({
  id: z.string().uuid(), name: z.string(), unit_price: z.number().finite().nonnegative(),
  unit: z.string().nullable(), type: z.string(), pricing_type: z.string().nullable(),
  initial_reading: z.number().finite().nonnegative(), quantity: z.number().finite().nonnegative(),
}).strict();
export type ContractDraftService = z.infer<typeof serviceSchema>;
/** Local editor input only. Saving this metadata never posts a receipt or invoice. */
export const contractDraftEditorStateSchema = z.object({
  version: z.literal(1),
  form: z.object({
    deposit_debt_acknowledged: z.boolean(),
    deposit_debt_mode: z.enum(['DEBT', 'FIRST_INVOICE']).optional(),
    deposit_debt_reason: z.string(),
    deposit_topup_due_date: z.string(),
    invoice_template_id: z.string().uuid().nullable(),
  }).strict(),
  deposit_rows: z.array(z.object({
    uid: z.string(), amount: z.number().finite().nonnegative(), account_id: z.string(),
    received_date: z.string(), images: z.array(z.string()),
  }).strict()),
  invoice_items: z.array(z.object({
    id: z.string(), type: z.enum(['RENT', 'SERVICE', 'DISCOUNT', 'OTHER']),
    accounting_class: z.enum(['REVENUE', 'DEPOSIT']), description: z.string(),
    unit_price: z.number().finite().nonnegative(), quantity: z.number().finite().nonnegative(),
    service_id: z.string().nullable().optional(), from_date: z.string().nullable().optional(),
    to_date: z.string().nullable().optional(),
  }).strict()),
  selected_services: z.array(serviceSchema),
  rent_unlocked: z.boolean(), deposit_unlocked: z.boolean(),
}).strict();
export type ContractDraftEditorState = z.infer<typeof contractDraftEditorStateSchema>;
export const draftOwnerSchema = z.object({ name: z.string(), phone: z.string(), birthday: z.string(),
  id_number: z.string(), id_issue_place: z.string(), id_issue_date: z.string() }).strict();
export type DraftOwner = z.infer<typeof draftOwnerSchema>;
export const emptyDraftOwner = (): DraftOwner => ({ name: '', phone: '', birthday: '', id_number: '', id_issue_place: '', id_issue_date: '' });

// This allowlist deliberately excludes receipt, invoice, signing and reservation inputs.
export const contractDraftPayloadSchema = z.object({
  form: z.object({
    room_id: z.string(), signed_date: z.string(), start_date: z.string(), end_date: z.string(),
    rent_price: z.number().finite().nonnegative(), total_deposit: z.number().finite().nonnegative(),
    payment_cycle: z.enum(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL']),
    start_billing_date: z.string(), end_billing_date: z.string(), notes: z.string(),
    discount_months: z.number().int().nonnegative(), discount_amount_per_month: z.number().finite().nonnegative(),
  }).strict(),
  customers: z.array(customerSchema), services: z.array(serviceSchema), use_custom_services: z.boolean(),
  owner: draftOwnerSchema.default(emptyDraftOwner),
  editor_state: contractDraftEditorStateSchema.optional(),
  rent_support: z.union([supportPlanInputSchema, supportCustomerScheduleSchema]).optional(),
}).strict().superRefine((payload, ctx) => {
  if (payload.rent_support && (payload.form.discount_months !== 0 || payload.form.discount_amount_per_month !== 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rent_support'], message: 'Lịch hỗ trợ không dùng đồng thời với giảm tiền thuê cũ.' });
  }
});
export type ContractDraftPayload = z.infer<typeof contractDraftPayloadSchema>;

export const contractDraftDocumentSchema = z.object({
  id: z.string().uuid(), draft_id: z.string().uuid(), revision: z.number().int().positive(),
  document_path: z.string(), template_path: z.string(), document_sha256: z.string(), template_sha256: z.string(),
  template_snapshot: z.object({ id: z.string().uuid(), name: z.string(), updated_at: z.string() }),
  created_at: z.string(),
});
export type ContractDraftDocument = z.infer<typeof contractDraftDocumentSchema>;
export const contractDraftSchema = z.object({
  id: z.string().uuid(), organization_id: z.string().uuid(), building_id: z.string().uuid(),
  room_id: z.string().uuid().nullable(), payload: contractDraftPayloadSchema,
  template_id: z.string().uuid().nullable(), revision: z.number().int().positive(),
  customer_revision: z.number().int().positive().nullish(),
  created_by: z.string().uuid(), created_at: z.string(), updated_at: z.string(),
  documents: z.array(contractDraftDocumentSchema).default([]),
  status: z.enum(['EDITABLE', 'SIGNED']).optional(),
  converted_contract_id: z.string().uuid().nullable().optional(),
});
export type ContractDraft = z.infer<typeof contractDraftSchema>;

/** The later signing workflow must consume this immutable document identity. */
export interface ContractDraftSigningSource {
  draftId: string;
  revision: number;
  documentId: string;
  documentSha256: string;
}

export function emptyContractDraftPayload(): ContractDraftPayload {
  return { form: { room_id: '', signed_date: todayISO(), start_date: '', end_date: '', rent_price: 0,
    total_deposit: 0, payment_cycle: 'MONTHLY', start_billing_date: '', end_billing_date: '', notes: '',
    discount_months: 0, discount_amount_per_month: 0 }, customers: [], services: [], use_custom_services: false, owner: emptyDraftOwner() };
}

export interface DraftFieldError { field: string; label: string; message: string }
function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validateDraftForExport(payload: ContractDraftPayload): DraftFieldError[] {
  const errors: DraftFieldError[] = [];
  if (!z.string().uuid().safeParse(payload.form.room_id).success) errors.push({ field: 'room_id', label: 'Phòng', message: 'Vui lòng chọn phòng' });
  for (const [field, label] of [['signed_date', 'Ngày ký dự kiến'], ['start_date', 'Ngày bắt đầu'], ['end_date', 'Hạn hợp đồng']] as const) {
    if (!isDateOnly(payload.form[field])) errors.push({ field, label, message: 'Vui lòng nhập ngày hợp lệ' });
  }
  if (isDateOnly(payload.form.start_date) && isDateOnly(payload.form.end_date) && payload.form.end_date <= payload.form.start_date) errors.push({ field: 'end_date', label: 'Hạn hợp đồng', message: 'Phải sau ngày bắt đầu' });
  const representatives = payload.customers.filter(c => c.is_representative);
  if (representatives.length !== 1) errors.push({ field: 'customers', label: 'Khách đại diện', message: 'Chọn đúng một khách đại diện' });
  else {
    const rep = representatives[0];
    if (!rep.full_name.trim()) errors.push({ field: 'customers', label: 'Tên khách đại diện', message: 'Chưa có họ tên' });
    if (!rep.id_number?.trim()) errors.push({ field: 'customers', label: 'Giấy tờ khách đại diện', message: 'Cập nhật số CCCD/hộ chiếu của khách' });
  }
  return errors;
}

const REQUIRED_TEMPLATE_FIELDS: Record<string, string> = {
  APARTMENT_NAME: 'Tên toà nhà', APARTMENT_ADDRESS: 'Địa chỉ toà nhà', ROOM_NAME: 'Tên phòng',
  OWNER_NAME: 'Tên chủ nhà', CHU_HOP_DONG: 'Tên chủ nhà', OWNER_PHONE: 'Điện thoại chủ nhà',
  OWNER_ID_NUMBER: 'Giấy tờ chủ nhà', OWNER_PLACE_OF_ISSUE: 'Nơi cấp giấy tờ chủ nhà', OWNER_ID_NUMBER_DATE: 'Ngày cấp giấy tờ chủ nhà',
  REPRESENT_NAME: 'Tên khách đại diện', REPRESENT_PHONE_NUMBER: 'Điện thoại khách đại diện',
  REPRESENT_ID_NUMBER: 'Giấy tờ khách đại diện', REPRESENT_ADDRESS: 'Địa chỉ khách đại diện',
  REPRESENT_PLACE_OF_ISSUE: 'Nơi cấp giấy tờ khách đại diện', REPRESENT_ID_NUMBER_DATE: 'Ngày cấp giấy tờ khách đại diện',
};
/** Validate identity/address fields actually referenced by the chosen DOCX, including split Word runs. */
export async function validateDraftTemplateData(buffer: ArrayBuffer, data: Record<string, unknown>): Promise<DraftFieldError[]> {
  const { default: PizZip } = await import('pizzip');
  const zip = new PizZip(buffer);
  const names = Object.keys(zip.files).filter(name => /^word\/(?:document|header\d*|footer\d*)\.xml$/.test(name));
  const tags = new Set<string>();
  for (const name of names) {
    const xml = zip.file(name)?.asText() ?? '';
    const text = xml.replace(/<[^>]+>/g, '');
    for (const match of text.matchAll(/\{([A-Z_0-9]+)\}/g)) tags.add(match[1]);
  }
  return [...tags].filter(tag => REQUIRED_TEMPLATE_FIELDS[tag] && (data[tag] == null || String(data[tag]).trim() === ''))
    .map(tag => ({ field: tag, label: REQUIRED_TEMPLATE_FIELDS[tag], message: 'Chưa có thông tin mà mẫu đã chọn yêu cầu' }));
}

export function draftDocumentPaths(draft: Pick<ContractDraft, 'organization_id' | 'building_id' | 'id' | 'revision'>, documentId: string) {
  const root = `${draft.organization_id}/${draft.building_id}/${draft.id}/${draft.revision}/${documentId}`;
  return { document: `${root}/document.docx`, template: `${root}/template.docx` };
}

/** Uploaded templates may omit a DRAFT_TITLE placeholder, so prepend a visible paragraph. */
export async function markDraftDocx(blob: Blob, revision: number): Promise<Blob> {
  const { default: PizZip } = await import('pizzip');
  const zip = new PizZip(await blob.arrayBuffer());
  const document = zip.file('word/document.xml');
  if (!document) throw new Error('Mẫu không có nội dung DOCX hợp lệ');
  const xml = document.asText();
  if (!/<w:body(?:\s[^>]*)?>/.test(xml)) throw new Error('Mẫu không có nội dung DOCX hợp lệ');
  const heading = `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="B91C1C"/></w:rPr><w:t>BẢN NHÁP — Phiên bản ${revision}</w:t></w:r></w:p>`;
  zip.file('word/document.xml', xml.replace(/(<w:body(?:\s[^>]*)?>)/, `$1${heading}`));
  return zip.generate({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

export function draftErrorMessage(error: unknown): string {
  if (error instanceof FinancialWorkflowError) return workflowFeedbackDescription(error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === '40001') return 'Bản nháp đã được người khác cập nhật. Đóng và mở lại để tải phiên bản mới; nội dung đang nhập vẫn được giữ trong cửa sổ này.';
  if (code === '42501' || code === '28000') return 'Bạn không có quyền thực hiện thao tác với bản nháp này.';
  if (code === '22023' || error instanceof z.ZodError) return 'Thông tin bản nháp chưa hợp lệ. Kiểm tra lại các trường đã nhập.';
  if (code === '55000') {
    const message = typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : '';
    if (message === 'Hủy liên kết nhượng trước khi xoá bản nháp') return 'Hủy liên kết nhượng trước khi xóa bản nháp này.';
    return 'Bản nháp đã ký hoặc đã xóa. Tải lại danh sách để kiểm tra trạng thái mới nhất.';
  }
  if (error instanceof Error && error.message.startsWith('Tài liệu:')) return error.message;
  return 'Không thể xử lý bản nháp. Vui lòng thử lại.';
}
