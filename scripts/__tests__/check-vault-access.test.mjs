// Đột biến cho check-vault-access: gate phải bắt lời đọc vault thẳng, và không được
// đỏ vì câu thông báo hay chú thích nhắc tới vault.
//
// Mẫu vi phạm ghép từ TEN_VAULT lúc chạy để chính file test này không chứa chuỗi
// đường dẫn vault (gate quét cả scripts/__tests__).

import { describe, expect, it } from 'vitest';

import { MIEN_TRU, SAN_SO_FILE, chonFile, chuoiTrongDong, laDuongDanVault, timDocVault } from '../check-vault-access.mjs';
import { TEN_VAULT } from '../lib/vault.mjs';

const V = TEN_VAULT;
const bat = (ma) => timDocVault(ma).map((v) => v.chuoi);

describe('check-vault-access — bắt lời đọc thẳng', () => {
  it('ĐỘT BIẾN: các cách đọc cũ đều bị bắt', () => {
    const cacCach = [
      `const local = readFileSync(new URL('../${V}', import.meta.url), 'utf8');`,
      `const s = readFileSync(join(repoRoot, "${V}"), "utf8");`,
      `const localConfig = readFileSync("${V}", "utf8");`,
      'const p = `${repoRoot}/' + V + '`;',
      `const VAULT = 'C:/Users/Ten Nguoi/repo/${V}';`,
      `const w = resolve(repoRoot, "..", "..", "..", "${V}");`,
      `if (String(path).includes('${V}')) return fake;`,
    ];
    for (const ma of cacCach) expect(bat(ma), ma).toHaveLength(1);
  });

  it('báo đúng số dòng', () => {
    const ma = `import x from 'y';\n\nconst a = readFileSync(join(root, '${V}'));\n`;
    expect(timDocVault(ma)).toEqual([{ dong: 3, chuoi: V }]);
  });

  it('ĐỘT BIẾN: chuỗi glob có `/*` phía trước KHÔNG che được lời đọc ở dòng sau', () => {
    // Bỏ chú thích trên cả file sẽ coi `/*` trong glob là mở comment và nuốt tới `*/`.
    const ma = [
      `const files = glob('**/*.mjs');`,
      `const local = readFileSync(join(repoRoot, '${V}'), 'utf8');`,
      `/** kết thúc */`,
    ].join('\n');
    expect(bat(ma)).toEqual([V]);
  });
});

describe('check-vault-access — không báo nhầm', () => {
  it('câu thông báo nhắc tên vault không phải lời đọc', () => {
    const ma = [
      `console.error('Không tìm thấy PAT (env SUPABASE_PAT hoặc ${V})');`,
      `console.error("Missing Supabase PAT in ${V}");`,
      `throw new Error(\`Thiếu credential. Ghi vào vault ${V}.\`);`,
    ].join('\n');
    expect(bat(ma)).toEqual([]);
  });

  it('ĐỘT BIẾN: lời đọc nằm trong chú thích không được tính', () => {
    const ma = [
      `// readFileSync(new URL('../${V}', import.meta.url))`,
      ` * readFileSync(join(repoRoot, '${V}'))`,
      `/* readFileSync('${V}') */`,
    ].join('\n');
    expect(bat(ma)).toEqual([]);
  });

  it('quét chuỗi tuần tự: dấu đóng chuỗi trước không ghép với dấu mở chuỗi sau', () => {
    expect(chuoiTrongDong(`a('x', "y z") + 'w'`)).toEqual(['x', 'y z', 'w']);
    expect(chuoiTrongDong(`s = 'it\\'s'`)).toEqual([`it\\'s`]);
  });

  it('quy tắc nhận dạng đường dẫn', () => {
    expect(laDuongDanVault(V)).toBe(true);
    expect(laDuongDanVault(`../${V}`)).toBe(true);
    expect(laDuongDanVault(`C:\\Ten Nguoi\\${V}`)).toBe(true);
    expect(laDuongDanVault(`ghi vào ${V}`)).toBe(false);
    expect(laDuongDanVault(`${V}.`)).toBe(false);
  });
});

describe('check-vault-access — phạm vi', () => {
  it('chỉ helper được miễn; docs và file không phải mã nằm ngoài', () => {
    expect(MIEN_TRU).toEqual(['scripts/lib/vault.mjs', 'scripts/lib/vault.d.mts']);
    expect(chonFile([
      'scripts/lib/vault.mjs', 'scripts/a.mjs', '.e2e-fleet/specs/b.spec.ts', 'src/c.tsx',
      'docs/audits/x/y.cjs', 'README.md', 'tooling/z.json', 'scripts/d.cjs',
    ])).toEqual(['scripts/a.mjs', '.e2e-fleet/specs/b.spec.ts', 'src/c.tsx', 'scripts/d.cjs']);
  });

  it('sàn chống xanh rỗng đủ lớn để bắt bộ liệt kê hỏng', () => {
    expect(SAN_SO_FILE).toBeGreaterThanOrEqual(1000);
  });
});
