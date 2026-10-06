// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import PizZip from 'pizzip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CT01InputError } from '../ct01Document';
import { buildCT01RoomBundle, orderRoomMembers, type CT01RoomMember } from '../ct01RoomBundle';

const db = vi.hoisted(() => ({
  building: null as Record<string, unknown> | null,
  customers: [] as Array<Record<string, unknown>>,
  owner: null as Record<string, unknown> | null,
  filters: [] as string[],
}));

vi.mock('@/integrations/supabase/client', () => {
  interface Chain extends PromiseLike<{ data: unknown; error: null }> {
    select: () => Chain; eq: (c: string, v: unknown) => Chain; in: (c: string, v: unknown[]) => Chain;
    is: (c: string, v: unknown) => Chain; maybeSingle: () => Promise<{ data: unknown; error: null }>;
  }
  return { supabase: { from: (table: string) => {
    const result = { data: table === 'buildings' ? db.building : db.customers, error: null as null };
    const chain: Chain = {
      select: () => chain,
      eq: (column, value) => { db.filters.push(`${table}.${column}=${String(value)}`); return chain; },
      in: (column, values) => { db.filters.push(`${table}.${column} in ${values.join(',')}`); return chain; },
      is: (column, value) => { db.filters.push(`${table}.${column} is ${String(value)}`); return chain; },
      maybeSingle: () => Promise.resolve(result),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  } } };
});
vi.mock('../buildingLegalOwner', () => ({ loadBuildingLegalOwner: vi.fn(async () => db.owner) }));

// Môi trường jsdom đổi import.meta.url sang http nên đọc mẫu theo thư mục gốc dự án.
const template = readFileSync(resolve(process.cwd(), 'public/templates/ct01.docx'));
const person = (id: string, full_name: string, id_number: string | null) => ({
  id, full_name, id_number, date_of_birth: '2001-12-05', gender: 'MALE', phone: '0901234567', email: null,
  id_issue_date: '2022-02-25', id_issue_place: 'Cục Cảnh sát', detailed_address: `Thường trú của ${full_name}`,
});
const members: CT01RoomMember[] = [
  { customerId: 'c-a', isRepresentative: false, fallbackName: 'An' },
  { customerId: 'c-b', isRepresentative: true, fallbackName: 'Bình' },
  { customerId: 'c-x', isRepresentative: false, fallbackName: 'Khách đã xoá' },
  { customerId: 'c-bad', isRepresentative: false, fallbackName: 'Sai CCCD' },
];
const request = { buildingId: 'b-1', roomNumber: '201', members, durationMonths: 24 as const, requestedAt: new Date('2026-10-06T03:00:00Z') };
const plain = (xml: string) => xml.replace(/<[^>]+>/g, '');
// Blob của jsdom chưa có arrayBuffer(); FileReader thì có.
const bytes = (blob: Blob) => new Promise<ArrayBuffer>((resolveBytes, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolveBytes(reader.result as ArrayBuffer);
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
});

beforeEach(() => {
  db.building = { id: 'b-1', name: '44TL', street_address: '44 Trần Lựu, Phường An Phú, TP Hồ Chí Minh', ward: 'Phường An Phú', district: '', province: 'Hồ Chí Minh', organization_id: 'o-1' };
  db.customers = [person('c-a', 'Nguyễn Văn An', '012345678901'), person('c-b', 'Trần Thị Bình', '098765432109'), person('c-bad', 'Lê Sai Số', '1234567890123')];
  db.owner = { full_name: 'Chủ Quyền', birth_year: 1970, id_number: '001234567890', id_issue_date: '2020-02-03', id_issue_place: 'Cục Cảnh sát', permanent_address: '45 Đường Chủ' };
  db.filters = [];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(template)));
});
afterEach(() => vi.unstubAllGlobals());

