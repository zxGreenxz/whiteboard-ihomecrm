import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Customer } from '@/types/customer';
import { buildCT01Data, renderCT01Document, type CT01Customer, type CT01Building, type CT01LeaseDetails } from '../ct01Document';

const customer: CT01Customer & Pick<Customer, 'permanent_address'> = {
  full_name: 'Nguyễn Văn Kiểm Thử', date_of_birth: '2001-12-05', gender: 'Nam',
  id_number: '012345678901', phone: '0901234567', email: 'test@example.com',
  id_issue_date: '2022-02-25', id_issue_place: 'Cục Cảnh sát',
  detailed_address: 'Ấp Kiểm Thử, Xã Bình Mỹ', permanent_address: null,
};
const lease: CT01LeaseDetails = {
  durationMonths: 24, roomNumber: 'A101', owner: {
    full_name: 'Trần Thị Chủ Quyền', birth_year: 1970, id_number: '001234567890',
    id_issue_date: '2020-02-03', id_issue_place: 'Cục Cảnh sát', permanent_address: '45 Đường Chủ Quyền',
  },
};
const building: CT01Building = {
  id: 'building-1', name: 'Tòa kiểm thử', ward: 'Phường Bình Thạnh',
  street_address: '123 Đường Kiểm Thử', district: '', province: 'Thành phố Hồ Chí Minh',
};
afterEach(() => vi.unstubAllGlobals());

