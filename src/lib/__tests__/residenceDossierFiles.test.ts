import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  getSessionUser: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/storage', () => ({
  uploadFile: boundary.uploadFile,
  getPublicUrl: (b: string, p: string) => `https://x.supabase.co/storage/v1/object/public/${b}/${p}`,
  parseStorageRef: (v: string) => {
    const m = v.match(/\/object\/public\/([^/]+)\/(.+)$/);
    return m ? { bucket: m[1], path: m[2] } : null;
  },
  sanitizeStorageFileName: (n: string) => n.replace(/[^a-zA-Z0-9._-]/g, '_'),
}));
vi.mock('@/lib/authSession', () => ({ getSessionUser: boundary.getSessionUser }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: boundary.from } }));

import {
  DossierFileError, dossierStorageValue, listCustomerDossierFiles, removeDossierFile,
  slugTen, tenTepHoSo, uploadDossierFile,
} from '../residenceDossierFiles';

type Chain = Record<string, ReturnType<typeof vi.fn>> & { then: (res: (v: unknown) => void) => void };
function table(result: unknown): Chain {
  const chain = {} as Chain;
  for (const m of ['select', 'eq', 'is', 'in', 'order', 'insert', 'update', 'single', 'maybeSingle']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (res) => res(result);
  return chain;
}

describe('tenTepHoSo', () => {
  it('ảnh chủ quyền mang tên toà và số thứ tự', () => {
    expect(tenTepHoSo({ kind: 'OWNERSHIP', buildingName: '950NK', index: 1, ext: 'jpg' })).toBe('chuquyen950nk1.jpg');
    expect(tenTepHoSo({ kind: 'OWNERSHIP', buildingName: '950NK', index: 2, ext: 'png' })).toBe('chuquyen950nk2.png');
  });
  it('ảnh của khách mang tên khách, bỏ dấu', () => {
    expect(tenTepHoSo({ kind: 'CT01', customerName: 'Nguyễn Gia Bình', index: 1, ext: 'jpg' })).toBe('nguyengiabinhct011.jpg');
    expect(tenTepHoSo({ kind: 'LEASE', customerName: 'Nguyễn Gia Bình', index: 3, ext: 'jpg' })).toBe('nguyengiabinhhopdong3.jpg');
  });
  it('thiếu tên thì vẫn ra tên dùng được, không có ký tự lạ', () => {
    const t = tenTepHoSo({ kind: 'OWNERSHIP', index: 0, ext: '' });
    expect(t).toBe('chuquyentoanha1.jpg');
    expect(t).toMatch(/^[a-z0-9]+\.[a-z0-9]+$/);
  });
  it('slugTen bỏ dấu và khoảng trắng', () => {
    expect(slugTen('Toà 950 NK')).toBe('toa950nk');
    expect(slugTen('Đặng Thuỳ Trâm')).toBe('dangthuytram');
  });
});

describe('uploadDossierFile', () => {
  beforeEach(() => {
    boundary.from.mockReset();
    boundary.uploadFile.mockReset();
    boundary.getSessionUser.mockResolvedValue({ id: 'user-1' });
    boundary.uploadFile.mockResolvedValue('https://x.supabase.co/storage/v1/object/public/residence-docs/user-1/ct01/1-nguyengiabinhct011.jpg');
  });

  it('đặt tên theo khách, giữ ảnh gốc, rồi ghi dòng bảng', async () => {
    const buildings = table({ data: { organization_id: 'org-1', name: '950NK' }, error: null });
    const inserted = { id: 'f1', kind: 'CT01', object_name: 'user-1/ct01/1-nguyengiabinhct011.jpg', bucket_id: 'residence-docs' };
    const dem = table({ data: [], error: null });      // lần 1: đếm ảnh đã có
    const files = table({ data: inserted, error: null }); // lần 2: chèn dòng mới
    let lanGoi = 0;
    boundary.from.mockImplementation((t: string) => {
      if (t === 'buildings') return buildings;
      lanGoi += 1;
      return lanGoi === 1 ? dem : files;
    });

    const out = await uploadDossierFile({
      kind: 'CT01', buildingId: 'b1', customerId: 'c1', contractId: 'ct1', customerName: 'Nguyễn Gia Bình',
      file: new File(['x'], 'IMG_20260915_1.jpg', { type: 'image/jpeg' }),
    });

    expect(boundary.uploadFile.mock.calls[0][0]).toBe('residence-docs');
    expect(boundary.uploadFile.mock.calls[0][1]).toMatch(/^user-1\/ct01\/\d+-nguyengiabinhct011\.jpg$/);
    // Cổng DVC từ chối WebP nên phải giữ nguyên byte gốc.
    expect(boundary.uploadFile.mock.calls[0][3]).toEqual({ imagePolicy: 'identity-original' });
    expect(files.insert.mock.calls[0][0]).toMatchObject({
      kind: 'CT01', building_id: 'b1', organization_id: 'org-1', customer_id: 'c1', contract_id: 'ct1',
      content_type: 'image/jpeg', created_by: 'user-1', file_name: 'nguyengiabinhct011.jpg',
    });
    expect(out).toEqual(inserted);
  });

  it('ảnh chủ quyền không gắn khách và lấy tên toà từ database', async () => {
    const buildings = table({ data: { organization_id: 'org-1', name: '950NK' }, error: null });
    const files = table({ data: [], error: null });
    const filesInsert = table({ data: { id: 'f2' }, error: null });
    let lanGoi = 0;
    boundary.from.mockImplementation((t: string) => {
      if (t === 'buildings') return buildings;
      lanGoi += 1;
      return lanGoi === 1 ? files : filesInsert; // lần 1 = đếm ảnh đã có, lần 2 = chèn
    });
    await uploadDossierFile({ kind: 'OWNERSHIP', buildingId: 'b1', customerId: 'c1', file: new File(['x'], 'g.png', { type: 'image/png' }) });
    expect(filesInsert.insert.mock.calls[0][0]).toMatchObject({
      kind: 'OWNERSHIP', customer_id: null, file_name: 'chuquyen950nk1.png',
    });
  });

  it('từ chối tệp không phải ảnh trước khi tải', async () => {
    await expect(uploadDossierFile({ kind: 'OWNERSHIP', buildingId: 'b1', file: new File(['x'], 'a.pdf', { type: 'application/pdf' }) }))
      .rejects.toBeInstanceOf(DossierFileError);
    expect(boundary.uploadFile).not.toHaveBeenCalled();
  });

  it('từ chối WebP vì Cổng DVC không nhận', async () => {
    await expect(uploadDossierFile({ kind: 'OWNERSHIP', buildingId: 'b1', file: new File(['x'], 'a.webp', { type: 'image/webp' }) }))
      .rejects.toThrow(/JPG hoặc PNG/);
    expect(boundary.uploadFile).not.toHaveBeenCalled();
  });

  it('CT01 thiếu khách thì báo lỗi', async () => {
    await expect(uploadDossierFile({ kind: 'CT01', buildingId: 'b1', file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) }))
      .rejects.toThrow(/khách/i);
  });

  it('lỗi quyền 42501 thành thông báo tiếng Việt', async () => {
    const buildings = table({ data: { organization_id: 'org-1' }, error: null });
    const files = table({ data: null, error: { code: '42501' } });
    boundary.from.mockImplementation((t: string) => (t === 'buildings' ? buildings : files));
    await expect(uploadDossierFile({ kind: 'CT01', buildingId: 'b1', customerId: 'c1', file: new File(['x'], 'a.jpg', { type: 'image/jpeg' }) }))
      .rejects.toThrow(/không có quyền/i);
  });
});

describe('listCustomerDossierFiles', () => {
  it('lọc theo khách, chưa xoá', async () => {
    const rows = [{ id: '1', kind: 'LEASE' }];
    const files = table({ data: rows, error: null });
    boundary.from.mockReturnValue(files);
    expect(await listCustomerDossierFiles('c1')).toEqual(rows);
    expect(files.eq).toHaveBeenCalledWith('customer_id', 'c1');
    expect(files.is).toHaveBeenCalledWith('deleted_at', null);
  });
});

describe('removeDossierFile', () => {
  it('xoá mềm bằng deleted_at', async () => {
    const files = table({ error: null });
    boundary.from.mockReturnValue(files);
    await removeDossierFile('f1');
    expect(files.update.mock.calls[0][0]).toHaveProperty('deleted_at');
    expect(files.eq).toHaveBeenCalledWith('id', 'f1');
  });
});

describe('dossierStorageValue', () => {
  it('dựng URL public để StorageImage ký lúc đọc', () => {
    expect(dossierStorageValue({ bucket_id: 'residence-docs', object_name: 'u/x.webp' }))
      .toBe('https://x.supabase.co/storage/v1/object/public/residence-docs/u/x.webp');
  });
});