describe('buildCT01RoomBundle', () => {
  it('gộp CT01 + HĐ ở nhờ của mọi khách đọc được vào một tệp, người đại diện trước, báo rõ người bị bỏ', async () => {
    const bundle = await buildCT01RoomBundle(request);
    expect(bundle.included).toEqual(['Trần Thị Bình', 'Nguyễn Văn An']);
    expect(bundle.skipped).toEqual([
      { name: 'Khách đã xoá', reason: expect.stringMatching(/Không đọc được hồ sơ khách/) },
      { name: 'Lê Sai Số', reason: expect.stringMatching(/Số định danh/) },
    ]);
    expect(db.filters).toEqual(expect.arrayContaining(['buildings.id=b-1', 'buildings.deleted_at is null', 'customers.id in c-b,c-a,c-x,c-bad', 'customers.deleted_at is null']));
    expect(fetch).toHaveBeenCalledTimes(1); // Mẫu tải một lần cho cả phòng.

    const zip = new PizZip(await bytes(bundle.blob!));
    const xml = zip.file('word/document.xml')!.asText();
    expect(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('parsererror')).toHaveLength(0);
    const text = plain(xml);
    expect(text.split('TỜ KHAI THAY ĐỔI THÔNG TIN CƯ TRÚ')).toHaveLength(3);
    expect(text.split('HỢP ĐỒNG CHO THUÊ, MƯỢN, Ở NHỜ')).toHaveLength(3);
    expect(text.indexOf('Trần Thị Bình')).toBeLessThan(text.indexOf('Nguyễn Văn An'));
    expect(text).toContain('Thường trú của Nguyễn Văn An');
    expect(text).not.toContain('Lê Sai Số');
    expect(xml).not.toMatch(/\{\w+\}/);
    // Mỗi khách hai section (CT01, hợp đồng); chỉ section cuối cùng đứng thẳng dưới w:body.
    expect(xml.match(/<w:sectPr[ >]/g)).toHaveLength(4);
    expect(xml.match(/<\/w:sectPr><\/w:pPr>/g)).toHaveLength(3);
    expect(xml).toMatch(/<\/w:sectPr><\/w:body>/);
    const paraIds = [...xml.matchAll(/w14:paraId="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(paraIds).size).toBe(paraIds.length);
    const shapes = [...xml.matchAll(/<v:shape id="([^"]+)"/g)].map(match => match[1]);
    expect(shapes).toHaveLength(2);
    expect(new Set(shapes).size).toBe(2);
  });

  it('mẫu không có tham chiếu chú thích/bookmark/comment — điều kiện để gộp chỉ bằng phần thân', () => {
    const xml = new PizZip(template).file('word/document.xml')!.asText();
    expect(xml).not.toMatch(/<w:(?:footnoteReference|endnoteReference|commentReference|commentRangeStart|bookmarkStart)\b|<wp:docPr\b/);
  });

  it('lỗi chung của tòa báo một lần, không tải mẫu', async () => {
    db.building = { ...db.building, ward: ' ' };
    await expect(buildCT01RoomBundle(request)).rejects.toThrow(/phường\/xã/);
    db.building = null;
    await expect(buildCT01RoomBundle(request)).rejects.toBeInstanceOf(CT01InputError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('thiếu chủ quyền hoặc số phòng thì dừng cả gói', async () => {
    db.owner = null;
    await expect(buildCT01RoomBundle(request)).rejects.toThrow(/chủ quyền/);
    db.owner = { full_name: 'Chủ Quyền', birth_year: null, id_number: '001', id_issue_date: null, id_issue_place: 'Cục Cảnh sát', permanent_address: '' };
    await expect(buildCT01RoomBundle({ ...request, roomNumber: null })).rejects.toThrow(/số phòng/);
    await expect(buildCT01RoomBundle({ ...request, buildingId: null })).rejects.toThrow(/phòng\/tòa/);
  });

  it('không khách nào hợp lệ thì không tạo tệp và không tải mẫu', async () => {
    db.customers = [person('c-bad', 'Lê Sai Số', 'ABC')];
    const bundle = await buildCT01RoomBundle(request);
    expect(bundle.blob).toBeNull();
    expect(bundle.skipped.map(entry => entry.name)).toEqual(['Bình', 'An', 'Khách đã xoá', 'Lê Sai Số']);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('orderRoomMembers', () => {
  it('đưa người đại diện lên đầu, giữ thứ tự còn lại và bỏ trùng', () => {
    expect(orderRoomMembers([
      { customerId: 'a', isRepresentative: false }, { customerId: 'b', isRepresentative: false },
      { customerId: 'c', isRepresentative: true }, { customerId: 'a', isRepresentative: false }, { customerId: '', isRepresentative: false },
    ]).map(member => member.customerId)).toEqual(['c', 'a', 'b']);
  });
});
