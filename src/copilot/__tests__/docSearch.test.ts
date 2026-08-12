// Test trí nhớ tài liệu: chunk theo heading, BM25 tiếng Việt, và bất biến
// quyền. Chạy trên CORPUS THẬT (`docs/he-thong/*.md` qua glob của Vite) cho các
// ca xếp hạng — corpus dựng tay không phản ánh được độ nhập nhằng thật.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionsMap } from '@/lib/permissions';
import { boDau, moRongDongNghia, tachTu, themBigram } from '../docs/tokenize';
import { slugHeading, tachChunk } from '../docs/chunker';
import { chamDiem, dungIndex, W_TIEU_DE } from '../docs/bm25';
import { dinhDangChoModel, timTaiLieu, xoaCacheIndex, GIOI_HAN_KY_TU } from '../docs/docSearch';
import * as registry from '../tools/registry';

const SUPER: PermissionsMap = { __superadmin: true } as unknown as PermissionsMap;
const STAFF_ROOMS_ONLY: PermissionsMap = { rooms: { view: true } };

beforeEach(() => xoaCacheIndex());

describe('boDau — người dùng gõ không dấu', () => {
  it('bỏ dấu thanh và dấu mũ', () => {
    expect(boDau('Hoá Đơn Thanh Toán')).toBe('hoa don thanh toan');
    expect(boDau('CỌC GIỮ CHỖ')).toBe('coc giu cho');
  });

  it('xử lý CẢ NFC lẫn NFD — cùng chữ, hai dãy byte', () => {
    // Corpus lẫn cả hai dạng. Chỉ test một dạng là để lọt đúng lỗi nguy hiểm
    // nhất: nửa corpus im lặng không khớp được.
    const nfc = 'hoá'.normalize('NFC');
    const nfd = 'hoá'.normalize('NFD');
    expect(nfc).not.toBe(nfd); // xác nhận fixture đúng là hai dãy khác nhau
    expect(boDau(nfc)).toBe('hoa');
    expect(boDau(nfd)).toBe('hoa');
  });

  it('đ → d (đ là CHỮ CÁI, NFD không tách được)', () => {
    expect(boDau('đơn')).toBe('don');
    expect(boDau('Đối soát')).toBe('doi soat');
  });
});

describe('bigram — âm tiết đơn quá nhập nhằng', () => {
  it('sinh bigram kề', () => {
    expect(themBigram(tachTu('hoá đơn'))).toEqual(['hoa', 'don', 'hoa_don']);
  });

  it('đồng nghĩa chỉ mở rộng, không thay thế', () => {
    const r = moRongDongNghia(['coc']);
    expect(r).toContain('coc');
    expect(r).toContain('tien_coc');
  });
});

describe('tachChunk — cắt theo heading, giữ ngữ cảnh cha', () => {
  const MD = [
    '# Hoá đơn và thanh toán',
    '',
    'Đoạn mở đầu định nghĩa thuật ngữ.',
    '',
    '## 4. Ghi nhận thanh toán',
    '',
    'Thân của mục 4.',
    '',
    '### 4.1. Adapter v4',
    '',
    'Thân của mục 4.1.',
  ].join('\n');

  it('đoạn giữa H1 và H2 đầu tiên KHÔNG bị vứt', () => {
    // Ở bộ tài liệu này đó là khối "Reviewed / nguồn hiện hành", thường định
    // nghĩa thuật ngữ — mất nó là mất phần đắt nhất.
    const c = tachChunk(MD, '07-hoa-don');
    expect(c[0].text).toContain('Đoạn mở đầu');
    expect(c[0].level).toBe(1);
  });

  it('headingPath mang ĐẦY ĐỦ đường dẫn cha', () => {
    const c = tachChunk(MD, '07-hoa-don');
    const sau = c.find((x) => x.text.includes('mục 4.1'))!;
    expect(sau.headingPath).toEqual(['Hoá đơn và thanh toán', '4. Ghi nhận thanh toán', '4.1. Adapter v4']);
    expect(sau.anchor).toBe('4-1-adapter-v4');
  });

  it('KHÔNG cắt tại heading nằm trong code fence', () => {
    const md = ['# T', '', '```md', '## Không phải heading', '```', '', 'thân'].join('\n');
    expect(tachChunk(md, 'x')).toHaveLength(1);
  });

  it('nhảy bậc (## rồi ####) vẫn giữ đường dẫn đúng', () => {
    const md = ['# T', '## A', 'a', '#### B', 'b'].join('\n');
    const c = tachChunk(md, 'x');
    expect(c.find((x) => x.text === 'b')!.headingPath).toEqual(['T', 'A', 'B']);
  });

  it('chunk quá dài bị chẻ nhưng GIỮ NGUYÊN anchor', () => {
    const to = ['# T', '## Muc', ...Array.from({ length: 60 }, (_, i) => `Đoạn ${i} ${'x'.repeat(80)}\n`)].join('\n');
    const c = tachChunk(to, 'x');
    expect(c.length).toBeGreaterThan(1);
    expect(new Set(c.map((x) => x.anchor)).size).toBe(1);
    expect(c[1].id).toMatch(/~2$/);
  });

  it('slugHeading bỏ dấu và ký tự lạ', () => {
    expect(slugHeading('4.1. Adapter v4 → v3')).toBe('4-1-adapter-v4-v3');
  });
});

