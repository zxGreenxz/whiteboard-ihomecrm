import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildCT01Data, renderCT01Document, type CT01Customer, type CT01Building } from '../ct01Document';

const customer: CT01Customer = {
  full_name: 'Nguyễn Văn Kiểm Thử', date_of_birth: '2001-12-05', gender: 'Nam',
  id_number: '012345678901', phone: '0901234567', email: 'test@example.com',
};
const building: CT01Building = {
  id: 'building-1', name: 'Tòa kiểm thử', ward: 'Phường Bình Thạnh',
  street_address: '123 Đường Kiểm Thử', district: '', province: 'Thành phố Hồ Chí Minh',
};
afterEach(() => vi.unstubAllGlobals());

describe('CT01 theo mẫu người dùng', () => {
  it('điền hồ sơ khách, chủ hộ và địa chỉ tòa; ngày ký tính theo Việt Nam', () => {
    const data = buildCT01Data(customer, building, new Date('2026-09-13T18:01:00Z'));
    expect(data).toMatchObject({
      registration_authority: 'Công an Phường Bình Thạnh', full_name: customer.full_name,
      household_head_name: customer.full_name, date_of_birth: '05/12/2001',
      gender: 'Nam', phone: customer.phone, email: customer.email,
      building_address: '123 Đường Kiểm Thử, Phường Bình Thạnh, Thành phố Hồ Chí Minh',
      signature_date: 'ngày 14 tháng 09 năm 2026', id_1: '0', id_12: '1', head_id_1: '0', head_id_12: '1',
    });
  });
  it('không lặp Phường và giữ đúng cơ quan cấp xã', () => {
    expect(buildCT01Data(customer, { ...building, ward: 'Xã Bình Mỹ' }).registration_authority).toBe('Công an Xã Bình Mỹ');
    expect(buildCT01Data(customer, { ...building, ward: 'Bình Thạnh' }).registration_authority).toBe('Công an phường Bình Thạnh');
  });
  it('hiển thị giới tính tiếng Việt từ cả enum của form mới và dữ liệu cũ', () => {
    for (const [stored, label] of [['MALE', 'Nam'], ['FEMALE', 'Nữ'], ['OTHER', 'Khác'], ['Nữ', 'Nữ']]) {
      expect(buildCT01Data({ ...customer, gender: stored }, building).gender).toBe(label);
    }
  });
  it('giữ trống dữ liệu khách chưa có, không điền undefined hoặc ngày lỗi', () => {
    const data = buildCT01Data({ ...customer, date_of_birth: null, id_number: null, email: null }, building);
    expect(data.date_of_birth).toBe('');
    expect(data.id_1).toBe('');
    expect(data.head_id_12).toBe('');
    expect(data.email).toBe('');
    expect(buildCT01Data({ ...customer, date_of_birth: 'invalid' }, building).date_of_birth).toBe('');
  });
  it('báo thiếu địa chỉ/phường thay vì xuất sai tòa và không cắt số định danh quá dài', () => {
    expect(() => buildCT01Data(customer, { ...building, ward: '' })).toThrow(/phường/i);
    expect(() => buildCT01Data(customer, { ...building, street_address: null })).toThrow(/địa chỉ/i);
    expect(() => buildCT01Data({ ...customer, id_number: '0123456789012' }, building)).toThrow(/định danh/i);
  });
  it('xuất DOCX thực từ mẫu: đúng các ô số, bốn ngày ký, không còn placeholder', async () => {
    const source = readFileSync(new URL('../../../public/templates/ct01.docx', import.meta.url));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(source)));
    const blob = await renderCT01Document(customer, building, new Date('2026-09-13T18:01:00Z'));
    const zip = new PizZip(await blob.arrayBuffer());
    const xml = zip.file('word/document.xml')!.asText();
    expect(xml).toContain(customer.full_name);
    expect(xml).toContain('Công an Phường Bình Thạnh');
    expect(xml).toContain('123 Đường Kiểm Thử');
    expect(xml.match(/ngày 14 tháng 09 năm 2026/g)).toHaveLength(4);
    expect(xml).not.toMatch(/\{\w+\}/);
    const tables = xml.match(/<w:tbl[ >][\s\S]*?<\/w:tbl>/g)!;
    for (const table of tables.slice(0, 2)) {
      const cells = table.match(/<w:tc[ >][\s\S]*?<\/w:tc>/g)!;
      expect(cells.slice(1).map(cell => [...cell.matchAll(/<w:t(?: [^>]*)?>(.*?)<\/w:t>/g)].map(m => m[1]).join('')).join('')).toBe(customer.id_number);
    }
  });
  it('không xuất file nếu mẫu trả HTTP lỗi', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    await expect(renderCT01Document(customer, building)).rejects.toThrow(/mẫu CT01/);
  });
});
