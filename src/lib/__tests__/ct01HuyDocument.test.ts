import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import PizZip from 'pizzip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCT01HuyData, CT01InputError, downloadCT01HuyDocument, renderCT01HuyDocument,
  type CT01Building, type CT01Customer, type CT01HuyDetails,
} from '../ct01Document';

// Đọc mẫu theo thư mục gốc dự án (jsdom đổi import.meta.url; ở đây chạy môi trường node).
const huyTemplate = readFileSync(resolve(process.cwd(), 'public/templates/ct01-huy.docx'));
const ct01Template = readFileSync(resolve(process.cwd(), 'public/templates/ct01.docx'));

const customer: CT01Customer = {
  full_name: 'Lê Quốc Duy', date_of_birth: '2006-05-23', gender: 'MALE', id_number: '072206008594',
  phone: '0901234567', email: null, id_issue_date: '2024-11-07', id_issue_place: 'cục cảnh sát',
  detailed_address: '3, số 100a - Đường Trần Phú, Tổ 17, khu phố Long Tân, Phường long Hoa, Tỉnh Tây Ninh',
};
const address = '32/28/4 Phạm Văn Chiêu, Khu Phố 21, Phường Thông Tây Hội, TP. Hồ Chí Minh';
const building: CT01Building = {
  id: 'b-32pvc', name: '32PVC', street_address: `  ${address} `, ward: 'Phường 8', district: '', province: 'Hồ Chí Minh',
};
const details: CT01HuyDetails = {
  roomNumber: '401', endDate: '2026-10-05', owner: {
    full_name: 'Nguyễn Thị Thu Thảo', birth_year: 1974, id_number: '079174029198', id_issue_date: '2021-12-20',
    id_issue_place: 'Cục Cảnh sát', permanent_address: '61/54 Đường Số 59, Phường An Hội Tây, TP. Hồ Chí Minh',
  },
};
// 03:00Z = 10:00 giờ Việt Nam ngày 07/10/2026.
const now = new Date('2026-10-07T03:00:00Z');
const BLANK = '……………';
const plain = (xml: string) => xml.replace(/<[^>]+>/g, '');
const paragraphs = (xml: string) => xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g)!.map(paragraph => plain(paragraph).trim());
/** Phần CT01 = đến hết đoạn mang sectPr đầu tiên (ngắt section sang trang biên bản). */
const ct01Part = (xml: string) => xml.slice(0, xml.indexOf('</w:p>', xml.indexOf('<w:sectPr')) + '</w:p>'.length);
const documentXml = (bytes: ArrayBuffer | Buffer) => new PizZip(bytes).file('word/document.xml')!.asText();

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('buildCT01HuyData', () => {
  it('đề nghị hủy tạm trú tại địa chỉ toà, ngày thanh lý từ ngày chấm dứt, tỉnh thành đầy đủ', () => {
    expect(buildCT01HuyData(customer, building, details, now)).toMatchObject({
      registration_request: `Hủy tạm trú tại ${address}`,
      tl_end_date: 'ngày 05 tháng 10 năm 2026', tl_city: 'Thành phố Hồ Chí Minh',
      signature_day: '07', signature_month: '10', signature_year: '2026',
      full_name: 'Lê Quốc Duy', building_address: address, registration_authority: 'Công an Phường Thông Tây Hội, TP. Hồ Chí Minh',
      owner_name: 'Nguyễn Thị Thu Thảo', owner_id_number: '079174029198', tl_owner_birth_year: '1974',
      tl_owner_id_issue_date: '20/12/2021', tl_owner_id_issue_place: 'Cục Cảnh sát',
      tl_owner_permanent_address: '61/54 Đường Số 59, Phường An Hội Tây, TP. Hồ Chí Minh',
      tl_customer_birth: '23/05/2006', customer_id_number: '072206008594', tl_customer_id_issue_date: '07/11/2024',
      tl_customer_id_issue_place: 'cục cảnh sát', tl_customer_permanent_address: customer.detailed_address,
      id_1: '0', id_12: '4',
    });
    expect(buildCT01HuyData(customer, { ...building, province: 'Đồng Nai' }, details, now).tl_city).toBe('Tỉnh Đồng Nai');
    expect(buildCT01HuyData(customer, { ...building, province: 'TP. Hồ Chí Minh' }, details, now).tl_city).toBe('Thành phố Hồ Chí Minh');
  });

  it('không có ngày chấm dứt thì lấy ngày tải theo giờ Việt Nam, không để trống', () => {
    const data = buildCT01HuyData(customer, building, { ...details, endDate: null }, new Date('2026-10-06T18:30:00Z'));
    expect(data.tl_end_date).toBe('ngày 07 tháng 10 năm 2026');
    expect(data.signature_day).toBe('07');
  });

  it('thiếu dữ liệu thì để chỗ chấm viết tay thay vì để trống', () => {
    const data = buildCT01HuyData(
      { ...customer, date_of_birth: null, id_number: null, id_issue_date: null, id_issue_place: '  ', detailed_address: null },
      { ...building, province: ' ' },
      { ...details, owner: { ...details.owner, birth_year: null, id_issue_date: null, id_issue_place: '', permanent_address: ' ' } },
      now,
    );
    expect(data).toMatchObject({
      tl_city: BLANK, tl_owner_birth_year: BLANK, tl_owner_id_issue_date: BLANK, tl_owner_id_issue_place: BLANK,
      tl_owner_permanent_address: BLANK, tl_customer_birth: BLANK, customer_id_number: BLANK,
      tl_customer_id_issue_date: BLANK, tl_customer_id_issue_place: BLANK, tl_customer_permanent_address: BLANK,
    });
    // Ô số định danh của CT01 vẫn để trống như tờ khai đăng ký.
    expect(data.id_1).toBe('');
  });

  it('chặn thiếu địa chỉ toà, số phòng, chủ quyền hoặc ngày chấm dứt sai', () => {
    const cases: Array<[CT01Building, CT01HuyDetails, RegExp]> = [
      [{ ...building, street_address: null }, details, /địa chỉ chi tiết/],
      [{ ...building, street_address: '  ' }, details, /địa chỉ chi tiết/],
      [building, { ...details, roomNumber: ' ' }, /số phòng/],
      [building, { ...details, owner: { ...details.owner, full_name: '' } }, /chủ quyền/],
      [building, { ...details, owner: { ...details.owner, id_number: ' ' } }, /chủ quyền/],
      [building, { ...details, endDate: '2026-02-30' }, /Ngày chấm dứt/],
      [building, { ...details, endDate: '05/10/2026' }, /Ngày chấm dứt/],
      [building, { ...details, endDate: '2026-10-05T17:00:00Z' }, /Ngày chấm dứt/],
    ];
    for (const [target, input, message] of cases) {
      expect(() => buildCT01HuyData(customer, target, input, now)).toThrow(CT01InputError);
      expect(() => buildCT01HuyData(customer, target, input, now)).toThrow(message);
    }
  });
});

