#!/usr/bin/env node
// Gate: ba file rule của agent không được mâu thuẫn nhau, và không được tái xuất
// hiện các chỉ dẫn đã từng gây hỏng thật.
//
// Vì sao cần: repo có CLAUDE.md, AGENTS.md và AI_RULES.md cùng nói về một hệ
// thống. Mỗi lần chúng lệch nhau là một lần agent làm sai theo hướng dẫn CHÍNH
// THỨC. Hai ca đã xảy ra:
//   - AGENTS.md dạy `npm run gen:types > types.ts`. Shell cắt trắng file trước
//     khi generator chạy; generator lỗi thì types.ts chỉ còn một dòng banner.
//     CI đã biết và ghi rõ cách đúng, nhưng file rule thì không ai sửa.
//   - CLAUDE.md coi "chưa push main = việc chưa xong" trong khi main deploy
//     thẳng production, biến mọi commit thành một lần phát hành.
//
//   node scripts/check-agent-contract.mjs
//
// Không cần credential, không đọc database.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = 'docs/engineering/PROJECT_CONTRACT.md';
const AGENT_FILES = ['CLAUDE.md', 'AGENTS.md', 'AI_RULES.md'];

// Mỗi mục là một chỉ dẫn ĐÃ gây hỏng thật, kèm lý do để người đọc lỗi hiểu ngay
// vì sao nó bị cấm chứ không phải "vì gate nói thế".
// Pattern viết dạng KHÔNG DẤU và so trên bản đã bỏ dấu: repo này viết tiếng
// Việt lẫn lộn có dấu / không dấu, một regex có dấu sẽ bỏ lọt ngay khi ai đó gõ
// nhanh. Ca đó đã bị bắt bằng đột biến trước khi sửa.
const FORBIDDEN = [
  {
    id: 'gen-types-redirect',
    // Cờ có thể nằm GIỮA lệnh và dấu redirect (`gen:types --silent > file`), và
    // redirect có thể ghi số fd (`1>`). Bản đầu dùng /gen:types\s*>/ nên cả hai
    // cách viết đi thẳng qua — cùng lớp lỗi "chỉ phủ một biến thể". Bắt cả dạng
    // CLI thô (`supabase gen types typescript … > types.ts`) vì hậu quả y hệt.
    // `>>` (append) KHÔNG cắt file nên cố ý loại trừ.
    // `(?<!>)` là BẮT BUỘC, không thừa: chỉ có `(?!>)` thì backtracking vô hiệu
    // hoá nó — engine lùi lại, nuốt dấu `>` thứ nhất vào phần lazy `[^\n]{0,120}?`
    // rồi khớp dấu thứ hai, nên `>>` (append, KHÔNG cắt file) vẫn bị báo nhầm.
    // Test "append `>>` không bị cấm" bắt được đúng chỗ này.
    re: /(gen:types|gen\s+types\s+typescript)[^\n]{0,120}?(?<!>)[012]?>(?!>)/,
    why: 'Redirect cắt trắng types.ts TRƯỚC khi generator chạy. Dùng `npm run gen:types` (script tự ghi atomic + tự chèn header).',
  },
  {
    id: 'push-equals-done',
    // `[^\n]{0,24}` cho phép chữ chen giữa ("chưa push LÊN MAIN = việc chưa xong").
    re: /chua push[^\n]{0,24}=\s*(viec\s*)?chua xong/i,
    why: '`main` không phải production. Phát hành là bước promote riêng sau khi gate xanh (PROJECT_CONTRACT §3).',
  },
  {
    id: 'git-add-all',
    // KHÔNG neo `$`: "Stage nhanh bằng `git add -A` rồi commit." có chữ phía sau
    // nên bản đầu trượt sạch. Thêm `--all`. Ranh giới cuối là ký tự KHÔNG PHẢI
    // phần của đường dẫn, nên `git add ./src/x.ts` (stage file cụ thể) không bị
    // báo nhầm, còn `git add .` thì bị.
    re: /git add\s+(-A|--all|\.)(?![\w/\\.-])/i,
    why: 'Cây làm việc repo này thường có file dở dang từ phiên khác; phải stage tên file cụ thể.',
  },
];

const deaccent = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');

/**
 * Từ báo hiệu dòng đang CẢNH BÁO về chỉ dẫn xấu chứ không ra lệnh làm nó.
 * So trên bản đã bỏ dấu nên "KHÔNG" và "khong" cùng khớp.
 */
const CANH_BAO = /(khong|dung(?=\s)|cam\b|tuyet doi|gotcha|footgun|pha file|thay bang|sai|loi|⚠|❌)/i;

