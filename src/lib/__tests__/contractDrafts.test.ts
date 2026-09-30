import { describe, expect, it } from 'vitest';
import PizZip from 'pizzip';
import {
  contractDraftPayloadSchema, emptyContractDraftPayload, validateDraftForExport,
  draftDocumentPaths, markDraftDocx, draftErrorMessage, validateDraftTemplateData, compatibleDraftDocument,
} from '../contractDrafts';

describe('persisted contract drafts', () => {
  it('rejects document snapshots older than customer revision while reusing compatible funding revisions', () => {
    const document = { revision: 1 } as never;
    expect(compatibleDraftDocument({ documents: [document], revision: 3, customer_revision: 1 })).toBe(document);
    expect(compatibleDraftDocument({ documents: [document], revision: 3, customer_revision: 2 })).toBeUndefined();
    expect(compatibleDraftDocument({ documents: [document], revision: 3 })).toBeUndefined();
  });
  it('distinguishes disabled support writers from signed or deleted drafts', () => {
    expect(draftErrorMessage({ code: '55000', message: 'RENT_SUPPORT_WRITERS_DISABLED' })).toContain('chưa được bật');
    expect(draftErrorMessage({ code: '55000', message: 'already signed' })).toContain('đã ký hoặc đã xóa');
  });
  it('allows incomplete drafting without collecting deposit or generating an invoice', () => {
    expect(contractDraftPayloadSchema.safeParse(emptyContractDraftPayload()).success).toBe(true);
    const unsafe = { ...emptyContractDraftPayload(), deposit_receipts: [{ amount: 100 }] };
    expect(contractDraftPayloadSchema.safeParse(unsafe).success).toBe(false);
    expect(contractDraftPayloadSchema.safeParse({ ...emptyContractDraftPayload(), form: { ...emptyContractDraftPayload().form, deposit_paid: 100 } }).success).toBe(false);
  });
  it('returns readable document field errors without applying signing/deposit rules', () => {
    const errors = validateDraftForExport(emptyContractDraftPayload());
    expect(errors.map(e => e.label)).toEqual(expect.arrayContaining(['Phòng', 'Ngày bắt đầu', 'Hạn hợp đồng', 'Khách đại diện']));
    const payload = emptyContractDraftPayload();
    Object.assign(payload.form, { room_id: '11111111-1111-4111-8111-111111111111', start_date: '2026-09-28', end_date: '2027-09-28', signed_date: '2026-09-28', rent_price: 100, total_deposit: 200 });
    payload.customers = [{ id: '22222222-2222-4222-8222-222222222222', full_name: 'Nguyễn Văn A', phone: '0900000000', id_number: '012345678901', is_representative: true, notes: null }];
    expect(validateDraftForExport(payload)).toEqual([]);
    payload.form.end_date = '2026-09-01';
    expect(validateDraftForExport(payload)).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'end_date' })]));
  });
  it('rejects impossible date-only document values', () => {
    const payload = emptyContractDraftPayload();
    payload.form.start_date = '2026-02-31';
    expect(validateDraftForExport(payload)).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'start_date' })]));
  });
  it('reports actual identity and address fields requested by the selected template', async () => {
    const zip = new PizZip();
    zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>{OWNER_NAME} {REPRESENT_</w:t></w:r><w:r><w:t>ADDRESS} {NOTE} {CONTRACT_NUMBER}</w:t></w:r></w:p></w:body></w:document>');
    const errors = await validateDraftTemplateData(zip.generate({type:'arraybuffer'}), {OWNER_NAME:'',REPRESENT_ADDRESS:'',NOTE:'',CONTRACT_NUMBER:''});
    expect(errors.map(e => e.label)).toEqual(['Tên chủ nhà', 'Địa chỉ khách đại diện']);
  });
  it('binds both stored artifacts to org, building, draft and exact revision', () => {
    expect(draftDocumentPaths({ organization_id: 'org', building_id: 'building', id: 'draft', revision: 3 }, 'document')).toEqual({ document: 'org/building/draft/3/document/document.docx', template: 'org/building/draft/3/document/template.docx' });
  });
  it('places BẢN NHÁP visibly in the document even when a template has no draft placeholder', async () => {
    const zip = new PizZip();
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>HỢP ĐỒNG</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
    const result = await markDraftDocx(new Blob([zip.generate({ type: 'uint8array' })]), 7);
    const marked = new PizZip(await result.arrayBuffer()).file('word/document.xml')?.asText();
    expect(marked).toContain('BẢN NHÁP');
    expect(marked).toContain('Phiên bản 7');
    expect(marked).toContain('HỢP ĐỒNG');
    expect(marked?.indexOf('BẢN NHÁP')).toBeLessThan(marked?.indexOf('HỢP ĐỒNG') ?? 0);
  });
  it('distinguishes concurrency and permission failures for the user', () => {
    expect(draftErrorMessage({ code: '40001' })).toContain('người khác');
    expect(draftErrorMessage({ code: '42501' })).toContain('quyền');
    expect(draftErrorMessage({ code: '22023' }).toLowerCase()).toContain('thông tin');
  });
});
