// Ngữ cảnh trang GIÀU: trang + bộ lọc đang áp + công cụ hợp trang.
//
// VÌ SAO ĐÁNG MỘT FILE TEST RIÊNG
//   Dòng ngữ cảnh cũ chỉ có nhãn trang. Người dùng đang lọc hoá đơn tháng 7 của
//   một toà và hỏi "cái này còn nợ bao nhiêu" thì mô hình thấy `/invoices`, tra
//   cả tổ chức, và trả về một con số TO HƠN con số đang hiện trên màn hình. Hai
//   câu trả lời cùng đúng cú pháp, khác nhau, và người dùng chỉ thấy cái sai.
//
//   Mặt trái của việc nhét query string vào prompt là PII: URL của app này có
//   thể mang tên khách, số điện thoại, id tài khoản. Nên luật ở đây là
//   allowlist khoá + trần độ dài, và cả hai phải có test riêng.
import { describe, expect, it } from 'vitest';
import type { PermissionsMap } from '@/lib/permissions';
import {
  DAI_TOI_DA_GIA_TRI_LOC,
  SO_LOC_TOI_DA,
  SO_TOOL_GOI_Y,
  dongNguCanhTrang,
  goiYToolTheoTrang,
  khoaTrangTheoRoute,
  locTuUrl,
} from '../banDoHeThong';

const SUPER: PermissionsMap = { __superadmin: true } as unknown as PermissionsMap;

const TOOL_GIA = [
  { name: 'tim_hoa_don', rolloutKey: 'invoices.list' },
  { name: 'cong_no_tong_quan', rolloutKey: 'invoices.list' },
  { name: 'bao_cao_thu_thua', rolloutKey: 'invoices.list' },
  { name: 'doanh_thu_thang', rolloutKey: 'invoices.list' },
  { name: 'phong_trong', rolloutKey: 'rooms.list' },
  { name: 'khong_khoa' },
];

describe('locTuUrl — allowlist khoá, không phải blocklist', () => {
  it('lấy đúng các khoá bộ lọc có cấu trúc', () => {
    expect(locTuUrl('?thang=2026-07&status=unpaid')).toEqual(['status=unpaid', 'thang=2026-07']);
  });

  it('bỏ khoá NGOÀI allowlist — kể cả khoá trông vô hại', () => {
    // `q`/`search` là ô tìm kiếm tự do: nó hay chứa tên khách hoặc số điện
    // thoại, tức PII đi thẳng vào prompt mà không qua maskPii.
    const ra = locTuUrl('?q=Nguyen Van A&phone=0378160165&account_id=abc&thang=2026-07');
    expect(ra).toEqual(['thang=2026-07']);
  });

  it('bỏ giá trị QUÁ DÀI — đó là dữ liệu dán vào URL, không phải bộ lọc', () => {
    const dai = 'x'.repeat(DAI_TOI_DA_GIA_TRI_LOC + 1);
    expect(locTuUrl(`?status=${dai}`)).toEqual([]);
    expect(locTuUrl(`?status=${'y'.repeat(DAI_TOI_DA_GIA_TRI_LOC)}`)).toHaveLength(1);
  });

  it('bỏ giá trị rỗng, và chịu được search không có dấu ?', () => {
    expect(locTuUrl('?status=&thang=2026-07')).toEqual(['thang=2026-07']);
    expect(locTuUrl('thang=2026-07')).toEqual(['thang=2026-07']);
    expect(locTuUrl(undefined)).toEqual([]);
    expect(locTuUrl('')).toEqual([]);
  });

  it('trần số bộ lọc, và thứ tự KHÔNG phụ thuộc thứ tự trong URL', () => {
    // Prompt phải ổn định: cùng một màn hình sinh cùng một chuỗi, nếu không
    // prompt cache trượt mỗi lần người dùng bấm lại đúng bộ lọc cũ.
    const a = locTuUrl('?thang=2026-07&status=unpaid&tab=all');
    const b = locTuUrl('?tab=all&status=unpaid&thang=2026-07');
    expect(a).toEqual(b);
    const nhieu = locTuUrl('?thang=1&status=2&tab=3&layer=4&loai=5&type=6&year=7&nam=8');
    expect(nhieu).toHaveLength(SO_LOC_TOI_DA);
  });
});

