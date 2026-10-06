// Gộp nhiều bản word/document.xml dựng từ CÙNG một mẫu thành một tài liệu.
//
// Vì cùng mẫu nên styles, numbering, header và quan hệ rId giống hệt nhau — chỉ cần
// nối phần thân. Mỗi bản giữ nguyên các section của nó: thuộc tính section cuối
// (nằm thẳng dưới w:body) của mọi bản trừ bản chót được chuyển vào đoạn cuối của bản
// đó thành dấu ngắt section, đúng cách Word tự lưu, để bản sau bắt đầu trang mới
// với khổ giấy/lề/header của chính nó.

interface TopLevelElement { name: string; start: number; end: number }

const TAGS = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*?(\/?)>/g;

/** Các phần tử con trực tiếp của w:body (bỏ qua comment/CDATA). */
function topLevelElements(body: string): TopLevelElement[] {
  const elements: TopLevelElement[] = [];
  let depth = 0;
  let current: { name: string; start: number } | null = null;
  for (const match of body.matchAll(TAGS)) {
    const [tag, closing, name, selfClosing] = match;
    if (!name) continue;
    if (closing) {
      depth--;
      if (depth === 0 && current?.name === name) {
        elements.push({ name, start: current.start, end: match.index + tag.length });
        current = null;
      }
    } else if (selfClosing) {
      if (depth === 0) elements.push({ name, start: match.index, end: match.index + tag.length });
    } else {
      if (depth === 0) current = { name, start: match.index };
      depth++;
    }
  }
  if (depth !== 0) throw new Error('Tài liệu Word không cân thẻ, không gộp được.');
  return elements;
}

/** Đặt `sectPr` làm dấu ngắt section ở cuối đoạn văn; null nếu đoạn có cấu trúc không chắc chắn. */
function paragraphEndingSection(paragraph: string, sectPr: string): string | null {
  const open = paragraph.match(/^<w:p\b[^>]*>/)?.[0];
  if (!open || paragraph.endsWith('/>') || /<w:pPrChange\b|<w:sectPr\b/.test(paragraph)) return null;
  const rest = paragraph.slice(open.length);
  if (rest.startsWith('<w:pPr/>')) return `${open}<w:pPr>${sectPr}</w:pPr>${rest.slice('<w:pPr/>'.length)}`;
  if (/^<w:pPr[\s>]/.test(rest)) {
    // sectPr là con cuối của pPr (sau rPr của dấu đoạn), nên chèn ngay trước thẻ đóng.
    const close = rest.indexOf('</w:pPr>');
    return close < 0 ? null : `${open}${rest.slice(0, close)}${sectPr}${rest.slice(close)}`;
  }
  return `${open}<w:pPr>${sectPr}</w:pPr>${rest}`;
}

function endWithSectionBreak(body: string): string {
  const elements = topLevelElements(body);
  const last = elements.at(-1);
  if (!last || last.name !== 'w:sectPr') throw new Error('Tài liệu Word thiếu thuộc tính trang cuối, không gộp được.');
  const sectPr = body.slice(last.start, last.end);
  const previous = elements.at(-2);
  const merged = previous?.name === 'w:p' ? paragraphEndingSection(body.slice(previous.start, previous.end), sectPr) : null;
  if (previous && merged !== null) return body.slice(0, previous.start) + merged + body.slice(previous.end, last.start);
  return `${body.slice(0, last.start)}<w:p><w:pPr>${sectPr}</w:pPr></w:p>`;
}

/**
 * Bản sao thứ `copy` phải mang mã nhận dạng riêng: Word đòi w14:paraId/textId duy
 * nhất (trùng thì báo tệp hỏng) và hình VML cùng id sẽ đè nhau. Bỏ mã w14 (tuỳ chọn,
 * Word tự sinh lại) và đổi số hình VML theo thứ tự bản.
 */
function distinctCopy(body: string, copy: number): string {
  return body
    .replace(/\sw14:(?:paraId|textId|anchorId)="[^"]*"/g, '')
    .replace(/(\s(?:id|o:spid)=")_x0000_s(\d+)"/g, (_match, prefix: string, id: string) => `${prefix}_x0000_s${Number(id) + copy * 100_000}"`);
}

export function mergeWordDocuments(documents: readonly string[]): string {
  const first = documents[0];
  if (first === undefined) throw new Error('Không có tài liệu nào để gộp.');
  const bodies = documents.map((xml, index) => {
    const open = xml.match(/<w:body\b[^>]*>/);
    const close = xml.lastIndexOf('</w:body>');
    if (!open || open.index === undefined || close < open.index) throw new Error('Tài liệu Word không có phần thân hợp lệ.');
    let body = xml.slice(open.index + open[0].length, close);
    if (index > 0) body = distinctCopy(body, index);
    return index < documents.length - 1 ? endWithSectionBreak(body) : body;
  });
  const open = first.match(/<w:body\b[^>]*>/);
  if (!open || open.index === undefined) throw new Error('Tài liệu Word không có phần thân hợp lệ.');
  return first.slice(0, open.index + open[0].length) + bodies.join('') + first.slice(first.lastIndexOf('</w:body>'));
}