/**
 * Một dòng chỉ được coi là CẢNH BÁO khi từ phủ định đứng TRƯỚC chỗ vi phạm.
 *
 * Bản đầu vứt bỏ NGUYÊN DÒNG bất kỳ dòng nào chứa các từ đó, với cờ /i. Tiếng
 * Việt dùng chữ "không" liên tục, nên chỉ cần một chữ "không" ở BẤT KỲ đâu trên
 * dòng là cả dòng tàng hình. Đo 07/08/2026:
 *
 *   Chạy `npm run gen:types > …/types.ts`                        ⇒ ĐỎ (đúng)
 *   Chạy `npm run gen:types > …/types.ts` (không cần cờ gì thêm)  ⇒ XANH
 *
 * Cùng một lệnh phá file, chỉ khác cái đuôi câu vô hại. Xét VỊ TRÍ thì câu cảnh
 * báo thật ("ĐỪNG chạy gen:types > file") vẫn được tha, còn câu ra lệnh kèm chữ
 * "không" ở cuối thì không thoát.
 */
/**
 * Ngoại lệ KHAI TƯỜNG MINH, ghim vào nguyên văn dòng.
 *
 * Hai dòng này là văn KỂ LẠI sự cố, không phải chỉ dẫn: chúng nêu đúng cái lệnh
 * đã phá file để giải thích vì sao nó bị cấm. Từ cảnh báo nằm ở vế sau câu nên
 * phép xét-vị-trí không tha được, và nới cửa sổ ra các dòng lân cận thì lại che
 * mất chính ca nguy hiểm (lệnh ra lệnh kèm chữ "không" ở cuối câu) — đánh đổi
 * sai chiều, vì ở đây BỎ LỌT đắt hơn BÁO THỪA rất nhiều.
 *
 * Ghim theo nguyên văn: sửa câu thì ngoại lệ hết hiệu lực và phải xét lại. Cùng
 * nguyên tắc với PUBLIC_ROUTES — ngoại lệ được KHAI thì đọc được và cãi được.
 */
const MIEN_TRU = new Map([
  [
    'CLAUDE.md::chay `npm run gen:types` kem dau redirect `>` do vao `types.ts` — cach viet ma shell cat trang file',
    'Văn kể lại chính sự cố AGENTS.md dạy sai suốt nhiều tháng.',
  ],
  [
    'AGENTS.md::- No day chay `npm run gen:types` kem dau redirect `>` do vao `types.ts` — suot nhieu thang. Shell',
    'Văn kể lại chính sự cố đó, ở phía AGENTS.md.',
  ],
]);

/**
 * Mục có tiêu đề mang nghĩa phủ định là một KHỐI cảnh báo.
 *
 * `PROJECT_CONTRACT.md §11 "Những gì agent KHÔNG được tự làm"` liệt kê 5 điều
 * cấm, mỗi điều một dòng — và các dòng đó KHÔNG tự chứa từ phủ định vì phủ định
 * đã nằm ở tiêu đề. Xét theo dòng thì cả mục biến thành 5 vi phạm.
 */
function tieuDePhuDinh(cacDong, chiSo) {
  for (let i = chiSo; i >= 0; i -= 1) {
    const m = /^#{1,6}\s+(.*)$/.exec(cacDong[i]);
    if (m) return CANH_BAO.test(deaccent(m[1]));
  }
  return false;
}

export function findForbidden(text, file) {
  const ra = [];
  const cacDong = text.split(/\r?\n/);
  for (const { id, re, why } of FORBIDDEN) {
    for (let i = 0; i < cacDong.length; i += 1) {
      const dong = deaccent(cacDong[i]);
      const m = re.exec(dong);
      if (!m) continue;
      if (CANH_BAO.test(dong.slice(0, m.index))) continue; // "ĐỪNG chạy X"
      if (tieuDePhuDinh(cacDong, i)) continue; // nằm trong mục "KHÔNG được…"
      if (MIEN_TRU.has(`${file}::${dong.trim()}`)) continue;
      ra.push({ file, id, why, dong: cacDong[i].trim(), soDong: i + 1 });
      break;
    }
  }
  return ra;
}

