import { expect, it, vi } from 'vitest';
import PizZip from 'pizzip';
import { buildContractTemplateData, renderContractDocxBuffer, type ContractTemplateSource } from '../contractTemplateEngine';
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
const schedule = { version: 2 as const, start_billing_month: '2026-09', segments: [{ month_count: 3, monthly_amount: '300000' }, { month_count: 9, monthly_amount: '100000' }] };
const contract = { rent_price: 4000000, total_deposit: 0, discounts: null, start_date: '2026-09-20', end_date: '2027-09-20' } as ContractTemplateSource;
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
function template(xml: string, section = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:bottom="1134" w:left="1134" w:right="1134"/></w:sectPr>') {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${xml}${section}</w:body></w:document>`);
  return zip.generate({ type: 'arraybuffer' });
}
async function rendered(xml: string, section?: string) {
  const data = buildContractTemplateData({ contract, rentSupport: schedule });
  const blob = await renderContractDocxBuffer(template(xml, section), data);
  return new PizZip(await blob.arrayBuffer()).file('word/document.xml')!.asText();
}
it('projects every customer month + 1.8m total and never averages mixed rates or exposes funding', () => {
  const data = buildContractTemplateData({ contract, rentSupport: schedule });
  expect(data.RENT_SUPPORT_SCHEDULE).toContain('09/2026: 300.000');
  expect(data.RENT_SUPPORT_SCHEDULE).toContain('08/2027: 100.000');
  expect(data.RENT_SUPPORT_TOTAL).toContain('1.800.000');
  expect(data.PROMOTION_MONTH).toBe(12); expect(data.PROMOTION_PRICE_PER_MONTH).toBe('xem lịch hỗ trợ tiền thuê');
  expect(Object.keys(data).join(' ')).not.toMatch(/PAYER|COMMISSION|BONUS|SALE_PARTY|DEDUCTION/);
});
it('appends the full customer schedule before sectPr for an existing legacy template', async () => {
  const xml = await rendered(paragraph('Hợp đồng. Giảm {PROMOTION_MONTH} tháng, mức {PROMOTION_PRICE_PER_MONTH}.'));
  expect(xml).toContain('Lịch hỗ trợ tiền thuê');
  expect(xml).toContain('09/2026: 300.000'); expect(xml).toContain('08/2027: 100.000');
  expect(xml.indexOf('Tổng hỗ trợ')).toBeLessThan(xml.indexOf('<w:sectPr'));
  expect(xml).not.toMatch(/150\.000|hoa hồng|thưởng|BUILDING|COMMISSION/);
});
it('keeps a self-closing final sectPr after the appended customer schedule', async () => {
  const xml = await rendered(paragraph('Hợp đồng legacy'), '<w:sectPr/>');
  expect(xml.indexOf('Tổng hỗ trợ')).toBeLessThan(xml.indexOf('<w:sectPr/>'));
});
it.each([paragraph('{RENT_SUPPORT_SCHEDULE}'), '<w:p><w:r><w:t>{RENT_SUPPORT_</w:t></w:r><w:r><w:t>SCHEDULE}</w:t></w:r></w:p>'])('renders schedule code including split Word runs without duplicate appendix', async (code) => {
  const xml = await rendered(code + paragraph('Tổng: {RENT_SUPPORT_TOTAL}'));
  expect(xml.match(/09\/2026: 300\.000/g)).toHaveLength(1);
  expect(xml).not.toContain('Lịch hỗ trợ tiền thuê');
  expect(xml).toContain('1.800.000');
});
it('retains legacy scalars and uniform v2 single-rate compatibility', () => {
  const legacy = buildContractTemplateData({ contract: { ...contract, discounts: { months: 3, amount_per_month: 300000 } } });
  expect(legacy.PROMOTION_MONTH).toBe(3); expect(legacy.PROMOTION_PRICE_PER_MONTH).toContain('300.000');
  const uniform = buildContractTemplateData({ contract, rentSupport: { ...schedule, segments: [{ month_count: 12, monthly_amount: '100000' }] } });
  expect(uniform.PROMOTION_MONTH).toBe(12); expect(uniform.PROMOTION_PRICE_PER_MONTH).toContain('100.000');
});
