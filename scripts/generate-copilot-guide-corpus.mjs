#!/usr/bin/env node
// Sinh `src/copilot/tools/guideCorpus.generated.ts` — ĐƯỜNG NẠP corpus hướng dẫn
// người dùng, ghim đúng allowlist suy từ `CAPABILITIES`.
//
// VÌ SAO CẦN (án lệ I5, review toàn nhánh G1 — 03/09/2026)
//   registry.ts nạp corpus bằng `import.meta.glob('/docs/huong-dan-su-dung/**/index.md')`.
//   Glob là chỉ thị BUILD, không phải phép lọc runtime: Vite gom NỘI DUNG của mọi
//   file khớp vào chunk JS và chunk đó nằm trên CDN, tải được KHÔNG cần đăng nhập.
//   Đo 03/09/2026: 104 file khớp glob, allowlist chỉ nhận 25. 79 trang còn lại —
//   trong đó `05-cai-dat/admin-users`, `05-cai-dat/phan-quyen` và toàn bộ
//   `08-ke-hoach-phat-trien/**` (roadmap nội bộ) — được PHÂN PHỐI cho mọi người,
//   trong khi docs-site vốn gác mật khẩu fail-closed (docs-site/middleware.ts).
//
//   `trangHuongDanChoPhep()` chặn TÌM, không chặn PHÂN PHỐI: nó lọc thứ đã nằm
//   sẵn trong bundle. Hàng rào duy nhất chặn phân phối là chính ĐỐI SỐ của glob.
//
// VÌ SAO PHẢI SINH RA, KHÔNG VIẾT TAY
//   Vite phân tích glob TĨNH — đối số bắt buộc là literal, không nhận biến. Nên
//   danh sách phải nằm nguyên văn trong mã. Một danh sách literal viết tay là
//   nguồn sự thật thứ hai cạnh `CAPABILITIES`, và hai nguồn thì bản nào lệch
//   cũng hỏng theo kiểu không ai thấy — đúng thứ file này tồn tại để chặn:
//   máy sinh, `--check` canh, người không gõ.
//
//   node scripts/generate-copilot-guide-corpus.mjs [--write]
//   node scripts/generate-copilot-guide-corpus.mjs --check   # đỏ nếu bản .ts đã trôi
//
// Không cần credential, không đọc database (chỉ đọc `src/` qua vite-node).
// Thoát 0 · 1 (trôi ở chế độ --check) · 3 (KHÔNG ĐO ĐƯỢC — đừng đọc thành "sạch").

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** File .ts do máy sở hữu; `soHuu` trong kiem-nhanh-truoc-push.mjs trỏ vào đây. */
export const FILE_SINH = 'src/copilot/tools/guideCorpus.generated.ts';

/** Thư mục DUY NHẤT corpus này được lấy từ đó. */
export const THU_MUC_HUONG_DAN = 'docs/huong-dan-su-dung/';

/**
 * SÀN CHỐNG-XANH-RỖNG.
 *
 * Một allowlist rỗng trông y hệt một allowlist "đã lọc rất kỹ": glob rỗng ⇒
 * bundle sạch ⇒ gate xanh ⇒ Copilot lặng lẽ mất toàn bộ trí nhớ hướng dẫn. Ngưỡng
 * 20 đặt dưới con số thật (25 ngày 03/09/2026) đủ để một capability bị gỡ không
 * làm đỏ oan, nhưng chặn được trường hợp bộ nạp hỏng trả về danh sách cụt.
 */
export const SAN_TOI_THIEU = 20;

/**
 * Đọc `CAPABILITIES` bằng vite-node — KHÔNG regex trên nguồn TS.
 *
 * Cùng cách `check-copilot-page-contracts.mjs` làm, và vì cùng một lý do: allowlist
 * là giá trị sau khi module chạy (`visibility` có thể đến từ hằng, từ cờ build),
 * còn regex chỉ thấy chữ. File nạp tạm nằm TRONG repo này — `node_modules` ở
 * worktree thường là junction sang checkout khác, phân giải tương đối mà đi ra
 * ngoài cây là đọc nhầm cây.
 */
