// I5 — corpus hướng dẫn người dùng: cái gì được PHÂN PHỐI, không phải cái gì được TÌM.
//
// `docSearch.test.ts` đã canh allowlist ở tầng TÌM KIẾM (`trangHuongDanChoPhep`).
// File này canh tầng dưới nó một bậc, và là tầng duy nhất có răng với người chỉ
// tải bundle chứ không đăng nhập: `import.meta.glob` là chỉ thị BUILD, nên MỌI
// đường dẫn khớp đối số của nó đều bị Vite nhúng NỘI DUNG vào chunk JS công khai
// trên CDN. Phép lọc quyền chạy SAU đó, trên thứ đã phát đi rồi.
//
// Án lệ 03/09/2026: glob cũ là `/docs/huong-dan-su-dung/**/index.md` — khớp 104
// trang trong khi allowlist nhận 25. `05-cai-dat/admin-users`,
// `05-cai-dat/phan-quyen` và cả roadmap `08-ke-hoach-phat-trien/**` tải được
// bằng một lần mở DevTools, trong khi docs-site gác mật khẩu fail-closed.
//
// Không cần soi `dist/`: đối số glob là literal do máy sinh, nên khẳng định trên
// chính danh sách đó là khẳng định trên thứ Vite sẽ gom.
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@/app/capabilities/registry';
import { USER_DOC_MODULES } from '../tools/guideCorpus.generated';

/** Allowlist thật, suy trực tiếp từ CAPABILITIES — cùng luật `trangHuongDanChoPhep`. */
function allowlistTuCapabilities(): Set<string> {
  return new Set(
    CAPABILITIES.filter((c) => c.docs.visibility === 'public' && c.docs.userDoc).map(
      (c) => `/${String(c.docs.userDoc).replace(/^\/+/, '')}`,
    ),
  );
}

const khoa = Object.keys(USER_DOC_MODULES).sort();

describe('corpus hướng dẫn đưa vào bundle = allowlist CAPABILITIES', () => {
  it('sàn chống-xanh-rỗng: glob không được rỗng', () => {
    // Một glob rỗng cũng thoả mọi khẳng định "không lộ trang X" bên dưới, và
    // triệu chứng là Copilot lặng lẽ mất toàn bộ trí nhớ hướng dẫn.
    expect(khoa.length).toBeGreaterThanOrEqual(20);
  });

  it('mọi trang trong bundle đều nằm trong allowlist', () => {
    const choPhep = allowlistTuCapabilities();
    for (const k of khoa) {
      expect(choPhep.has(k), `${k} bị đưa vào bundle nhưng không capability public nào nhận`).toBe(true);
    }
  });

  it('mọi trang trong allowlist đều có trong bundle — không thiếu trang nào', () => {
    // Chiều ngược lại cũng phải đúng, nếu không generator có thể "sửa" một lỗi
    // lộ dữ liệu bằng cách đánh rơi trang, và không test nào kêu.
    for (const p of allowlistTuCapabilities()) {
      expect(khoa, `${p} do capability nhận nhưng không vào bundle`).toContain(p);
    }
  });

  it('KHÔNG trang quản trị / roadmap nào lọt vào bundle', () => {
    // Ba cái tên đích danh của án lệ I5, viết ra để một lần nới glob trở lại là
    // đỏ ngay ở đây chứ không đợi ai đó mở DevTools trên production.
    for (const cam of ['admin-users', 'phan-quyen', '08-ke-hoach-phat-trien', '01-bat-dau']) {
      expect(
        khoa.filter((k) => k.includes(cam)),
        `${cam} không được có mặt trong bundle`,
      ).toEqual([]);
    }
  });

  it('không đường dẫn nào còn ký tự đại diện', () => {
    // Khoá do Vite sinh từ đối số; một `*` sót lại nghĩa là đối số vẫn là mẫu
    // glob rộng chứ không phải danh sách literal.
    for (const k of khoa) expect(k).not.toMatch(/[*?]/);
    for (const k of khoa) expect(k.endsWith('/index.md')).toBe(true);
  });
});

// Đảo strict: file do máy sinh vẫn phải là mã strict.
//
// `check-new-modules-strict.mjs` so với `origin/main` bằng `git diff --diff-filter=A`,
// nên nó chỉ thấy file này ĐÚNG MỘT LẦN — ở nhánh khai sinh. Sau khi merge, ai gỡ
// dòng khai khỏi tsconfig thì không cửa nào kêu nữa. Hai cửa dưới đây khoá nốt
// khoảng đó: một cửa đọc tsconfig thật, một cửa chứng minh cửa kia biết đỏ.
describe('guideCorpus.generated.ts nằm trong đảo strict', () => {
  it('được khai trong tsconfig.strict-islands.json', async () => {
    const { kiemDaoStrict } = await import('../../../scripts/generate-copilot-guide-corpus.mjs');
    expect(kiemDaoStrict()).toBeNull();
  });

  it('cửa đó ĐỎ khi dòng khai bị gỡ — không phải cửa luôn xanh', async () => {
    const { kiemDaoStrict, FILE_SINH } = await import(
      '../../../scripts/generate-copilot-guide-corpus.mjs'
    );
    const thieu = kiemDaoStrict(() => JSON.stringify({ files: ['src/khac.ts'], include: [] }));
    expect(thieu).toContain(FILE_SINH);
    // Khai bằng `include` thay vì `files` vẫn phải được chấp nhận: đó là cách
    // thông báo lỗi của check-new-modules-strict bảo người ta làm.
    expect(kiemDaoStrict(() => JSON.stringify({ include: [FILE_SINH] }))).toBeNull();
  });
});
