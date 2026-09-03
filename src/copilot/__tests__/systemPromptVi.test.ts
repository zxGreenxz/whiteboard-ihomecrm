// System prompt là MÃ, không phải văn bản trang trí — nó đi kèm mọi request và
// mọi câu sai trong đó là một lỗi chạy mỗi lượt chat.
//
// Hai thứ đắt nhất được canh ở đây:
//   1. KHÔNG NHẮC TOOL KHÔNG CÓ THẬT. Một ví dụ mẫu dạy mô hình gọi một cái tên
//      đã bị gỡ thì nó hoặc gọi rồi ăn lỗi, hoặc lờ luôn cả ví dụ. Test song
//      sinh của luật này ở `copilot.test.ts` canh phần description của tool;
//      phần prompt trước nay không ai canh.
//   2. NGÂN SÁCH. Từ điển + few-shot đi cùng MỌI request; để nó phình vô hạn là
//      trả tiền token cho một thứ không ai đo.
import { describe, expect, it } from 'vitest';
import {
  CHAT_SYSTEM_PROMPT,
  TU_DIEN_NGHIEP_VU,
  UI_CONTROL_SYSTEM_PROMPT,
  VI_DU_MAU,
} from '../systemPromptVi';
import { buildRegistryDefinitions } from '../tools/registry';

const TOAN_BO = [CHAT_SYSTEM_PROMPT, TU_DIEN_NGHIEP_VU, VI_DU_MAU, UI_CONTROL_SYSTEM_PROMPT].join('\n');

/**
 * Từ snake_case trong prompt được coi là "tên tool".
 *
 * Quét theo HÌNH DẠNG chứ không theo cụm "gọi X": bản trước ở `copilot.test.ts`
 * chỉ bắt các chỗ viết "gọi X", nên một ví dụ mẫu viết "dùng bao_cao_ma"
 * (không có chữ "gọi") lọt qua. Trong tiếng Việt không có từ nào chứa gạch
 * dưới, nên mọi token dạng này trong prompt đều đang xưng danh một tool.
 */
const tuSnakeCase = (s: string): string[] => [...s.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map((m) => m[0]);

describe('prompt KHÔNG được nhắc tool không tồn tại', () => {
  it('mọi tên snake_case trong prompt đều là tool có thật trong registry', () => {
    const tenTool = new Set(buildRegistryDefinitions().map((t) => t.name));
    const nhac = [...new Set(tuSnakeCase(TOAN_BO))];
    expect(nhac.length, 'prompt phải thật sự có nhắc tên tool, nếu không test này đo rỗng').toBeGreaterThan(3);
    for (const ten of nhac) {
      expect(tenTool.has(ten), `prompt nhắc tool không tồn tại: "${ten}"`).toBe(true);
    }
  });

  it('few-shot nhắc ĐỦ các tool nó cần và không nhắc respond', () => {
    for (const ten of ['phong_trong', 'doanh_thu_thang', 'huong_dan', 'tao_phieu_thu_chi_nhap']) {
      expect(VI_DU_MAU, ten).toContain(ten);
    }
    expect(VI_DU_MAU).not.toContain('respond');
  });
});

describe('từ điển nghiệp vụ — nghĩa RIÊNG của sản phẩm này', () => {
  it('nêu đủ các khái niệm dễ hiểu sai nhất', () => {
    for (const khai of ['Cọc', 'thanh lý', 'gia hạn', 'nhượng', 'công tơ', 'UNAPPROVED', 'POSTED', 'Sổ quỹ', 'maker']) {
      expect(TU_DIEN_NGHIEP_VU.toLowerCase(), khai).toContain(khai.toLowerCase());
    }
  });

  it('phân biệt ĐÃ DUYỆT với ĐÃ VÀO SỔ, và doanh thu với tiền đã thu', () => {
    // Hai chỗ nhầm đắt nhất: mô hình coi APPROVED là tiền đã vào sổ, và coi
    // doanh thu là tiền mặt đã thu. Cả hai đều cho một con số nghe rất hợp lý.
    expect(TU_DIEN_NGHIEP_VU).toContain('vào sổ');
    expect(TU_DIEN_NGHIEP_VU).toMatch(/Doanh thu ≠ tiền đã thu/);
  });

  it('nói rõ giới hạn: chỉ lập NHÁP, người dùng mới là người duyệt', () => {
    expect(TU_DIEN_NGHIEP_VU).toMatch(/NH[ÁA]P/);
    expect(TU_DIEN_NGHIEP_VU).toMatch(/không phải người phê duyệt|không.*duyệt/i);
  });

  it('gọn — dưới 40 dòng, vì nó đi kèm MỌI request', () => {
    expect(TU_DIEN_NGHIEP_VU.split('\n').length).toBeLessThanOrEqual(40);
  });
});

describe('luật trích nguồn', () => {
  it('CHAT_SYSTEM_PROMPT bắt giữ nguyên "(nguồn: …)" và nêu tool + kỳ cho số liệu', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('(nguồn:');
    expect(CHAT_SYSTEM_PROMPT).toMatch(/TR[ÍI]CH NGU[ỒO]N/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/kỳ nào/);
  });

  it('few-shot LÀM MẪU luật đó — mọi ví dụ có số đều kèm nguồn', () => {
    const viDuCoSo = VI_DU_MAU.split('\n').filter((d) => /\d\.\d{3}\.\d{3} đ/.test(d));
    expect(viDuCoSo.length).toBeGreaterThanOrEqual(3);
    // Ví dụ 5 là đường GHI: nó cố ý không có nguồn tra cứu mà có câu dừng lại.
    for (const d of viDuCoSo) {
      expect(d.includes('(nguồn:') || d.includes('chờ duyệt'), d).toBe(true);
    }
    expect(VI_DU_MAU).toContain('1.500.000 đ');
  });
});

describe('ngân sách prompt', () => {
  it('tổng phần TĨNH của system prompt còn trong tầm kiểm soát', () => {
    // Con số này là một trần, không phải một mục tiêu. Nó tồn tại để lần sau ai
    // đó dán thêm ba trang hướng dẫn vào prompt thì thấy đỏ NGAY, thay vì phát
    // hiện qua hoá đơn token một tháng sau.
    const tinh = [CHAT_SYSTEM_PROMPT, TU_DIEN_NGHIEP_VU, VI_DU_MAU].join('\n\n');
    expect(tinh.length).toBeLessThanOrEqual(9_000);
    expect(tinh.length).toBeGreaterThan(3_000);
  });
});