function main() {
  const problems = [];
  const read = (f) => {
    try { return readFileSync(join(repoRoot, f), 'utf8'); } catch { return null; }
  };

  const contract = read(CONTRACT);
  if (contract === null) {
    console.error(`❌ Thiếu ${CONTRACT} — đây là nguồn luật chung, mọi file rule phải trỏ về nó.`);
    process.exitCode = 1;
    return;
  }

  // Soi CẢ Contract. Bản đầu chỉ chạy FORBIDDEN trên AGENT_FILES, nên viết
  // thẳng một chỉ dẫn đã cấm vào chính nguồn luật thì gate im — mà cả ba file
  // rule đều trỏ về đó, tức đường lan rộng nhất lại là đường duy nhất không ai
  // canh. Đo 07/08/2026: thêm "Chưa push = việc chưa xong." vào
  // PROJECT_CONTRACT.md ⇒ gate vẫn xanh.
  problems.push(...findForbidden(contract, CONTRACT));

  for (const file of AGENT_FILES) {
    const text = read(file);
    if (text === null) continue; // file có thể đã được rút gọn/xoá có chủ đích

    problems.push(...findForbidden(text, file));

    if (!text.includes('PROJECT_CONTRACT.md')) {
      problems.push({
        file,
        id: 'missing-contract-pointer',
        why: `Không trỏ về ${CONTRACT}. Ba file rule phải cùng một nguồn luật, nếu không chúng sẽ lệch nhau lần nữa.`,
      });
    }
  }

  // Contract phải giữ được các invariant đắt nhất — nếu ai đó rút gọn nó quá
  // tay thì tri thức rơi mất mà không ai thấy.
  // Danh sách này là ĐIỀU KIỆN để rút ba file rule thành adapter mỏng: mỗi mục
  // là một tri thức đã trả giá để có. Nếu ai đó rút gọn Contract quá tay, gate
  // này là thứ duy nhất phát hiện — vì tri thức mất đi không làm test nào đỏ.
  // 13 mục cuối thêm 06/08/2026, ngay trước khi rút CLAUDE.md (211 dòng) và
  // AGENTS.md (146 dòng) thành adapter. Danh sách 16 mục ban đầu KHÔNG đủ: khi
  // đối chiếu từng chi tiết vận hành trong hai file sắp cắt với Contract, có
  // `deno.lock` chưa được nhắc ở đâu cả — tức là nếu cắt trước rồi kiểm sau thì
  // tri thức đó biến mất không dấu vết, và không gì đỏ lên.
  const MUST_MENTION = [
    ['ts-baseline.json', 'ratchet TypeScript theo fingerprint'],
    ['tsconfig.app.json', 'typecheck THẬT — root `tsc --noEmit` không check gì'],
    ['check-view-invoker', 'gate view security_invoker'],
    ['security_invoker', 'CREATE OR REPLACE VIEW làm rớt cờ này'],
    ['check-stable-fn-locks', 'gate hàm STABLE lấy khoá dòng'],
    ['25006', 'mã lỗi khi hàm STABLE lấy khoá dòng qua PostgREST'],
    ['VOLATILE', 'hàm lấy khoá dòng phải khai VOLATILE'],
    ['reconcile-money', 'đối chiếu tiền'],
    ['cap-1000', 'bug tổng chỉ 1000 dòng đầu'],
    ['CLAUDE.local.md', 'credential vault'],
    ['promotion token', 'ghi database production cần token nhập tại chỗ'],
    // Bán kính ảnh hưởng (plan §16). Ghim vì đây là danh sách DỄ RƠI nhất trong
    // Contract: nó không gắn với một script nào, không có gì đỏ khi mất, và bảy
    // mục của nó chính là bảy chỗ mà một thay đổi lan ra ngoài file đang mở.
    ['bán kính ảnh hưởng', 'phải hỏi graph trước khi sửa'],
    ['detect_changes', 'đối chiếu thứ thực sự đổi với thứ định đổi'],
    ['.mcp.json', 'GitNexus đăng ký MCP theo dự án, không theo máy'],
    ['hide_sandbox_admin', 'policy chặn org TEST lọt vào org thật'],
    ['can_access_building', 'cách lọc toà đúng trong hàm SECURITY DEFINER'],
    ['aaaa0000', 'org THẬT — chỉ đọc khi test'],
    ['dddd0000', 'org DEMO — nơi duy nhất được ghi khi test'],
    ['cccc0000', 'org TEST — bản sao dữ liệu thật'],
    ['clone-org', 'đồng bộ lại org TEST'],
    ['0/158', 'cửa chặn rò rỉ sandbox'],
    ['deadlock', 'await supabase.* trong callback auth gây treo im lặng'],
    ['FLEET_PASS', 'mật khẩu E2E không nằm trong repo'],
    ['headless', 'E2E mặc định chạy ẩn'],
    ['2.9.4', 'phiên bản Deno đã xác minh'],
    ['deno.lock', 'khoá version npm specifier của edge function'],
    ['gen:types', 'quy trình regen types (không redirect)'],
    ['types:normalize', 'bỏ partition ngày sau khi regen'],
    ['HEAD:main', 'push đúng nhánh, tránh đẩy nhánh main local cũ'],
    ['git add -A', 'điều bị cấm khi stage'],
    ['backup-before-schema', 'PITR tắt nên phải dump trước thao tác schema'],
    ['migration-policy.json', 'cutoff và luật forward-only'],
  ];
  for (const [needle, what] of MUST_MENTION) {
    if (!contract.includes(needle)) {
      problems.push({ file: CONTRACT, id: 'contract-lost-invariant', why: `Mất phần "${what}" (không còn nhắc \`${needle}\`).` });
    }
  }

  if (problems.length > 0) {
    console.error('❌ Hợp đồng agent có vấn đề:\n');
    for (const p of problems) console.error(`  - ${p.file} [${p.id}]\n      ${p.why}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✅ ${AGENT_FILES.length} file rule cùng trỏ về ${CONTRACT}; không có chỉ dẫn nguy hiểm tái xuất hiện.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
