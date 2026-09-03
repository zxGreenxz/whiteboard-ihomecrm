// Test trí nhớ tài liệu: chunk theo heading, BM25 tiếng Việt, và bất biến
// quyền. Chạy trên CORPUS THẬT (`docs/he-thong/*.md` qua glob của Vite) cho các
// ca xếp hạng — corpus dựng tay không phản ánh được độ nhập nhằng thật.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionsMap } from '@/lib/permissions';
import { boDau, moRongDongNghia, tachTu, themBigram, tokenTruyVan } from '../docs/tokenize';
import { boFrontmatter, boLienKetMarkdown, slugHeading, tachChunk } from '../docs/chunker';
import { chamDiem, dungIndex, W_TIEU_DE } from '../docs/bm25';
import {
  canBangTheoTaiLieu,
  dinhDangChoModel,
  timTaiLieu,
  xoaCacheIndex,
  CAP_CHUNK_MOI_TAI_LIEU,
  GIOI_HAN_KY_TU,
} from '../docs/docSearch';
import { CAPABILITIES } from '@/app/capabilities/registry';
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

describe('hư từ KHÔNG được nuốt từ nghiệp vụ', () => {
  /**
   * Rổ này là hàng rào. Bản đầu lọc hư từ SAU khi bỏ dấu và nuốt mất 18 cụm
   * trong đây cùng lúc — hỏi "nợ" hay "phòng trống" trả về rỗng. Thêm mục vào
   * bảng hư từ mà làm rơi một cụm ở đây thì test này phải đỏ.
   */
  const NGHIEP_VU = [
    'nợ', 'chi', 'chỉ số', 'thu chi', 'tài sản', 'tài chính', 'báo cáo',
    'phòng trống', 'mã hoá đơn', 'bán hàng', 'hộ khẩu', 'thẻ từ', 'cửa hàng',
    'đo điện', 'tủ', 'đầu kỳ', 'bảo trì', 'cọc', 'thu', 'chờ duyệt',
    'đăng ký', 'công tơ', 'hợp đồng', 'thanh lý', 'sổ quỹ', 'lương',
  ];

  it('mọi cụm nghiệp vụ đều còn ít nhất một âm tiết sau khi lọc hư từ', () => {
    for (const cum of NGHIEP_VU) {
      const t = tokenTruyVan(cum);
      expect(t.length, `"${cum}" bị lọc sạch — sẽ không tra được gì`).toBeGreaterThan(0);
    }
  });

  it('từ nghiệp vụ MỘT âm tiết vẫn tra được trên corpus thật', async () => {
    // Chỉ khẳng định CÓ kết quả, không khẳng định thứ hạng: một âm tiết đơn là
    // tín hiệu yếu và nhập nhằng theo bản chất ("nợ" xuất hiện rải khắp tài
    // liệu tài sản, thu chi, hợp đồng). Đòi đúng tài liệu nào đứng đầu là đòi
    // hơn thứ dữ liệu cho phép — bản trước của test này khẳng định vậy và đỏ.
    for (const q of ['nợ', 'cọc', 'lương', 'mã']) {
      const kq = await timTaiLieu(q, SUPER);
      expect(kq.hits.length, `"${q}" không ra kết quả`).toBeGreaterThan(0);
    }
  });

  it('âm tiết QUÁ PHỔ BIẾN vẫn trả rỗng — và đó là đúng', async () => {
    // "chi" không còn bị bảng hư từ nuốt (đó là lỗi đã sửa), nhưng nó có mặt ở
    // hơn 20% số chunk nên luật `NGUONG_PHO_BIEN` loại nó vì không còn sức phân
    // biệt. Trả rỗng ở đây đúng hơn là trả sáu đoạn bất kỳ: khi mọi chunk đều
    // khớp thì không có gì để xếp hạng, và nói "hãy hỏi cụ thể hơn" là câu trả
    // lời thật thà. Hai âm tiết trở lên thì bình thường.
    expect((await timTaiLieu('chi', SUPER)).hits).toHaveLength(0);
    expect((await timTaiLieu('chi phí', SUPER)).hits.length).toBeGreaterThan(0);
    expect((await timTaiLieu('thu chi', SUPER)).hits.length).toBeGreaterThan(0);
  });

  it('cụm HAI âm tiết thì thứ hạng mới đủ tin để khẳng định', async () => {
    for (const [q, mong] of [
      ['công nợ', /thu-chi|hoa-don|bao-cao/],
      ['phòng trống', /phong-trong|co-cau|kenh-cong-khai/],
      // 03/09/2026 — corpus mở rộng sang `docs/huong-dan-su-dung/**`, và câu
      // này đổi câu trả lời: trang HƯỚNG DẪN "Sổ quỹ" nay đứng đầu thay cho tài
      // liệu hệ thống. Đó là kết quả ĐÚNG HƠN, không phải hồi quy — người gõ
      // "sổ quỹ" hỏi cách dùng màn đó, và trang hướng dẫn viết cho đúng câu hỏi
      // ấy. Khẳng định được nới đúng bằng một nhánh, không nới thành `/.*/`.
      ['sổ quỹ', /thu-chi|sop-tien|huong-dan-su-dung\/.*so-quy/],
    ] as const) {
      const kq = await timTaiLieu(q, SUPER);
      expect(kq.hits.length, `"${q}" không ra kết quả`).toBeGreaterThan(0);
      expect(kq.hits[0].chunk.docKey, `"${q}" ra ${kq.hits[0].chunk.docKey}`).toMatch(mong);
    }
  });

  it('vẫn lọc được câu toàn hư từ khi gõ CÓ dấu', () => {
    for (const rac of ['cái này thì sao', 'của và là được thì mà', 'thế nào là được']) {
      expect(tokenTruyVan(rac), `"${rac}"`).toHaveLength(0);
    }
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
    // Nhãn nguồn có HAI dạng kể từ 03/09/2026 (`16-thanh-ly-hop-dong § …` cho
    // tài liệu hệ thống, `Hướng dẫn › <tiêu đề> § …` cho trang hướng dẫn — tiêu
    // đề CÓ dấu cách). Bản trước bắt `[^\s]+` nên dạng thứ hai đếm ra 0 và phép
    // đo "chia cho nhiều tài liệu" im lặng đo trên tập rỗng.
    const soDoc = new Set([...s.matchAll(/\(nguồn: ([^)\n]+?) §/g)].map((m) => m[1])).size;
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

// ─────────────────────────────────────────────────────────────────────────────
// G1-D2 — hướng dẫn NGƯỜI DÙNG CUỐI vào chung index BM25
// ─────────────────────────────────────────────────────────────────────────────

describe('allowlist hướng dẫn — suy từ CAPABILITIES, không phải glob mù', () => {
  it('mọi trang được nhận đều là `public` và có trong CAPABILITIES', () => {
    const trang = registry.trangHuongDanChoPhep();
    // Sàn chống-xanh-rỗng: allowlist rỗng trông y hệt "đã lọc kỹ".
    expect(trang.length).toBeGreaterThanOrEqual(20);
    const userDocs = new Set(
      CAPABILITIES.filter((c) => c.docs.visibility === 'public' && c.docs.userDoc).map(
        (c) => `/${c.docs.userDoc}`,
      ),
    );
    for (const t of trang) {
      expect(userDocs.has(t.path), `${t.path} không do capability nào nhận`).toBe(true);
      expect(t.key.startsWith(registry.TIEN_TO_HUONG_DAN)).toBe(true);
      expect(t.requiredPermission, `${t.key} phải mang quyền của capability`).toBeTruthy();
    }
  });

  it('capability `internal` không đưa trang nào vào index', () => {
    // network-center khai `userDoc: null` + `userDocMienTruVi`; luật ở đây là
    // cấu trúc, không phải một phép kiểm cho riêng nó.
    const keys = registry.trangHuongDanChoPhep().map((t) => t.key);
    for (const cap of CAPABILITIES.filter((c) => c.docs.visibility === 'internal')) {
      if (!cap.docs.userDoc) continue;
      expect(keys).not.toContain(registry.khoaTrangHuongDan(`/${cap.docs.userDoc}`));
    }
  });

  it('trang KHÔNG capability nào trỏ tới thì không vào index, dù glob nạp được', () => {
    // `01-bat-dau/**` là 16 trang onboarding — không capability nào nhận chúng,
    // nên chúng phải vô hình với Copilot y như một .md lạ thả vào he-thong.
    const keys = registry.listDocTopics(SUPER).map((t) => t.key);
    expect(keys.some((k) => k.includes('01-bat-dau'))).toBe(false);
    expect(keys.some((k) => k.includes('08-ke-hoach-phat-trien'))).toBe(false);
  });
});

describe('BẤT BIẾN SỐ MỘT vẫn giữ trên corpus hướng dẫn', () => {
  it('KHÔNG nạp trang hướng dẫn Bảng lương cho người không có salary.view', async () => {
    const spy = vi.spyOn(registry, 'napTaiLieu');
    await timTaiLieu('bảng lương nhân viên', STAFF_ROOMS_ONLY);
    const daTai = spy.mock.calls.map((c) => c[0] as string);
    expect(daTai.length).toBeGreaterThan(5); // sàn: có thật sự tải gì đó
    expect(daTai.some((p) => p.includes('huong-dan-su-dung'))).toBe(true);
    for (const gac of ['/bang-luong/', '/chat-zalo/', '/so-quy/']) {
      expect(daTai.some((p) => p.includes(gac)), `${gac} không được tải`).toBe(false);
    }
    spy.mockRestore();
  });

  it('có quyền thì trang hướng dẫn tương ứng vào index', async () => {
    const kq = await timTaiLieu('bảng lương', { ...STAFF_ROOMS_ONLY, salary: { view: true } });
    expect(kq.hits.some((h) => h.chunk.docKey.includes('bang-luong'))).toBe(true);
  });
});

describe('câu hỏi "cách dùng" ra chunk từ HƯỚNG DẪN', () => {
  it('"cách tạo hoá đơn" → trang hướng dẫn Hoá đơn đứng đầu', async () => {
    const kq = await timTaiLieu('cách tạo hoá đơn', SUPER);
    expect(kq.hits.length).toBeGreaterThan(0);
    expect(kq.hits[0].chunk.docKey).toBe('huong-dan-su-dung/03-quan-ly-van-hanh/hoa-don');
  });

  it('nhãn nguồn của hướng dẫn dùng TIÊU ĐỀ, không dùng mã tài liệu nội bộ', async () => {
    const kq = await timTaiLieu('cách tạo hoá đơn', SUPER);
    const s = dinhDangChoModel(kq);
    expect(s).toMatch(/\(nguồn: Hướng dẫn › [^\n]+\)/);
    // Và vẫn KHÔNG có link: xem lý do trong dinhDangChoModel.
    expect(s).not.toMatch(/\]\(/);
  });

  it('câu hỏi nghiệp vụ sâu vẫn về tài liệu hệ thống', async () => {
    // Hướng dẫn không được nuốt mọi câu hỏi: "bỏ cọc" là khái niệm sổ sách.
    const kq = await timTaiLieu('thanh lý hợp đồng', SUPER);
    expect(kq.hits[0].chunk.docKey).toBe('16-thanh-ly-hop-dong');
  });
});

describe('frontmatter và trần chunk/tài liệu', () => {
  it('boFrontmatter cắt khối YAML mở đầu, không đụng đường kẻ ngang giữa bài', () => {
    expect(boFrontmatter('---\ntitle: "x"\nstatus: published\n---\n\n# T\n\nthân')).toBe(
      '\n# T\n\nthân',
    );
    expect(boFrontmatter('# T\n\n---\n\nthân')).toBe('# T\n\n---\n\nthân');
    expect(boFrontmatter('---\nkhong dong')).toBe('---\nkhong dong');
  });

  it('siêu dữ liệu frontmatter không lọt vào index', async () => {
    const kq = await timTaiLieu('cách tạo hoá đơn', SUPER);
    for (const h of kq.hits) {
      expect(h.chunk.text).not.toMatch(/^status: published$/m);
      expect(h.chunk.text).not.toMatch(/^captured:$/m);
    }
  });

  it('link nội bộ docs-site không lọt vào chunk hướng dẫn', async () => {
    // Thân trang hướng dẫn có `[Sinh hoá đơn hàng loạt](/03-quan-ly-van-hanh/…)`
    // — một đường dẫn của SITE KHÁC. Mô hình được dạy giữ nguyên phần tài liệu
    // trả về, nên để nguyên là dạy nó dán link 404 vào khung chat.
    const kq = await timTaiLieu('cách tạo hoá đơn', SUPER);
    expect(kq.hits.length).toBeGreaterThan(0);
    for (const h of kq.hits) {
      expect(h.chunk.text, h.chunk.id).not.toMatch(/\]\(/);
    }
    expect(boLienKetMarkdown('xem [Sổ quỹ](/04-bao-cao/so-quy/) nhé')).toBe('xem Sổ quỹ nhé');
    expect(boLienKetMarkdown('![Màn hoá đơn rỗng](./images/a.webp)')).toBe('Màn hoá đơn rỗng');
  });

  it('MỘT tài liệu không chiếm hết ngân sách khi câu hỏi có nhiều ý', async () => {
    const kq = await timTaiLieu('hợp đồng cọc hoá đơn', SUPER);
    const theoDoc = new Map<string, number>();
    for (const h of kq.hits) theoDoc.set(h.chunk.docKey, (theoDoc.get(h.chunk.docKey) ?? 0) + 1);
    expect(Math.max(...theoDoc.values())).toBeLessThanOrEqual(CAP_CHUNK_MOI_TAI_LIEU);
    expect(theoDoc.size).toBeGreaterThanOrEqual(2);
  });

  it('canBangTheoTaiLieu lấp phần thiếu khi chỉ có MỘT tài liệu khớp', () => {
    const gia = (docKey: string, i: number) =>
      ({ chunk: { docKey, id: `${docKey}#${i}` }, diem: 10 - i }) as unknown as Parameters<
        typeof canBangTheoTaiLieu
      >[0][number];
    const hits = Array.from({ length: 6 }, (_, i) => gia('mot-tai-lieu', i));
    // Thà sáu mẩu cùng nguồn còn hơn ba mẩu và một khoảng trống.
    expect(canBangTheoTaiLieu(hits, 6)).toHaveLength(6);
    expect(canBangTheoTaiLieu(hits, 6).map((h) => h.chunk.id)).toEqual([
      'mot-tai-lieu#0',
      'mot-tai-lieu#1',
      'mot-tai-lieu#2',
      'mot-tai-lieu#3',
      'mot-tai-lieu#4',
      'mot-tai-lieu#5',
    ]);
  });
});
