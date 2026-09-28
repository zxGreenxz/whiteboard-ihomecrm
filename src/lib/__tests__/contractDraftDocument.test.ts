import { describe, expect, it, vi } from 'vitest';
import PizZip from 'pizzip';
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { buildContractTemplateData, renderContractDocxBuffer, type ContractTemplateSource } from '../contractTemplateEngine';
import { markDraftDocx } from '../contractDrafts';

describe('draft DOCX through the existing real renderer', () => {
  it('renders tenant, room and rent into a real DOCX with a visible draft title and no official number', async () => {
    const template = new PizZip();
    template.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    template.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    template.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Khách: {REPRESENT_NAME}; Phòng: {ROOM_NAME}; Tiền thuê: {RENT_PRICE}; Số: {CONTRACT_NUMBER}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
    const source: ContractTemplateSource = {
      contract_number: null, signed_date:'2026-09-28',start_date:'2026-10-01',end_date:'2027-10-01',start_billing_date:'',
      rent_price:5000000,total_deposit:10000000,payment_cycle:'MONTHLY',discounts:null,notes:null,
      initial_electricity_reading:null,initial_water_reading:null,actual_end_date:null,
      room:{id:'room',name:'101',building_id:'building',building:{id:'building',name:'Toà A',type:'APARTMENT'}},
      contract_customers:[{id:'link',contract_id:'draft',customer_id:'customer',is_representative:true,notes:null,
        customer:{id:'customer',full_name:'Nguyễn Văn A',phone:'0900000000',email:null,id_number:'0123456789'},created_at:'',updated_at:''}],
      contract_services:[],
    };
    const data = buildContractTemplateData({contract:source});
    expect(data.CONTRACT_NUMBER).toBe('');
    const rendered = await renderContractDocxBuffer(template.generate({type:'arraybuffer'}),data);
    const output = await markDraftDocx(rendered,2);
    expect(output.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const xml = new PizZip(await output.arrayBuffer()).file('word/document.xml')?.asText();
    expect(xml).toContain('BẢN NHÁP');
    expect(xml).toContain('Nguyễn Văn A');
    expect(xml).toContain('101');
    expect(xml).toContain('5.000.000');
    expect(xml).not.toContain('{REPRESENT_NAME}');
  });
});
