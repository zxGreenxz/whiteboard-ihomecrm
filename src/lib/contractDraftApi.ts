import {FinancialWorkflowError,isConfirmedFinancialRejection} from '@/lib/financialWorkflow';
import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import type { DocumentTemplate } from '@/hooks/useDocumentTemplates';
import {
  buildContractTemplateData, fetchTemplateBuffer, renderContractDocxBuffer,
  type ContractTemplateSource, type ContractTemplateData,
} from '@/lib/contractTemplateEngine';
import { contractDraftSchema, contractDraftDocumentSchema, contractDraftPayloadSchema,
  draftDocumentPaths, markDraftDocx, validateDraftForExport, validateDraftTemplateData,
  type ContractDraft, type ContractDraftPayload, type ContractDraftDocument,
} from '@/lib/contractDrafts';

import { rpcNullable } from '@/lib/rpcNullable';
const BUCKET = 'contract-draft-documents';

export async function deleteContractDraft(draft: ContractDraft): Promise<void> {
  const { data, error } = await supabase.rpc('delete_contract_draft_v1', {
    p_organization_id: draft.organization_id, p_draft_id: draft.id, p_expected_revision: draft.revision,
  });
  if (error) throw error;
  z.object({ draft_id: z.literal(draft.id), deleted: z.literal(true) }).parse(data);
}

export async function listContractDrafts(organizationId: string, buildingId?: string): Promise<ContractDraft[]> {
  const { data, error } = await supabase.rpc('list_contract_drafts', { p_organization_id: organizationId, p_building_id: buildingId });
  if (error) throw error;
  return z.array(contractDraftSchema).parse(data);
}

export interface SaveContractDraftInput {
  organizationId: string; buildingId: string; payload: ContractDraftPayload;
  templateId: string | null; draftId: string; expectedRevision?: number; requestId: string;
}
export async function saveContractDraft(input: SaveContractDraftInput): Promise<ContractDraft> {
  const payload = contractDraftPayloadSchema.parse(input.payload);
  const json: Json = { ...(payload.rent_support ? { rent_support: { ...payload.rent_support, segments: payload.rent_support.segments.map(segment => ({ ...segment })) } } : {}), form: { ...payload.form }, customers: payload.customers.map(c => ({ ...c })),
    services: payload.services.map(s => ({ ...s })), use_custom_services: payload.use_custom_services, owner: { ...payload.owner },
    ...(payload.editor_state ? { editor_state: {
      version: payload.editor_state.version, form: { ...payload.editor_state.form },
      deposit_rows: payload.editor_state.deposit_rows.map(row => ({ ...row, images: [...row.images] })),
      invoice_items: payload.editor_state.invoice_items.map(item => ({ ...item })),
      selected_services: payload.editor_state.selected_services.map(service => ({ ...service })),
      rent_unlocked: payload.editor_state.rent_unlocked, deposit_unlocked: payload.editor_state.deposit_unlocked,
    } } : {}) };
  const { data, error } = await supabase.rpc('save_contract_draft', {
    p_organization_id: input.organizationId, p_building_id: input.buildingId,
    p_room_id: rpcNullable(payload.form.room_id || null), p_payload: json, p_template_id: input.templateId ?? undefined,
    p_draft_id: input.draftId, p_expected_revision: input.expectedRevision, p_request_id: input.requestId,
  });
  if (error) throw error;
  return contractDraftSchema.parse(data);
}

async function buildDraftDocumentData(draft: ContractDraft): Promise<ContractTemplateData> {
  const customerIds = draft.payload.customers.map(c => c.id);
  const [roomResult, customersResult, buildingResult] = await Promise.all([
    supabase.from('rooms').select('*').eq('id', draft.room_id ?? '').eq('organization_id', draft.organization_id).is('deleted_at', null).single(),
    supabase.from('customers').select('*').in('id', customerIds).eq('organization_id', draft.organization_id).is('deleted_at', null),
    supabase.from('buildings').select('*').eq('id', draft.building_id).eq('organization_id', draft.organization_id).is('deleted_at', null).single(),
  ]);
  if (roomResult.error) throw roomResult.error;
  if (customersResult.error) throw customersResult.error;
  if (buildingResult.error) throw buildingResult.error;
  if (roomResult.data.building_id !== draft.building_id || customersResult.data.length !== customerIds.length) throw new Error('Tài liệu: Phòng hoặc khách hàng không còn khả dụng.');
  const building = buildingResult.data;
  const ownerResult = await supabase.from('profiles').select('full_name,phone').eq('id', building.user_id).maybeSingle();
  if (ownerResult.error) throw ownerResult.error;
  const now = draft.updated_at;
  const contract: ContractTemplateSource = {
    signed_date: draft.payload.form.signed_date, start_date: draft.payload.form.start_date,
    end_date: draft.payload.form.end_date, start_billing_date: draft.payload.form.start_billing_date,
    rent_price: draft.payload.form.rent_price, total_deposit: draft.payload.form.total_deposit,
    payment_cycle: draft.payload.form.payment_cycle, notes: draft.payload.form.notes,
    contract_number: null, initial_electricity_reading: null,
    initial_water_reading: null, actual_end_date: null,
    discounts: { months: draft.payload.form.discount_months, amount_per_month: draft.payload.form.discount_amount_per_month },
    room: { ...roomResult.data, building: { ...building, type: building.type ?? '' } },
    contract_customers: draft.payload.customers.map(c => ({
      id: c.id, contract_id: draft.id, customer_id: c.id, is_representative: c.is_representative,
      notes: c.notes, customer: customersResult.data.find(row => row.id === c.id) ?? null, created_at: now, updated_at: now,
    })),
    contract_services: draft.payload.services.map(s => ({
      id: s.id, contract_id: draft.id, service_id: s.id, unit_price: s.unit_price,
      initial_reading: s.initial_reading, service: { id: s.id, name: s.name, unit: s.unit, type: s.type, pricing_type: s.pricing_type }, created_at: now, updated_at: now,
    })),
  };
  const representative = contract.contract_customers?.find(c => c.is_representative)?.customer;
  if (!representative?.full_name?.trim() || !representative.id_number?.trim()) throw new Error('Tài liệu: Khách đại diện cần có họ tên và số CCCD/hộ chiếu.');
  return { ...buildContractTemplateData({ contract, owner: { ...draft.payload.owner,
    name: draft.payload.owner?.name || ownerResult.data?.full_name,
    phone: draft.payload.owner?.phone || ownerResult.data?.phone } }),
    DRAFT_TITLE: 'BẢN NHÁP', DRAFT_REVISION: draft.revision };
}

