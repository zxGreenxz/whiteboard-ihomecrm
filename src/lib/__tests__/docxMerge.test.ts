import { describe, expect, it } from 'vitest';
import { mergeWordDocuments } from '../docxMerge';

const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="w" xmlns:w14="w14" xmlns:v="v" xmlns:o="o"><w:body>';
const tail = '</w:body></w:document>';
const sect = (size: string) => `<w:sectPr><w:pgSz w:w="${size}"/></w:sectPr>`;
const doc = (body: string) => `${head}${body}${tail}`;
const bodyOf = (xml: string) => xml.slice(xml.indexOf('<w:body>') + '<w:body>'.length, xml.lastIndexOf('</w:body>'));

describe('mergeWordDocuments', () => {
  it('giữ nguyên tài liệu duy nhất', () => {
    const xml = doc(`<w:p w14:paraId="1"><w:r><w:t>A</w:t></w:r></w:p>${sect('1')}`);
    expect(mergeWordDocuments([xml])).toBe(xml);
  });

  it('đưa thuộc tính trang cuối của bản trước vào pPr của đoạn cuối, sau rPr dấu đoạn', () => {
    const first = doc(`<w:p><w:r><w:t>A</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="X"/><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t>A-end</w:t></w:r></w:p>${sect('1')}`);
    const second = doc(`<w:p><w:r><w:t>B</w:t></w:r></w:p>${sect('2')}`);
    const body = bodyOf(mergeWordDocuments([first, second]));
    expect(body).toBe('<w:p><w:r><w:t>A</w:t></w:r></w:p>'
      + `<w:p><w:pPr><w:pStyle w:val="X"/><w:rPr><w:b/></w:rPr>${sect('1')}</w:pPr><w:r><w:t>A-end</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t>B</w:t></w:r></w:p>${sect('2')}`);
  });

  it('tạo pPr khi đoạn cuối chưa có, và thêm đoạn riêng khi phần tử cuối là bảng', () => {
    const noPPr = doc(`<w:p w14:paraId="1"><w:r><w:t>A</w:t></w:r></w:p>${sect('1')}`);
    const table = doc(`<w:tbl><w:tr><w:tc><w:p><w:r><w:t>T</w:t></w:r></w:p></w:tc></w:tr></w:tbl>${sect('2')}`);
    const last = doc(`<w:p/>${sect('3')}`);
    const body = bodyOf(mergeWordDocuments([noPPr, table, last]));
    expect(body).toBe(`<w:p w14:paraId="1"><w:pPr>${sect('1')}</w:pPr><w:r><w:t>A</w:t></w:r></w:p>`
      + `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>T</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:pPr>${sect('2')}</w:pPr></w:p>`
      + `<w:p/>${sect('3')}`);
  });

  it('nhận đúng sectPr cấp thân dù bên trong có lịch sử sectPrChange', () => {
    const tracked = `<w:sectPr><w:pgSz w:w="1"/><w:sectPrChange w:id="9"><w:sectPr><w:pgSz w:w="0"/></w:sectPr></w:sectPrChange></w:sectPr>`;
    const first = doc(`<w:p><w:r><w:t>A</w:t></w:r></w:p>${tracked}`);
    const body = bodyOf(mergeWordDocuments([first, doc(`<w:p/>${sect('2')}`)]));
    expect(body.startsWith(`<w:p><w:pPr>${tracked}</w:pPr><w:r>`)).toBe(true);
    expect(body.endsWith(`<w:p/>${sect('2')}`)).toBe(true);
  });

  it('bỏ mã w14 và đổi id hình VML ở các bản sau, bản đầu giữ nguyên', () => {
    const shape = (para: string) => doc(`<w:p w14:paraId="${para}" w14:textId="77777777"><w:r><w:pict w14:anchorId="AB"><v:shape id="_x0000_s2095" o:spid="_x0000_s2095"/></w:pict></w:r></w:p>${sect('1')}`);
    const merged = mergeWordDocuments([shape('11'), shape('11'), shape('11')]);
    expect(merged.match(/w14:paraId="11"/g)).toHaveLength(1);
    expect(merged.match(/w14:anchorId=/g)).toHaveLength(1);
    expect(merged.match(/\sid="_x0000_s\d+"/g)).toEqual([' id="_x0000_s2095"', ' id="_x0000_s102095"', ' id="_x0000_s202095"']);
    expect(merged.match(/o:spid="_x0000_s\d+"/g)).toEqual(['o:spid="_x0000_s2095"', 'o:spid="_x0000_s102095"', 'o:spid="_x0000_s202095"']);
  });

  it('từ chối gộp khi thiếu thân hoặc thiếu thuộc tính trang cuối', () => {
    expect(() => mergeWordDocuments([])).toThrow(/Không có tài liệu/);
    expect(() => mergeWordDocuments(['<w:document/>', doc(sect('1'))])).toThrow(/phần thân/);
    expect(() => mergeWordDocuments([doc('<w:p/>'), doc(sect('1'))])).toThrow(/thuộc tính trang/);
  });
});