describe('mẫu ct01-huy.docx', () => {
  it('giữ nguyên phần CT01 của ct01.docx, bỏ hợp đồng ở nhờ, mỗi placeholder biên bản nằm trọn một w:t', () => {
    const huy = documentXml(huyTemplate);
    expect(ct01Part(huy)).toBe(ct01Part(documentXml(ct01Template)));
    const minutes = huy.slice(ct01Part(huy).length);
    expect(plain(huy)).not.toContain('HỢP ĐỒNG CHO THUÊ, MƯỢN, Ở NHỜ');
    const tagsInText = [...plain(minutes).matchAll(/\{(\w+)\}/g)].map(match => match[1]);
    const tagsInRuns = [...minutes.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)]
      .flatMap(match => [...match[1].matchAll(/\{(\w+)\}/g)].map(tag => tag[1]));
    expect(tagsInRuns).toEqual(tagsInText);
    expect(new Set(tagsInText)).toEqual(new Set([
      'tl_city', 'signature_day', 'signature_month', 'signature_year', 'owner_name', 'tl_owner_birth_year', 'owner_id_number',
      'tl_owner_id_issue_date', 'tl_owner_id_issue_place', 'tl_owner_permanent_address', 'full_name', 'tl_customer_birth',
      'customer_id_number', 'tl_customer_id_issue_date', 'tl_customer_id_issue_place', 'tl_customer_permanent_address',
      'building_address', 'tl_end_date',
    ]));
    // Biên bản là section A4 riêng, lề trên/phải/dưới 1134, trái 1417, đánh số trang lại từ 1.
    expect(huy.match(/<w:sectPr[ >]/g)).toHaveLength(2);
    expect(huy).toMatch(/<w:pgSz w:w="11906" w:h="16838"[^>]*\/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1417"[^>]*\/><w:pgNumType w:start="1"\/>[\s\S]*<\/w:sectPr><\/w:body>/);
  });

  it('điền đủ tờ khai hủy và biên bản thanh lý, không sót placeholder', async () => {
    const fetchMock = vi.fn(async () => new Response(huyTemplate));
    vi.stubGlobal('fetch', fetchMock);
    const blob = await renderCT01HuyDocument(customer, building, details, now);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/templates\/ct01-huy\.docx$/);
    const xml = documentXml(await blob.arrayBuffer());
    expect(xml).not.toMatch(/\{\w+\}/);
    const text = plain(xml);
    expect(text).not.toContain('HỢP ĐỒNG CHO THUÊ, MƯỢN, Ở NHỜ');
    expect(text).not.toContain('Đăng ký tạm trú');
    const lines = paragraphs(xml);
    expect(lines.find(line => line.includes('Nội dung đề nghị'))).toContain(`Hủy tạm trú tại ${address}`);
    expect(lines).toEqual(expect.arrayContaining([
      'BIÊN BẢN THANH LÝ HỢP ĐỒNG THUÊ NHÀ',
      'Thành phố Hồ Chí Minh, ngày 07 tháng 10 năm 2026, chúng tôi gồm có:',
      'Ông (Bà): Nguyễn Thị Thu ThảoSinh năm: 1974',
      '-  CCCD: 079174029198Ngày cấp: 20/12/2021Nơi cấp: Cục Cảnh sát',
      '-  Hiện thường trú: 61/54 Đường Số 59, Phường An Hội Tây, TP. Hồ Chí Minh',
      'Ông (Bà): Lê Quốc DuySinh năm: 23/05/2006',
      '-  CCCD: 072206008594Ngày cấp: 07/11/2024Nơi cấp: cục cảnh sát',
      `-  Hiện thường trú: ${customer.detailed_address}`,
      `Hai bên cùng thống nhất thanh lý Hợp đồng thuê tại địa chỉ ${address}, với các nội dung sau:`,
      'Điều 1. Hai bên cùng đồng ý chấm dứt hợp đồng thuê nhà kể từ ngày 05 tháng 10 năm 2026.',
      `Điều 3. Bên B đã rời khỏi nhà và chấm dứt tạm trú, cư trú tại địa chỉ ${address} kể từ ngày 05 tháng 10 năm 2026. `
        + 'Biên bản này là căn cứ để làm thủ tục xóa đăng ký tạm trú của Bên B tại địa chỉ trên.',
    ]));
    const signatures = xml.match(/<w:tbl[ >][\s\S]*?<\/w:tbl>/g)!.at(-1)!;
    expect(paragraphs(signatures)).toEqual([
      'BÊN CHO THUÊ', '(ký và ghi rõ họ tên)', 'Nguyễn Thị Thu Thảo', 'BÊN THUÊ', '(ký và ghi rõ họ tên)', 'Lê Quốc Duy',
    ]);
  });

  it('không xuất file nếu mẫu trả HTTP lỗi', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await expect(renderCT01HuyDocument(customer, building, details, now)).rejects.toThrow(/mẫu CT01 hủy tạm trú/);
  });

  it('tải về với tên tệp CT01 huy tam tru - <tên khách>', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(huyTemplate)));
    const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal('window', {
      document: { createElement: () => link, body: { appendChild: vi.fn() } }, setTimeout: vi.fn(),
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:huy');
    await downloadCT01HuyDocument(customer, building, details, now);
    expect(link.download).toBe('CT01 huy tam tru - Lê Quốc Duy.docx');
    expect(link.click).toHaveBeenCalledTimes(1);
  });
});