async function sha256(blob: Blob): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

export async function exportContractDraft(draft: ContractDraft, template: DocumentTemplate): Promise<{ document: ContractDraftDocument; blob: Blob }> {
  const previous = draft.documents.find(document => document.revision >= (draft.customer_revision ?? draft.revision) && document.revision <= draft.revision);
  if (previous) return { document: previous, blob: await downloadContractDraftDocument(previous) };
  const fieldErrors = validateDraftForExport(draft.payload);
  if (fieldErrors.length) throw new Error(`Tài liệu: ${fieldErrors.map(e => `${e.label}: ${e.message}`).join('; ')}`);
  if (draft.template_id !== template.id) throw new Error('Tài liệu: Lưu mẫu đã chọn trước khi xuất.');
  const [templateBuffer, data] = await Promise.all([fetchTemplateBuffer(template.file_url), buildDraftDocumentData(draft)]);
  const templateErrors = await validateDraftTemplateData(templateBuffer, data);
  if (templateErrors.length) throw new Error(`Tài liệu: ${templateErrors.map(e => `${e.label}: ${e.message}`).join('; ')}`);
  const templateBlob = new Blob([templateBuffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const blob = await markDraftDocx(await renderContractDocxBuffer(templateBuffer, data), draft.revision);
  const documentId = crypto.randomUUID();
  const paths = draftDocumentPaths(draft, documentId);
  const [documentHash, templateHash] = await Promise.all([sha256(blob), sha256(templateBlob)]);
  let registered = false;
  let cleanupAllowed = true;
  const uploaded: string[] = [];
  try {
    for (const [path, bytes] of [[paths.template, templateBlob], [paths.document, blob]] as const) {
      const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, { upsert: false, contentType: bytes.type });
      if (error) throw error;
      uploaded.push(path);
    }
    // After dispatch, a missing receipt is not proof that registration rolled back.
    cleanupAllowed = false;
    let document: ContractDraftDocument;
    try {
      const { data: result, error } = await supabase.rpc('register_contract_draft_document', {
        p_organization_id: draft.organization_id, p_draft_id: draft.id, p_expected_revision: draft.revision,
        p_document_id: documentId, p_template_id: template.id,
        p_template_snapshot: { id: template.id, name: template.name, updated_at: template.updated_at },
        p_document_sha256: documentHash, p_template_sha256: templateHash, p_document_data: { ...data },
      });
      if (error) throw error;
      document = contractDraftDocumentSchema.parse(result);
      const confirmedPaths = draftDocumentPaths(draft, document.id);
      if (document.draft_id !== draft.id || document.revision !== draft.revision
        || document.document_path !== confirmedPaths.document || document.template_path !== confirmedPaths.template
        || !/^[a-f0-9]{64}$/.test(document.document_sha256) || !/^[a-f0-9]{64}$/.test(document.template_sha256)
        || document.id === documentId && (document.document_sha256 !== documentHash || document.template_sha256 !== templateHash)) {
        throw new TypeError('Unconfirmed draft document registration');
      }
      registered = document.id === documentId;
      // SQL can return the document already registered for this same revision.
      // Only that positive receipt proves the newly uploaded paths are unused.
      cleanupAllowed = !registered;
    } catch (error) {
      if (isConfirmedFinancialRejection(error)) { cleanupAllowed = true; throw error; }
      throw new FinancialWorkflowError(
        `Đã tải tệp cho bản nháp ${draft.id}, nhưng chưa xác nhận được kết quả đăng ký tài liệu. Giữ mã tài liệu ${documentId} và đọc lại bản nháp trước khi xuất tiếp. Các tệp đã tải được giữ để đối chiếu.`,
        'partial', [{ id: documentId, label: 'Đã tải tệp bản nháp; đăng ký chưa xác nhận' }], error,
      );
    }
    return { document, blob: registered ? blob : await downloadContractDraftDocument(document) };
  } finally {
    if (cleanupAllowed && !registered && uploaded.length) {
      try {
        const { error } = await supabase.storage.from(BUCKET).remove(uploaded);
        if (error) console.error('Draft document cleanup failed', error);
      } catch (error) { console.error('Draft document cleanup failed', error); }
    }
  }
}

export async function downloadContractDraftDocument(document: ContractDraftDocument): Promise<Blob> {
  const { data, error } = await supabase.storage.from(BUCKET).download(document.document_path);
  if (error || !data) throw error ?? new Error('Không thể tải tài liệu nháp');
  if (await sha256(data) !== document.document_sha256) throw new Error('Tài liệu: Nội dung lưu trữ không khớp bản nháp đã xuất.');
  return data;
}
