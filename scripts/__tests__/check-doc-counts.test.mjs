import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAIMS, demSqlTuDanhSach, demTrungVersionTuDanhSach, kiemTra } from '../check-doc-counts.mjs';

function withDocRepo(test) {
  const root = mkdtempSync(join(tmpdir(), 'doc-count-ownership-'));
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (script, ...args) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    for (const script of ['check-doc-counts.mjs', 'generate-repository-inventory.mjs', 'generate-docs-views.mjs', 'lib/git-scope.mjs']) {
      mkdirSync(dirname(join(root, 'scripts', script)), { recursive: true });
      copyFileSync(fileURLToPath(new URL(`../${script}`, import.meta.url)), join(root, 'scripts', script));
    }
    for (let i = 0; i < 200; i++) put(`tests/${i}.test.mjs`, 'export const ok = true;\n');
    for (let i = 0; i < 100; i++) put(`supabase/migrations/${i}.sql`, '-- fixture\n');
    put('supabase/README.md', '100 file hiện có\n');
    put('docs/DATABASE_SCHEMA.md', 'hiện có 100 file\n');
    put('docs/CODEBASE_STRUCTURE.md', '(100 file + 0 trong)\n`.e2e-fleet/**` | 0 spec\n`contracts/**` | 3 file\n`src/app/routes/**` (0 file theo domain)\nmột lệnh: 1 suite, mỗi suite một runner\n');
    put('tooling/test-matrix.json', JSON.stringify({ suites: [{}] }));
    put('supabase/migration-provenance.json', JSON.stringify({ entries: [] }));
    put('supabase/migration-policy.json', JSON.stringify(['0/0 file unknown là file CHỈ ALTER', '0 file unknown còn lại thì NGƯỢC LẠI', '0 version bị trùng (0 file)']));
    put('contracts/surfaces/rpc-surface.json', JSON.stringify({ rpcs: {}, generatedFrom: { catalogFunctions: 0, sourceCallSites: 0 }, missingOnServer: [] }));
    put('contracts/surfaces/edge-function-surface.json', JSON.stringify({ counts: { source: 0, deployed: 0 } }));
    put('contracts/surfaces/realtime-surface.json', JSON.stringify({ counts: { published: 0, listenedByHub: 0, replicaIdentityDefault: 0 } }));
    put('src/app/capabilities/registry.ts', 'export const capabilities = [];\n');
    git('add', '--', 'scripts', 'tests', 'supabase', 'docs', 'tooling', 'contracts', 'src');
    expect(run('generate-repository-inventory.mjs', '--write').status).toBe(0);
    const jsonPath = join(root, 'docs/generated/repository-inventory.json');
    const mdPath = join(root, 'docs/generated/repository-inventory.md');
    expect(run('generate-docs-views.mjs').status).toBe(0);
    git('add', '--', 'docs/generated/repository-inventory.json', 'docs/generated/repository-inventory.md');
    test({ root, put, git, run, jsonPath, mdPath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('CLI — JSON là nguồn inventory, MD chỉ do renderer ghi', () => {
  it('--fix không vá MD generated; chỉ render từ JSON phục hồi bản MD cũ', () => withDocRepo((repo) => {
    const original = readFileSync(repo.mdPath, 'utf8');
    const stale = original.replace('**200** file test', '**199** file test');
    writeFileSync(repo.mdPath, stale);
    expect(repo.run('check-doc-counts.mjs', '--fix').status).toBe(0);
    expect(readFileSync(repo.mdPath, 'utf8')).toBe(stale);
    expect(repo.run('generate-docs-views.mjs', '--check').status).toBe(1);
    expect(repo.run('generate-docs-views.mjs').status).toBe(0);
    expect(repo.run('generate-docs-views.mjs', '--check').status).toBe(0);
    expect(readFileSync(repo.mdPath, 'utf8')).toBe(original);
  }));

  it('JSON và MD cùng cũ vẫn đỏ; --fix không tạo vòng MD 200→201→200', () => withDocRepo((repo) => {
    const oldMd = readFileSync(repo.mdPath, 'utf8');
    repo.put('tests/added.test.mjs', 'export const added = true;\n');
    repo.git('add', '--', 'tests/added.test.mjs');
    const result = repo.run('check-doc-counts.mjs', '--fix');
    expect(result.status).toBe(1);
    expect(readFileSync(repo.mdPath, 'utf8')).toBe(oldMd);
    expect(repo.run('generate-repository-inventory.mjs', '--write').status).toBe(0);
    expect(repo.run('generate-docs-views.mjs', '--check').status).toBe(1);
    expect(repo.run('generate-docs-views.mjs').status).toBe(0);
    expect(repo.run('check-doc-counts.mjs').status).toBe(0);
    expect(repo.run('check-doc-counts.mjs', '--nguon-index').status).toBe(1);
    repo.git('add', '--', 'docs/generated/repository-inventory.json', 'docs/generated/repository-inventory.md');
    expect(repo.run('check-doc-counts.mjs', '--nguon-index').status).toBe(0);
  }));
});

// Gate này lấy TÀI LIỆU làm đích sửa (có --fix), nên nó sai là nó ghi số sai vào
// tài liệu. Bản đầu tôi viết đếm thiếu thư mục con và suýt "sửa" con số 15 đúng
// thành 1 — với loại gate biết ghi, đếm sai còn tệ hơn không đếm.

const claimGia = (re, that) => ({ re, dem: () => that, moTa: 'thử' });

describe('kiemTra', () => {
  it('khớp khi số trong tài liệu bằng số đếm được', () => {
    const r = kiemTra('Repository hiện có 627 file trong thư mục', claimGia(/(hiện có\s+)(\d+)(\s+file)/, 627));
    expect(r.trangThai).toBe('khop');
  });

  it('báo lệch kèm cả hai con số', () => {
    const r = kiemTra('Repository hiện có 625 file trong thư mục', claimGia(/(hiện có\s+)(\d+)(\s+file)/, 627));
    expect(r.trangThai).toBe('lech');
    expect(r.khai).toBe(625);
    expect(r.that).toBe(627);
  });

  it('báo MẤT NEO khi câu văn đổi — không được im lặng bỏ qua', () => {
    // Đây là chế độ hỏng nguy hiểm nhất: viết lại câu là gate ngừng kiểm mãi mãi
    // mà vẫn xanh. Phải phân biệt được với "khớp".
    const r = kiemTra('Repository có tất cả 627 tệp trong thư mục', claimGia(/(hiện có\s+)(\d+)(\s+file)/, 627));
    expect(r.trangThai).toBe('khong-tim-thay');
  });

  it('bắt đúng số ĐẦU TIÊN khớp mẫu, không bắt nhầm số khác trong câu', () => {
    const r = kiemTra('Có 33 nhóm trùng; hiện có 627 file trong repo', claimGia(/(hiện có\s+)(\d+)(\s+file)/, 627));
    expect(r.khai).toBe(627);
  });
});

describe('danh sách CLAIMS', () => {
  it('mỗi mục có đủ file, mẫu, cách đếm và mô tả', () => {
    expect(CLAIMS.length).toBeGreaterThan(0);
    for (const c of CLAIMS) {
      expect(typeof c.file, 'thiếu file').toBe('string');
      expect(c.re instanceof RegExp, `${c.file} thiếu regex`).toBe(true);
      expect(typeof c.dem, `${c.file} thiếu hàm đếm`).toBe('function');
      expect(typeof c.moTa, `${c.file} thiếu mô tả`).toBe('string');
    }
  });

  it('mọi mẫu đều có đúng 3 nhóm bắt để --fix ghép lại được', () => {
    // --fix thay bằng `$1<số>$3`, nên mẫu phải tách được phần trước / số / phần sau.
    // Mẫu thiếu nhóm sẽ làm --fix ghi ra câu văn hỏng.
    for (const c of CLAIMS) {
      const nguon = c.re.source;
      const soNhom = new RegExp(`${nguon}|`).exec('').length - 1;
      expect(soNhom, `${c.file}: mẫu có ${soNhom} nhóm, cần 3`).toBe(3);
    }
  });

  it('hàm đếm trả số nguyên không âm', () => {
    for (const c of CLAIMS) {
      const n = c.dem();
      expect(Number.isInteger(n), `${c.file}: đếm ra ${n}`).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('đếm từ danh sách INDEX — con số phải tái lập được từ commit (28/08/2026)', () => {
  // Bản cũ demSql/demTrungVersion quét ĐĨA: một file .sql untracked của phiên
  // song song làm --fix ghi 709 vào docs trong khi CI (đọc cây commit) chỉ thấy
  // 707 → đỏ. Đã xảy ra thật, chữa tay ở c9f3937f; đây là bản mã hoá.
  const danhSach = [
    'supabase/migrations/20260101000000_a.sql',
    'supabase/migrations/20260101000000_b.sql',
    'supabase/migrations/20260102000000_c.SQL',
    'supabase/migrations/nhom/20260103000000_con.sql',
    'supabase/migrations-archive/20200101000000_cu.sql',
    'supabase/migrations/ghi-chu.md',
  ];

  it('demSqlTuDanhSach đếm đệ quy, không phân biệt hoa thường, đúng thư mục', () => {
    expect(demSqlTuDanhSach(danhSach, 'supabase/migrations')).toBe(4);
    expect(demSqlTuDanhSach(danhSach, 'supabase/migrations-archive')).toBe(1);
  });

  it('demSqlTuDanhSach không lẫn thư mục có tên là tiền tố của nhau', () => {
    // 'supabase/migrations-archive/...' KHÔNG được tính vào 'supabase/migrations'.
    expect(demSqlTuDanhSach(['supabase/migrations-archive/x.sql'], 'supabase/migrations')).toBe(0);
  });

  it('demTrungVersionTuDanhSach chỉ xét file ngay trong supabase/migrations, nhóm theo version', () => {
    const kq = demTrungVersionTuDanhSach(danhSach);
    expect(kq.soNhom).toBe(1);
    expect(kq.soFile).toBe(2);
  });
});