export function docUserDocTuCapabilities(goc = repoRoot) {
  const tmp = join(goc, '.tmp-copilot-loaders', '__copilot_guide_corpus.mts');
  const source = [
    "import { CAPABILITIES } from '../src/app/capabilities/registry';",
    'const ra = CAPABILITIES',
    "  .filter((c) => c.docs.visibility === 'public' && c.docs.userDoc)",
    '  .map((c) => String(c.docs.userDoc));',
    'console.log(JSON.stringify(ra));',
  ].join('\n');
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, source, 'utf8');
  try {
    const kq = spawnSync('npx', ['vite-node', '.tmp-copilot-loaders/__copilot_guide_corpus.mts'], {
      cwd: goc, encoding: 'utf8', shell: true, timeout: 180_000,
    });
    const dong = String(kq.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
    if (!dong) {
      console.error('❌ KHÔNG ĐO ĐƯỢC: vite-node không in ra allowlist.');
      console.error(String(kq.stderr ?? '').trim().slice(0, 2000));
      return null;
    }
    return JSON.parse(dong);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Chuẩn hoá + kiểm tra danh sách thô thành các đường dẫn glob (`/docs/...`).
 *
 * Trả `{ duongDan, loi }`. Mọi bất thường vào `loi` chứ không bị bỏ qua: một
 * `userDoc` trỏ ra ngoài thư mục hướng dẫn, hay trỏ tới file không còn tồn tại,
 * là lỗi dữ liệu — và biến lỗi dữ liệu thành "im lặng bớt một trang" là kiểu hỏng
 * khó thấy nhất (án lệ `dauReviewConHieuLuc` trong registry.ts).
 */
export function chuanHoaDuongDan(tho, coFile = (p) => existsSync(join(repoRoot, p))) {
  const loi = [];
  const duongDan = [];
  for (const raw of tho ?? []) {
    const rel = String(raw).replace(/^\/+/, '');
    if (!rel.startsWith(THU_MUC_HUONG_DAN)) {
      loi.push(`\`${raw}\` không nằm trong ${THU_MUC_HUONG_DAN}`);
      continue;
    }
    if (!rel.endsWith('/index.md')) {
      loi.push(`\`${raw}\` không kết thúc bằng /index.md`);
      continue;
    }
    if (!coFile(rel)) {
      loi.push(`\`${raw}\` được capability khai nhưng file không còn trên đĩa`);
      continue;
    }
    duongDan.push(`/${rel}`);
  }
  // Hai capability trỏ chung một trang là chuyện có thể xảy ra; glob không được
  // liệt kê nó hai lần. Sắp xếp để bản sinh ổn định giữa hai lượt chạy.
  return { duongDan: [...new Set(duongDan)].sort(), loi };
}

/** Nội dung file .ts sinh ra. Luôn LF — `--check` chuẩn hoá CRLF trước khi so. */
export function dungNguon(duongDan) {
  return [
    '// SINH TỰ ĐỘNG — ĐỪNG SỬA TAY.',
    '//   node scripts/generate-copilot-guide-corpus.mjs',
    '//   node scripts/generate-copilot-guide-corpus.mjs --check   (gate CI)',
    '//',
    '// Danh sách dưới đây là ALLOWLIST `CAPABILITIES` (docs.visibility === "public"',
    '// && docs.userDoc) viết thành literal, vì `import.meta.glob` phân tích TĨNH và',
    '// không nhận biến. Sửa tay ở đây là tạo nguồn sự thật thứ hai — sửa ở',
    '// `src/app/capabilities/registry.ts` rồi chạy lại generator.',
    '//',
    '// VÌ SAO KHÔNG DÙNG `**` NỮA: glob là chỉ thị BUILD. `/docs/huong-dan-su-dung/**/index.md`',
    '// gom NỘI DUNG cả 104 trang vào chunk JS công khai trên CDN — kể cả',
    '// `05-cai-dat/admin-users`, `05-cai-dat/phan-quyen` và roadmap',
    '// `08-ke-hoach-phat-trien/**` — trong khi docs-site gác mật khẩu fail-closed.',
    '// Allowlist ở `trangHuongDanChoPhep()` chỉ chặn TÌM; chặn PHÂN PHỐI là việc của',
    '// chính đối số này.',
    '',
    '/** Trang hướng dẫn người dùng được PHÉP đưa vào bundle. Khoá = đường dẫn glob. */',
    'export const USER_DOC_MODULES = import.meta.glob(',
    '  [',
    ...duongDan.map((p) => `    '${p}',`),
    '  ],',
    "  { query: '?raw', import: 'default' },",
    ') as Record<string, () => Promise<string>>;',
    '',
  ].join('\n');
}

/** Bỏ CRLF trước khi so — checkout Windows tái tạo file theo `core.autocrlf`. */
const chuanHoa = (s) => String(s).replace(/\r\n/g, '\n');

/** tsconfig của đảo strict — nơi FILE_SINH bắt buộc phải được khai. */
export const TSCONFIG_DAO_STRICT = 'tsconfig.strict-islands.json';

/**
 * File sinh ra PHẢI nằm trong đảo strict, và cửa này canh điều đó.
 *
 * Vì sao không để `check-new-modules-strict.mjs` lo một mình: cửa đó so với
 * `origin/main` bằng `git diff --diff-filter=A`, nên nó chỉ thấy file này ĐÚNG
 * MỘT LẦN — ở nhánh khai sinh ra nó. Sau khi merge, file không còn "mới" nữa;
 * lúc đó ai gỡ dòng khai khỏi tsconfig thì không cửa nào kêu, và một file do máy
 * sinh sẽ lặng lẽ tuột khỏi `strict` mãi mãi.
 *
 * Đặt phép kiểm ở CHÍNH generator vì generator là thứ duy nhất luôn chạy cùng
 * file này: mọi lần `--write` và mọi lần `--check` trên CI đều đi qua đây.
 *
 * Trả `null` khi đạt, hoặc câu giải thích khi hỏng.
 */
export function kiemDaoStrict(
  doc = () => readFileSync(join(repoRoot, TSCONFIG_DAO_STRICT), 'utf8'),
) {
  let cauHinh;
  try {
    cauHinh = JSON.parse(doc());
  } catch (e) {
    return `không đọc/parse được ${TSCONFIG_DAO_STRICT}: ${e instanceof Error ? e.message : e}`;
  }
  // Đảo khai bằng `files`; `include` để rỗng. Đọc cả hai để một lần đổi cách
  // khai không biến cửa này thành cửa luôn-xanh.
  const khai = [
    ...(Array.isArray(cauHinh.files) ? cauHinh.files : []),
    ...(Array.isArray(cauHinh.include) ? cauHinh.include : []),
  ];
  return khai.includes(FILE_SINH)
    ? null
    : `${FILE_SINH} không được khai trong ${TSCONFIG_DAO_STRICT} (files/include) — ` +
      'thêm dòng đó rồi chạy `npx tsc -p tsconfig.strict-islands.json --noEmit`.';
}

export function main(argv = process.argv.slice(2)) {
  const kiem = argv.includes('--check');

  const tho = docUserDocTuCapabilities();
  if (!Array.isArray(tho)) { process.exit(3); }

  const { duongDan, loi } = chuanHoaDuongDan(tho);
  if (loi.length > 0) {
    console.error('❌ Allowlist hướng dẫn có mục không dùng được:');
    for (const l of loi) console.error(`  - ${l}`);
    console.error('   Sửa `docs.userDoc` trong src/app/capabilities/registry.ts.');
    process.exit(3);
  }
  if (duongDan.length < SAN_TOI_THIEU) {
    console.error(
      `❌ KHÔNG ĐO ĐƯỢC: chỉ suy ra ${duongDan.length} trang hướng dẫn (sàn ${SAN_TOI_THIEU}) — ` +
      'bộ nạp hỏng, đừng đọc thành "allowlist đã lọc rất kỹ".',
    );
    process.exit(3);
  }

  const noiDung = dungNguon(duongDan);
  const dich = join(repoRoot, FILE_SINH);

  // Chạy ở CẢ HAI chế độ: `--write` để người sinh biết ngay, `--check` để CI đỏ.
  const loiDao = kiemDaoStrict();
  if (loiDao) {
    console.error(`❌ ${loiDao}`);
    process.exit(1);
  }

  if (kiem) {
    const cu = existsSync(dich) ? readFileSync(dich, 'utf8') : '';
    if (chuanHoa(cu) !== chuanHoa(noiDung)) {
      console.error(`❌ ${FILE_SINH} đã trôi khỏi CAPABILITIES (${duongDan.length} trang).`);
      console.error('   Sinh lại: node scripts/generate-copilot-guide-corpus.mjs');
      process.exit(1);
    }
    console.log(`✅ ${FILE_SINH} khớp allowlist CAPABILITIES: ${duongDan.length} trang hướng dẫn.`);
    return;
  }

  mkdirSync(dirname(dich), { recursive: true });
  writeFileSync(dich, noiDung);
  console.log(`✅ ${FILE_SINH}: ${duongDan.length} trang hướng dẫn.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