describe('CT01 theo mẫu người dùng', () => {
  it.each([12, 24] as const)('đồng bộ thời hạn %i tháng và điền đúng bên A/B, phòng, ngày tải', months => {
    const data = buildCT01Data(customer, building, { ...lease, durationMonths: months }, new Date('2026-09-13T18:01:00Z'));
    expect(data).toMatchObject({
      registration_request: `Đăng ký tạm trú ${months} tháng tại 123 Đường Kiểm Thử`,
      duration_months: String(months), room_number: 'A101', owner_name: lease.owner.full_name,
      owner_birth_year: '1970', owner_id_number: '001234567890', owner_id_issue_date: '03/02/2020',
      owner_id_issue_place: 'Cục Cảnh sát', owner_permanent_address: '45 Đường Chủ Quyền',
      customer_birth_year: '2001', customer_id_number: '012345678901', customer_id_issue_date: '25/02/2022',
      customer_id_issue_place: 'Cục Cảnh sát', customer_permanent_address: 'Ấp Kiểm Thử, Xã Bình Mỹ',
      download_date: '14/09/2026', signature_day: '14', signature_month: '09', signature_year: '2026',
      lease_end_date: months === 12 ? '14/09/2027' : '14/09/2028', building_locality: 'Phường Bình Thạnh',
    });
  });
  it.each([
    [12, '2026-12-31T16:59:59Z', '31/12/2026', '31/12/2027'],
    [24, '2026-12-31T17:00:00Z', '01/01/2027', '01/01/2029'],
    [12, '2024-02-28T17:00:00Z', '29/02/2024', '28/02/2025'],
    [24, '2024-02-29T16:59:59Z', '29/02/2024', '28/02/2026'],
    [12, '2024-02-29T17:00:00Z', '01/03/2024', '01/03/2025'],
    [12, '2023-02-28T16:59:59Z', '28/02/2023', '28/02/2024'],
  ] as const)('ngày hết hạn %i tháng từ %s dùng lịch Việt Nam và giữ đúng ngày tháng', (months, now, start, end) => {
    expect(buildCT01Data(customer, building, { ...lease, durationMonths: months }, new Date(now)))
      .toMatchObject({ download_date: start, lease_end_date: end });
  });
  it.each([
    ['123 Đường Kiểm Thử, Phường An Hội Tây, Thành phố Hồ Chí Minh', 'Phường 14', 'Phường An Hội Tây'],
    ['123 Đường Kiểm Thử,  xã Bình Mỹ  , Thành phố Hồ Chí Minh', 'Phường 14', 'xã Bình Mỹ'],
    ['123 Đường Kiểm Thử, Thị trấn Củ Chi, Thành phố Hồ Chí Minh', 'Phường 14', 'Thị trấn Củ Chi'],
    ['123 Đường Kiểm Thử, Đặc khu Phú Quốc, Tỉnh An Giang', 'Phường 14', 'Đặc khu Phú Quốc'],
    ['123 Đường Phường Mới, Thành phố Hồ Chí Minh', 'Phường 14', 'Phường 14'],
    ['123 Đường Kiểm Thử, Thành phố Thủ Đức, Hồ Chí Minh', 'Xã Bình Mỹ', 'Xã Bình Mỹ'],
    ['123 Đường Kiểm Thử, Khu phố 2, Hồ Chí Minh', 'Bình Thạnh', 'phường Bình Thạnh'],
    ['123 Đường Kiểm Thử, Phường, Hồ Chí Minh', 'Phường 14', 'Phường 14'],
  ])('địa phương ký từ component địa chỉ có tiền tố rõ: %s', (address, ward, locality) => {
    const data = buildCT01Data(customer, { ...building, street_address: address, ward }, lease);
    expect(data.building_locality).toBe(locality);
    expect(data.building_address).toBe(address);
  });
  it('chặn thời hạn ngoài lựa chọn, thiếu chủ quyền hoặc số phòng', () => {
    expect(() => buildCT01Data(customer, building, { ...lease, durationMonths: 6 as 12 })).toThrow(/thời hạn/i);
    expect(() => buildCT01Data(customer, building, { ...lease, roomNumber: '' })).toThrow(/phòng/i);
    expect(() => buildCT01Data(customer, building, { ...lease, owner: { ...lease.owner, full_name: '' } })).toThrow(/chủ quyền/i);
    expect(() => buildCT01Data(customer, building, { ...lease, owner: { ...lease.owner, id_number: '' } })).toThrow(/chủ quyền/i);
  });
  it('điền hồ sơ khách, chủ hộ và địa chỉ tòa; ngày ký tính theo Việt Nam', () => {
    const data = buildCT01Data(customer, building, lease, new Date('2026-09-13T18:01:00Z'));
    expect(data).toMatchObject({
      registration_authority: 'Công an Phường Bình Thạnh', full_name: customer.full_name,
      household_head_name: customer.full_name, date_of_birth: '05/12/2001',
      gender: 'Nam', phone: customer.phone, email: customer.email,
      building_address: '123 Đường Kiểm Thử',
      signature_date: 'ngày 14 tháng 09 năm 2026', id_1: '0', id_12: '1', head_id_1: '0', head_id_12: '1',
    });
  });
  it('không lặp Phường và giữ đúng cơ quan cấp xã', () => {
    expect(buildCT01Data(customer, { ...building, ward: 'Xã Bình Mỹ' }, lease).registration_authority).toBe('Công an Xã Bình Mỹ');
    expect(buildCT01Data(customer, { ...building, ward: 'Bình Thạnh' }, lease).registration_authority).toBe('Công an phường Bình Thạnh');
  });
  it('Kính gửi lấy từ phường đến hết tỉnh thành trong địa chỉ chi tiết', () => {
    const data = buildCT01Data(customer, {
      ...building,
      street_address: '111/46F Phạm Văn Chiêu, Phường An Hội Tây, TP Hồ Chí Minh',
      ward: 'Phường 14',
    }, lease);
    expect(data.registration_authority).toBe('Công an Phường An Hội Tây, TP Hồ Chí Minh');
  });
  it('hiển thị giới tính tiếng Việt từ cả enum của form mới và dữ liệu cũ', () => {
    for (const [stored, label] of [['MALE', 'Nam'], ['FEMALE', 'Nữ'], ['OTHER', 'Khác'], ['Nữ', 'Nữ']]) {
      expect(buildCT01Data({ ...customer, gender: stored }, building, lease).gender).toBe(label);
    }
  });
  it('giữ trống dữ liệu khách chưa có, không điền undefined hoặc ngày lỗi', () => {
    const data = buildCT01Data({ ...customer, date_of_birth: null, id_number: null, email: null }, building, lease);
    expect(data.date_of_birth).toBe('');
    expect(data.id_1).toBe('');
    expect(data.head_id_12).toBe('');
    expect(data.email).toBe('');
    expect(buildCT01Data({ ...customer, date_of_birth: 'invalid' }, building, lease).date_of_birth).toBe('');
  });
  it.each([null, ''])('không thay detailed_address = %s bằng trường địa chỉ khác', detailedAddress => {
    const customerWithAddress = { ...customer, detailed_address: detailedAddress, permanent_address: 'Địa chỉ thường trú cũ không dùng' };
    expect(buildCT01Data(customerWithAddress, building, lease).customer_permanent_address).toBe('');
  });
  it('báo thiếu địa chỉ/phường thay vì xuất sai tòa và không cắt số định danh quá dài', () => {
    expect(() => buildCT01Data(customer, { ...building, ward: '' }, lease)).toThrow(/phường/i);
    expect(() => buildCT01Data(customer, { ...building, street_address: null }, lease)).toThrow(/địa chỉ/i);
    expect(() => buildCT01Data({ ...customer, id_number: '0123456789012' }, building, lease)).toThrow(/định danh/i);
  });
  it('DOCX dùng địa chỉ chi tiết ở CT01 và đúng một vị trí hợp đồng dù ô hành chính còn cũ', async () => {
    const detailedAddress = '123 Đường Kiểm Thử, Phường Bình Thạnh, Thành phố Hồ Chí Minh';
    const source = readFileSync(new URL('../../../public/templates/ct01.docx', import.meta.url));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(source)));
    const blob = await renderCT01Document(customer, {
      ...building, street_address: `  ${detailedAddress}  `,
      ward: 'Phường 14', district: 'Quận Gò Vấp', province: 'Hồ Chí Minh',
    }, lease);
    const xml = new PizZip(await blob.arrayBuffer()).file('word/document.xml')!.asText();
    const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g)!.map(paragraph => paragraph.replace(/<[^>]+>/g, '').trim());
    const registration = paragraphs.find(paragraph => paragraph.includes('Đăng ký tạm trú'))!;
    expect(registration.slice(registration.indexOf('Đăng ký tạm trú'))).toBe(`Đăng ký tạm trú 24 tháng tại ${detailedAddress}`);
    const addressLabel = 'Đối tượng của hợp đồng này là: Một phần hoặc toàn bộ căn nhà số:';
    const leaseAddresses = paragraphs.filter(paragraph => paragraph.includes(addressLabel))
      .map(paragraph => paragraph.slice(paragraph.indexOf(addressLabel) + addressLabel.length).trim());
    expect(leaseAddresses).toEqual([detailedAddress]);
    const leaseText = xml.replace(/<[^>]+>/g, '').split('HỢP ĐỒNG CHO THUÊ, MƯỢN, Ở NHỜ')[1];
    expect(leaseText.split(detailedAddress)).toHaveLength(2);
    expect(leaseText).toContain('Tại Phường Bình Thạnh');
    expect(leaseText).not.toContain('Phường 14');
    expect(xml).toContain('Công an Phường Bình Thạnh, Thành phố Hồ Chí Minh');
    expect(xml).not.toContain('Công an Phường 14');
    expect(xml).not.toContain('Quận Gò Vấp');
  });
  it.each([null, 'Địa chỉ thường trú cũ không dùng'])('xuất DOCX thực dùng detailed_address cho bên B khi permanent_address = %s', async permanentAddress => {
    const source = readFileSync(new URL('../../../public/templates/ct01.docx', import.meta.url));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(source)));
    const customerWithAddress = { ...customer, permanent_address: permanentAddress };
    const blob = await renderCT01Document(customerWithAddress, building, lease, new Date('2026-09-13T18:01:00Z'));
    const zip = new PizZip(await blob.arrayBuffer());
    const xml = zip.file('word/document.xml')!.asText();
    expect(xml).toContain(customer.full_name);
    expect(xml).toContain('Công an Phường Bình Thạnh');
    expect(xml).toContain('123 Đường Kiểm Thử');
    expect(xml).toContain('HỢP ĐỒNG CHO THUÊ, MƯỢN, Ở NHỜ');
    const leaseText = xml.replace(/<[^>]+>/g, '').split('BÊN THUÊ, MƯỢN, Ở NHỜ')[1];
    expect(leaseText).toContain('Hiện thường trú: Ấp Kiểm Thử, Xã Bình Mỹ');
    expect(leaseText).toContain('Sinh năm: 05/12/2001');
    expect(leaseText).toContain('Thời hạn mượn: 24 tháng (từ 14/09/2026 đến 14/09/2028)');
    if (permanentAddress) expect(leaseText).not.toContain(permanentAddress);
    expect(xml).not.toMatch(/\{\w+\}/);
    expect(xml).toContain(lease.owner.full_name);
    expect(xml).toContain('Đăng ký tạm trú 24 tháng tại');
    expect(xml).not.toContain('A101');
    expect(xml.replace(/<[^>]+>/g, '')).toContain('Sinh Năm: 1970');
    expect(xml.match(/<w:sectPr[ >]/g)).toHaveLength(2);
    expect(xml).toContain('w:type w:val="nextPage"');
    // User changed lease typeface to Times New Roman, keeping body 11pt and title 14pt.
    const styles = zip.file('word/styles.xml')!.asText();
    expect(styles).toContain('w:styleId="LeaseNormal"');
    expect(styles).toMatch(/w:styleId="LeaseNormal"[\s\S]*?<w:sz w:val="22"/);
    expect(xml).not.toContain('Cambria');
    expect(xml).toMatch(/<w:rPr>[^]*?w:ascii="Times New Roman"[^]*?w:sz w:val="28"[^]*?HỢP ĐỒNG CHO THUÊ, MƯỢN, Ở NHỜ/);
    const signatures = xml.match(/<w:tbl[ >][\s\S]*?<\/w:tbl>/g)![3];
    const signatureCells = signatures.match(/<w:tc[ >][\s\S]*?<\/w:tc>/g)!;
    const originalCT01 = new PizZip(readFileSync(new URL('../../../scripts/fixtures/ct01/ct01-source.docx', import.meta.url)))
      .file('word/document.xml')!.asText();
    const originalSignatures = originalCT01.match(/<w:tbl[ >][\s\S]*?<\/w:tbl>/g)![3];
    const originalCells = originalSignatures.match(/<w:tc[ >][\s\S]*?<\/w:tc>/g)!;
    expect(signatureCells).toHaveLength(4);
    for (const [index, cell] of signatureCells.entries()) {
      const [date, ...labels] = cell.match(/<w:p[ >][\s\S]*?<\/w:p>/g)!;
      expect(date.replace(/<[^>]+>/g, '').trim()).toBe('ngày 14 tháng 09 năm 2026');
      expect(date).not.toMatch(/<w:(?:br|cr)[\s/>]/);
      const dateSizes = [...date.matchAll(/<w:sz(?:Cs)? w:val="(\d+)"/g)].map(match => match[1]);
      expect(dateSizes.length).toBeGreaterThan(0);
      expect(new Set(dateSizes)).toEqual(new Set(['20'])); // Only the four dates use 10pt.
      const originalLabels = originalCells[index].match(/<w:p[ >][\s\S]*?<\/w:p>/g)!.slice(1)
        .filter(paragraph => paragraph.replace(/<[^>]+>/g, '').trim());
      expect(labels).toEqual(originalLabels); // Preserve every signature label's text and formatting.
    }
    const signatureText = signatures.replace(/<[^>]+>/g, '');
    expect(signatureText.match(/ngày 14 tháng 09 năm 2026/g)).toHaveLength(4);
    const tables = xml.match(/<w:tbl[ >][\s\S]*?<\/w:tbl>/g)!;
    for (const table of tables.slice(0, 2)) {
      const cells = table.match(/<w:tc[ >][\s\S]*?<\/w:tc>/g)!;
      expect(cells.slice(1).map(cell => [...cell.matchAll(/<w:t(?: [^>]*)?>(.*?)<\/w:t>/g)].map(m => m[1]).join('')).join('')).toBe(customer.id_number);
    }
  });
  it('không xuất file nếu mẫu trả HTTP lỗi', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    await expect(renderCT01Document(customer, building, lease)).rejects.toThrow(/mẫu CT01/);
  });
});