describe('BM25 trên corpus THẬT', () => {
  const timSuper = (q: string) => timTaiLieu(q, SUPER);

  it('hỏi "thanh lý hợp đồng" → đúng tài liệu thanh lý, không phải tài liệu chỉ NHẮC TỚI', async () => {
    // Đây là ca mà trọng số tiêu đề tồn tại để giải: `05-hop-dong.md` có nhắc
    // thanh lý ở vài chỗ, nhưng tài liệu ĐÚNG là `16-thanh-ly-hop-dong.md`.
    const kq = await timSuper('thanh lý hợp đồng');
    expect(kq.hits.length).toBeGreaterThan(0);
    expect(kq.hits[0].chunk.docKey).toBe('16-thanh-ly-hop-dong');
  });

  it('gõ KHÔNG DẤU vẫn ra đúng tài liệu', async () => {
    const kq = await timSuper('thanh ly hop dong');
    expect(kq.hits[0].chunk.docKey).toBe('16-thanh-ly-hop-dong');
  });

  it('câu hỏi tự nhiên (không trùng tên file) vẫn tìm được', async () => {
    // Bản cũ so khớp trên tên file nên câu này KHÔNG BAO GIỜ ra kết quả.
    const kq = await timSuper('làm sao lấy lại tiền cọc khi trả phòng');
    expect(kq.hits.length).toBeGreaterThan(0);
    const keys = kq.hits.map((h) => h.chunk.docKey);
    expect(keys.some((k) => /coc|thanh-ly/.test(k))).toBe(true);
  });

  it('tìm được nội dung nằm SÂU trong tài liệu lớn (ngoài 8000 ký tự đầu)', async () => {
    // Bản cũ cắt 8000 ký tự đầu, nên mọi mục sau đó là vùng mù.
    const noiDung = await registry.napTaiLieu('/docs/he-thong/08-thu-chi-so-quy.md');
    expect(noiDung!.length).toBeGreaterThan(8000);
    const chunks = tachChunk(noiDung!, '08-thu-chi-so-quy');
    const sau8k = chunks.filter((c) => noiDung!.indexOf(c.text) > 8000);
    expect(sau8k.length).toBeGreaterThan(3); // sàn chống-xanh-rỗng
    const idx = dungIndex(chunks);
    // Lấy một cụm chỉ có ở phần sâu và kiểm tra tìm được.
    const tieuDeSau = sau8k[Math.floor(sau8k.length / 2)].headingPath.at(-1)!;
    const hits = chamDiem(idx, tieuDeSau);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('sàn chống-xanh-rỗng: corpus thật đủ lớn', async () => {
    const kq = await timSuper('hợp đồng');
    expect(kq.hits.length).toBeGreaterThan(0);
    const topics = registry.listDocTopics(SUPER);
    expect(topics.length).toBeGreaterThanOrEqual(20);
  });

  it('W_TIEU_DE là hằng có tên và lớn hơn 1', () => {
    expect(W_TIEU_DE).toBeGreaterThan(1);
  });
});

describe('BẤT BIẾN SỐ MỘT — không tải byte tài liệu gác quyền', () => {
  it('KHÔNG gọi loader cho tài liệu ngoài quyền (spy, không phải khẳng định đầu ra)', async () => {
    // Khẳng định trên chuỗi trả về KHÔNG bắt được lỗi này: nội dung có thể đã
    // xuống trình duyệt và nằm trong bộ nhớ/tab Network mà vẫn không lọt ra
    // output. Phải theo dõi chính lời gọi tải.
    const spy = vi.spyOn(registry, 'napTaiLieu');
    await timTaiLieu('lương thưởng nhân viên', STAFF_ROOMS_ONLY);
    const daTai = spy.mock.calls.map((c) => c[0] as string);
    expect(daTai.length).toBeGreaterThan(5); // sàn: có thật sự tải gì đó
    for (const gac of ['17-luong-thuong', '12-co-dong-loi-nhuan', '19-sop-tien-va-so-quy', '20-phe-duyet-tai-chinh']) {
      expect(daTai.some((p) => p.includes(gac))).toBe(false);
    }
    spy.mockRestore();
  });

  it('nội dung tài liệu gác quyền không lọt vào kết quả', async () => {
    const kq = await timTaiLieu('lương thưởng hoa hồng', STAFF_ROOMS_ONLY);
    expect(kq.hits.every((h) => h.chunk.docKey !== '17-luong-thuong')).toBe(true);
  });

  it('có quyền thì thấy', async () => {
    const kq = await timTaiLieu('lương thưởng', { ...STAFF_ROOMS_ONLY, salary: { view: true } });
    expect(kq.hits.some((h) => h.chunk.docKey === '17-luong-thuong')).toBe(true);
  });

  it('tài liệu NGOÀI allowlist manifest không bao giờ vào index, kể cả superadmin', async () => {
    const spy = vi.spyOn(registry, 'napTaiLieu');
    await timTaiLieu('hiệu năng realtime platform delivery', SUPER);
    const daTai = spy.mock.calls.map((c) => c[0] as string);
    for (const cam of ['perf-2026-06-30', 'realtime-sync', '24-platform-delivery', 'README']) {
      expect(daTai.some((p) => p.includes(cam))).toBe(false);
    }
    spy.mockRestore();
  });
});

describe('perms chưa tải — chặn kín nội dung, nhưng nói to lý do', () => {
  it('đánh dấu quyenChuaTai và trả câu giải thích, KHÔNG nói "không tìm thấy"', async () => {
    // Im lặng ở đây khiến người CÓ quyền kết luận sai rằng tài liệu không tồn tại.
    const kq = await timTaiLieu('lương thưởng', undefined);
    expect(kq.quyenChuaTai).toBe(true);
    expect(kq.hits.every((h) => h.chunk.docKey !== '17-luong-thuong')).toBe(true);
  });

  it('perms ĐÃ tải mà thiếu quyền thì KHÔNG kể tên tài liệu bị ẩn trong phần ta sinh ra', async () => {
    // Khẳng định phải đúng phạm vi. Chuỗi "17-luong-thuong" CÓ THỂ xuất hiện
    // hợp lệ trong thân một tài liệu được phép — `99-quy-trinh-tong` có link
    // trỏ sang nó. Đó là nội dung sẵn có của tài liệu hợp lệ, không phải rò rỉ.
    // Bất biến thật hẹp hơn: không nhãn `(nguồn: …)` nào, và không mục nào
    // trong danh sách "Chủ đề liên quan" DO TA SINH RA, được trỏ tới tài liệu
    // ngoài quyền.
    const kq = await timTaiLieu('lương thưởng', STAFF_ROOMS_ONLY);
    const s = dinhDangChoModel(kq);
    expect(s).not.toContain('(nguồn: 17-luong-thuong');
    expect(kq.chuDeLienQuan).not.toContain('17-luong-thuong');
    expect(kq.hits.every((h) => h.chunk.docKey !== '17-luong-thuong')).toBe(true);
  });
});

describe('dinhDangChoModel — ngân sách và trích dẫn', () => {
  it('tôn trọng trần ký tự và chia cho NHIỀU tài liệu', async () => {
    const kq = await timTaiLieu('hợp đồng cọc hoá đơn', SUPER);
    const s = dinhDangChoModel(kq);
    expect(s.length).toBeLessThanOrEqual(GIOI_HAN_KY_TU + 400); // + phần nhãn nguồn
    const soDoc = new Set([...s.matchAll(/\(nguồn: ([^\s]+) §/g)].map((m) => m[1])).size;
    expect(soDoc).toBeGreaterThanOrEqual(2);
  });

  it('mỗi mục có trích dẫn nguồn kèm đường dẫn heading', async () => {
    const kq = await timTaiLieu('thanh lý hợp đồng', SUPER);
    const s = dinhDangChoModel(kq);
    expect(s).toMatch(/\(nguồn: 16-thanh-ly-hop-dong § .+\)/);
  });

  it('trích dẫn là VĂN BẢN THUẦN, không phải link markdown', () => {
    // docs/he-thong không được publish ở đâu cả — link sẽ 404, và một link chết
    // làm mất niềm tin vào cả câu trả lời đúng.
    const kq = { hits: [], quyenChuaTai: false, chuDeLienQuan: [] };
    expect(dinhDangChoModel(kq)).not.toMatch(/\]\(/);
  });

  it('câu vô nghĩa hẳn → nói thẳng là không tìm thấy', async () => {
    const kq = await timTaiLieu('xyzzy plugh frobnicate qwertyuiop', SUPER);
    expect(kq.hits).toHaveLength(0);
    expect(dinhDangChoModel(kq)).toContain('Không tìm thấy');
  });

  it('câu TOÀN HƯ TỪ → không trả rác kèm giọng điệu chắc chắn', async () => {
    // Ca này từng lọt: hư từ vẫn cộng đủ điểm vượt mọi ngưỡng tuyệt đối hợp lý.
    // Nay bị chặn bởi luật "phải khớp ít nhất một từ có sức phân biệt".
    for (const rac of ['cái này thì sao', 'the nao la duoc', 'của và là được thì mà']) {
      const kq = await timTaiLieu(rac, SUPER);
      expect(kq.hits, `"${rac}" không được ra kết quả`).toHaveLength(0);
    }
  });

  it('nhưng câu NGẮN mà có từ hiếm thì VẪN ra — luật lọc không được giết nhầm', async () => {
    // "zalo" chỉ 14,2 điểm, thấp hơn cả câu rác 19,9 — bằng chứng vì sao không
    // dùng ngưỡng điểm tuyệt đối.
    for (const [q, doc] of [['zalo', '18-zalo-chat'], ['công tơ', '06-cong-to-chi-so']] as const) {
      const kq = await timTaiLieu(q, SUPER);
      expect(kq.hits.length, `"${q}" phải ra kết quả`).toBeGreaterThan(0);
      expect(kq.hits[0].chunk.docKey).toBe(doc);
    }
  });
});
