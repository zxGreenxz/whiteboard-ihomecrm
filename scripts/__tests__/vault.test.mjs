// Test cho scripts/lib/vault.mjs — cửa đọc vault duy nhất.
//
// Ca quan trọng nhất là ca WORKTREE: vault chỉ nằm ở checkout chính, và chính vì
// thiếu phép dò này mà ~56 script hỏng khi agent chạy trong git worktree. Giá trị
// giả được ghép lúc chạy để không có chuỗi giống secret nằm trong mã nguồn.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BIEN_TIEN_TRINH_CON,
  TEN_VAULT,
  credentialChoTienTrinhCon,
  docMatKhauPooler,
  docPatVault,
  docTaiKhoanTest,
  docVault,
  duongDanVault,
  giaTriVault,
  layMatKhauDb,
  layPat,
  quenVault,
  ungVienVault,
} from '../lib/vault.mjs';

const lap = (kyTu, n) => kyTu.repeat(n);
const PAT_GIA = 'sbp_' + lap('a', 40);
const PAT_KHAC = 'sbp_' + lap('b', 40);
const GH_GIA = 'ghp_' + lap('G', 36);
const VERCEL_GIA = 'vcp_' + lap('V', 30);
const MK_DB_GIA = 'mk' + lap('D', 12);

function vanBanVault() {
  return [
    '## Supabase Personal Access Token',
    PAT_GIA,
    '- Persistent database password (rotated, đã verify pooler login): `' + MK_DB_GIA + '`',
    '- Email: `' + 'tai-khoan@vi-du.test' + '`',
    '- Password: `' + 'mat' + '-khau-thu' + '`',
    'GH_TOKEN=' + GH_GIA,
    'VERCEL: ' + VERCEL_GIA,
    'TEST_SUPABASE_REF=' + lap('t', 20),
    '',
  ].join('\n');
}

