import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { locPhongChuyenDuoc, type PhongCoTheChuyen } from '../contractRoomFilter';

const phongArb: fc.Arbitrary<PhongCoTheChuyen> = fc.record({
  id: fc.uuid(),
  status: fc.constantFrom('AVAILABLE', 'OCCUPIED', 'RESERVED', 'MAINTENANCE'),
  building_id: fc.constantFrom('toa-A', 'toa-B', 'toa-C'),
});

describe('locPhongChuyenDuoc — tính chất', () => {
  it('chưa chọn toà thì luôn trả rỗng, bất kể danh sách phòng', () => {
    fc.assert(
      fc.property(fc.array(phongArb, { maxLength: 40 }), (phong) => {
        expect(locPhongChuyenDuoc(phong, null)).toEqual([]);
        expect(locPhongChuyenDuoc(phong, undefined)).toEqual([]);
        expect(locPhongChuyenDuoc(phong, '')).toEqual([]);
      }),
    );
  });

  it('chưa chọn toà: KHÔNG khớp cả phòng có building_id rỗng', () => {
    // Ca này tồn tại vì đột biến. Tôi thử bỏ `if (!toaDangChon) return []` khỏi hàm
    // thật, và bốn test kia VẪN XANH — vì với dữ liệu sinh ra, `building_id` không
    // bao giờ bằng '' hay undefined nên phép lọc vẫn ra rỗng. Tức guard đó không
    // được test nào quan sát.
    //
    // Một phòng có building_id rỗng (dữ liệu lỗi, hoặc bản ghi đang dựng) là đầu
    // vào DUY NHẤT phân biệt được hai bản: không có guard thì `'' === ''` khớp và
    // phòng đó lọt vào danh sách chọn dù người dùng chưa chọn toà nào.
    const phongLoi: PhongCoTheChuyen = { id: 'phong-loi', status: 'AVAILABLE', building_id: '' };
    expect(locPhongChuyenDuoc([phongLoi], '')).toEqual([]);
    expect(locPhongChuyenDuoc([phongLoi], null)).toEqual([]);
  });

  it('mọi phòng trả về đều AVAILABLE và đúng toà đã chọn', () => {
    fc.assert(
      fc.property(
        fc.array(phongArb, { maxLength: 40 }),
        fc.constantFrom('toa-A', 'toa-B', 'toa-C'),
        (phong, toa) => {
          for (const p of locPhongChuyenDuoc(phong, toa)) {
            expect(p.status).toBe('AVAILABLE');
            expect(p.building_id).toBe(toa);
          }
        },
      ),
    );
  });

  it('không bỏ sót: mọi phòng AVAILABLE đúng toà đều có mặt', () => {
    fc.assert(
      fc.property(
        fc.array(phongArb, { maxLength: 40 }),
        fc.constantFrom('toa-A', 'toa-B', 'toa-C'),
        (phong, toa) => {
          const mong = phong.filter((p) => p.status === 'AVAILABLE' && p.building_id === toa);
          expect(locPhongChuyenDuoc(phong, toa)).toHaveLength(mong.length);
        },
      ),
    );
  });

  it('giữ nguyên thứ tự đầu vào — danh sách chọn không được nhảy lung tung', () => {
    fc.assert(
      fc.property(
        fc.array(phongArb, { maxLength: 40 }),
        fc.constantFrom('toa-A', 'toa-B', 'toa-C'),
        (phong, toa) => {
          const ra = locPhongChuyenDuoc(phong, toa).map((p) => p.id);
          const mong = phong
            .filter((p) => p.status === 'AVAILABLE' && p.building_id === toa)
            .map((p) => p.id);
          expect(ra).toEqual(mong);
        },
      ),
    );
  });

  it('loại phòng hiện tại ngay cả khi dữ liệu phòng đang ghi AVAILABLE', () => {
    const phongHienTai: PhongCoTheChuyen = {
      id: 'phong-dang-o',
      status: 'AVAILABLE',
      building_id: 'toa-A',
    };
    expect(locPhongChuyenDuoc([phongHienTai], 'toa-A', phongHienTai.id)).toEqual([]);
  });
});