describe('khoaTrangTheoRoute — khoá trang khớp `rolloutKey` của tool', () => {
  it('trả khoá contract của trang, khớp route DÀI NHẤT', () => {
    expect(khoaTrangTheoRoute('/invoices')).toBe('invoices.list');
    expect(khoaTrangTheoRoute('/invoices/abc-123')).toBe('invoices.list');
    // Route của trang phòng là `/apartments` chứ không phải `/rooms` — khoá
    // trang phải lấy từ contract, không suy từ tên module.
    expect(khoaTrangTheoRoute('/apartments')).toBe('rooms.list');
  });

  it('đường dẫn không thuộc trang nào ⇒ null', () => {
    expect(khoaTrangTheoRoute('/khong-co-trang-nay')).toBeNull();
  });
});

describe('goiYToolTheoTrang', () => {
  it('chỉ lấy tool có rolloutKey trùng khoá trang, tối đa 3, thứ tự ổn định', () => {
    const ra = goiYToolTheoTrang('invoices.list', TOOL_GIA);
    expect(ra).toHaveLength(SO_TOOL_GOI_Y);
    expect(ra).toEqual(['bao_cao_thu_thua', 'cong_no_tong_quan', 'doanh_thu_thang']);
    expect(ra).not.toContain('phong_trong');
  });

  it('không có khoá trang, hoặc không tool nào khớp ⇒ mảng rỗng', () => {
    expect(goiYToolTheoTrang(null, TOOL_GIA)).toEqual([]);
    expect(goiYToolTheoTrang('tasks.list', TOOL_GIA)).toEqual([]);
  });
});

describe('dongNguCanhTrang — ghép cả ba mảnh', () => {
  it('vẫn giữ nguyên hành vi cũ khi không có search và không có tool', () => {
    const d = dongNguCanhTrang('/invoices', SUPER)!;
    expect(d).toContain('Hoá đơn');
    expect(d).toContain('/invoices');
    expect(d).toContain('cái này');
  });

  it('kể bộ lọc đang áp và DẶN trả lời theo đúng phạm vi đó', () => {
    const d = dongNguCanhTrang('/invoices', SUPER, { search: '?thang=2026-07&status=unpaid' })!;
    expect(d).toContain('thang=2026-07');
    expect(d).toContain('status=unpaid');
    expect(d).toMatch(/phạm vi/i);
  });

  it('kể công cụ hợp trang, lấy từ bộ tool được truyền vào', () => {
    const d = dongNguCanhTrang('/invoices', SUPER, { tools: TOOL_GIA })!;
    expect(d).toContain('cong_no_tong_quan');
    expect(d).not.toContain('phong_trong');
  });

  it('KHÔNG bịa dòng bộ lọc khi URL không có bộ lọc nào hợp lệ', () => {
    const d = dongNguCanhTrang('/invoices', SUPER, { search: '?q=abc' })!;
    expect(d).not.toMatch(/Bộ lọc đang áp/);
  });

  it('trang ngoài bản đồ vẫn trả null, kể cả khi có search', () => {
    expect(dongNguCanhTrang('/khong-co-trang-nay', SUPER, { search: '?thang=2026-07' })).toBeNull();
  });

  it('trên REGISTRY THẬT, trang hoá đơn gợi ý được công cụ thật', async () => {
    // Sàn chống-xanh-rỗng: fixture ở trên kiểm LUẬT, còn đây kiểm rằng luật đó
    // thật sự khớp được với `rolloutKey` mà registry đang khai.
    const { buildRegistryDefinitions } = await import('../tools/registry');
    const goiY = goiYToolTheoTrang(khoaTrangTheoRoute('/invoices'), buildRegistryDefinitions());
    expect(goiY.length).toBeGreaterThan(0);
    expect(goiY).toContain('tim_hoa_don');
  });
});