const thuMucTam = [];
function taoThuMuc() {
  const d = mkdtempSync(join(tmpdir(), 'vault-test-'));
  thuMucTam.push(d);
  return d;
}
afterEach(() => {
  quenVault();
  for (const d of thuMucTam.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('vault — tìm file', () => {
  it('thứ tự ưu tiên: IHOMECRM_VAULT → IHOMECRM_SECRET_FILE → repo', () => {
    const repoRoot = taoThuMuc();
    const ds = ungVienVault({ env: { IHOMECRM_VAULT: 'a.md', IHOMECRM_SECRET_FILE: 'b.md' }, repoRoot });
    expect(ds.slice(0, 3)).toEqual([resolve('a.md'), resolve('b.md'), join(repoRoot, TEN_VAULT)]);
  });

  it('không có vault ở đâu cả ⇒ rỗng/null, không ném (đúng hành vi CI)', () => {
    const repoRoot = taoThuMuc();
    expect(duongDanVault({ env: {}, repoRoot })).toBeNull();
    expect(docVault({ env: {}, repoRoot })).toBe('');
    expect(layPat({ env: {}, repoRoot })).toBeNull();
    expect(layMatKhauDb({ env: {}, repoRoot })).toBeNull();
  });

  it('WORKTREE: không có vault riêng ⇒ đọc vault ở checkout chính', () => {
    const goc = taoThuMuc();
    const chinh = join(goc, 'chinh');
    mkdirSync(chinh);
    const git = (...args) => execFileSync('git', args, { cwd: chinh, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    git('-c', 'user.email=t@vi-du.test', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'goc');
    const wt = join(goc, 'wt');
    git('worktree', 'add', '-q', wt);
    writeFileSync(join(chinh, TEN_VAULT), vanBanVault());

    // Windows có thể trả tên ngắn 8.3 cho thư mục tạm ⇒ so phần đuôi, còn nội dung so tuyệt đối.
    expect(duongDanVault({ env: {}, repoRoot: wt })?.replaceAll('\\', '/')).toMatch(new RegExp(`/chinh/${TEN_VAULT.replaceAll('.', '\\.')}$`));
    expect(docPatVault({ env: {}, repoRoot: wt })).toBe(PAT_GIA);
  });

  it('IHOMECRM_VAULT thắng vault ở repo', () => {
    const repoRoot = taoThuMuc();
    writeFileSync(join(repoRoot, TEN_VAULT), vanBanVault());
    const rieng = join(taoThuMuc(), 'vault-rieng.md');
    writeFileSync(rieng, PAT_KHAC);
    expect(docPatVault({ env: { IHOMECRM_VAULT: rieng }, repoRoot })).toBe(PAT_KHAC);
    expect(docPatVault({ env: {}, repoRoot })).toBe(PAT_GIA);
  });

  it('readFile giả lập được (test của call site không phải ghi file thật)', () => {
    const repoRoot = taoThuMuc();
    const readFile = (p) => {
      if (String(p).endsWith(TEN_VAULT)) return vanBanVault();
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(docPatVault({ env: {}, repoRoot, readFile })).toBe(PAT_GIA);
  });
});

describe('vault — thứ tự env trước, vault sau', () => {
  const repoRoot = () => {
    const d = taoThuMuc();
    writeFileSync(join(d, TEN_VAULT), vanBanVault());
    return d;
  };

  it('PAT: SUPABASE_PAT → SUPABASE_ACCESS_TOKEN → vault', () => {
    const r = repoRoot();
    expect(layPat({ env: { SUPABASE_PAT: ' env-pat ' }, repoRoot: r })).toBe('env-pat');
    expect(layPat({ env: { SUPABASE_ACCESS_TOKEN: 'tok' }, repoRoot: r })).toBe('tok');
    expect(layPat({ env: {}, repoRoot: r })).toBe(PAT_GIA);
  });

  it('call site chỉ nhận SUPABASE_PAT thì bỏ qua SUPABASE_ACCESS_TOKEN', () => {
    const r = repoRoot();
    expect(layPat({ env: { SUPABASE_ACCESS_TOKEN: 'tok' }, bien: ['SUPABASE_PAT'], repoRoot: r })).toBe(PAT_GIA);
  });

  it('PAT trong vault phải đúng hình dạng của hợp đồng (40 hex)', () => {
    const d = taoThuMuc();
    writeFileSync(join(d, TEN_VAULT), 'TEST_SUPABASE_PAT=sbp_v0_' + lap('c', 40) + '\n');
    expect(docPatVault({ env: {}, repoRoot: d })).toBeNull();
  });

  it('mật khẩu pooler: env thắng, vault theo mẫu của hợp đồng', () => {
    const r = repoRoot();
    expect(layMatKhauDb({ env: { SUPABASE_DB_PASSWORD: 'tu-env' }, repoRoot: r })).toBe('tu-env');
    expect(layMatKhauDb({ env: {}, repoRoot: r })).toBe(MK_DB_GIA);
    expect(docMatKhauPooler('không có gì')).toBeNull();
  });

  it('tài khoản test và dòng KEY=VALUE', () => {
    const r = repoRoot();
    expect(docTaiKhoanTest({ env: {}, repoRoot: r })).toEqual({ email: 'tai-khoan@vi-du.test', password: 'mat-khau-thu' });
    expect(giaTriVault('TEST_SUPABASE_REF', { env: {}, repoRoot: r })).toBe(lap('t', 20));
    expect(giaTriVault('KHONG_CO', { env: {}, repoRoot: r })).toBeNull();
  });
});

describe('vault — credential cho tiến trình con (with-cred)', () => {
  it('chỉ thêm biến env chưa có; SUPABASE_ACCESS_TOKEN = PAT', () => {
    const r = taoThuMuc();
    writeFileSync(join(r, TEN_VAULT), vanBanVault());
    const { them, thieu } = credentialChoTienTrinhCon({ env: { GH_TOKEN: 'gh-cua-env' }, repoRoot: r });
    expect(them).toEqual({
      SUPABASE_PAT: PAT_GIA,
      SUPABASE_ACCESS_TOKEN: PAT_GIA,
      SUPABASE_DB_PASSWORD: MK_DB_GIA,
      VERCEL_TOKEN: VERCEL_GIA,
    });
    expect(thieu).toEqual([]);
  });

  it('PAT có sẵn trong env được dùng cho cả hai tên', () => {
    const r = taoThuMuc();
    const { them } = credentialChoTienTrinhCon({ env: { SUPABASE_PAT: 'env-pat' }, repoRoot: r });
    expect(them).toEqual({ SUPABASE_ACCESS_TOKEN: 'env-pat' });
  });

  it('thiếu hết ⇒ chỉ trả TÊN biến thiếu', () => {
    const r = taoThuMuc();
    const { them, thieu } = credentialChoTienTrinhCon({ env: {}, repoRoot: r });
    expect(them).toEqual({});
    expect(thieu).toEqual([...BIEN_TIEN_TRINH_CON]);
  });
});
