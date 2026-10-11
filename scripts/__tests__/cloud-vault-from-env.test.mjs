// Test cho scripts/cloud-vault-from-env.mjs — vault phiên cloud ghép từ env.
//
// Ca quan trọng: vault sinh ra phải đọc được bằng CHÍNH các mẫu của hợp đồng và các
// hàm của scripts/lib/vault.mjs, nếu không script chỉ đọc vault vẫn báo thiếu khóa.
// Giá trị giả được ghép lúc chạy để không có chuỗi giống secret nằm trong mã nguồn.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DANH_DAU, dungVault, duongDanDich, ghiVault } from '../cloud-vault-from-env.mjs';
import { docMatKhauPooler, docTaiKhoanTest, giaTriVault, layPat, quenVault } from '../lib/vault.mjs';

const lap = (kyTu, n) => kyTu.repeat(n);
const HOP_DONG = JSON.parse(
  readFileSync(new URL('../../tooling/local-credential-contract.json', import.meta.url), 'utf8'),
);

function envDayDu() {
  return {
    SUPABASE_PAT: 'sbp_' + lap('a', 40),
    SUPABASE_DB_PASSWORD: 'mk' + lap('D', 12),
    TEST_ACCOUNT_EMAIL: 'tai-khoan@vi-du.test',
    TEST_ACCOUNT_PASSWORD: 'mat' + '-khau-thu',
    TEST_SUPABASE_DB_PASSWORD: 'tmk' + lap('x', 8),
    TEST_ENV_PASSWORD_SEED: 'seed' + lap('s', 8),
    TEST_PASS: 'a@vi-du.test mk1; b@vi-du.test mk2',
    GOONG_API_KEY: 'goong' + lap('g', 8),
    FLEET_PASS_CHUNHA: 'f1', FLEET_PASS_KETOAN: 'f2', FLEET_PASS_QUANLY: 'f3',
    FLEET_PASS_SALE: 'f4', FLEET_PASS_KYTHUAT: 'f5', FLEET_PASS_CODONG: 'f6',
    FLEET_PASS_QUANLY2: 'f7',
    VERCEL_TOKEN: 'vcp_' + lap('V', 30),
    GH_TOKEN: 'ghp_' + lap('G', 36),
    TEST_SUPABASE_REF: lap('t', 20),
  };
}

const thuMucTam = [];
function taoThuMuc() {
  const d = mkdtempSync(join(tmpdir(), 'cloud-vault-test-'));
  thuMucTam.push(d);
  return d;
}
afterEach(() => {
  quenVault();
  for (const d of thuMucTam.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('dungVault', () => {
  it('khớp mọi mẫu nhận dạng của hợp đồng trừ GH_TOKEN (không ghi token phiên)', () => {
    const { vanBan, co } = dungVault(envDayDu());
    for (const c of HOP_DONG.credentials) {
      if (c.name === 'GH_TOKEN') {
        expect(vanBan).not.toMatch(new RegExp(c.detect));
        continue;
      }
      expect(vanBan, c.name).toMatch(new RegExp(c.detect));
    }
    expect(co).not.toContain('GH_TOKEN');
    expect(co).toContain('FLEET_PASS_QUANLY2');
  });

  it('các hàm đọc vault lấy lại đúng giá trị', () => {
    const env = envDayDu();
    const d = taoThuMuc();
    const p = join(d, 'vault.md');
    writeFileSync(p, dungVault(env).vanBan);
    const opts = { env: { IHOMECRM_VAULT: p }, repoRoot: d };
    expect(docTaiKhoanTest(opts)).toEqual({ email: env.TEST_ACCOUNT_EMAIL, password: env.TEST_ACCOUNT_PASSWORD });
    expect(docMatKhauPooler(readFileSync(p, 'utf8'))).toBe(env.SUPABASE_DB_PASSWORD);
    expect(layPat(opts)).toBe(env.SUPABASE_PAT);
    expect(giaTriVault('SUPABASE_DB_PASSWORD', opts)).toBe(env.SUPABASE_DB_PASSWORD);
    expect(giaTriVault('TEST_SUPABASE_REF', opts)).toBe(env.TEST_SUPABASE_REF);
    expect(readFileSync(p, 'utf8')).toMatch(/^TEST_PASS b@vi-du\.test mk2$/m);
  });

  it('chỉ trả TÊN; bỏ qua giá trị sai dạng; báo thiếu', () => {
    const { vanBan, co, thieu, boQua } = dungVault({
      SUPABASE_PAT: 'sbp_' + lap('a', 40),
      VERCEL_TOKEN: 'co khoang trang',
      TEST_ACCOUNT_PASSWORD: 'co`backtick',
    });
    expect(co).toEqual(['SUPABASE_PAT']);
    expect(boQua).toEqual(expect.arrayContaining(['VERCEL_TOKEN', 'TEST_ACCOUNT_PASSWORD']));
    expect(thieu).toContain('SUPABASE_DB_PASSWORD');
    expect(vanBan).not.toContain('co khoang trang');
    expect(vanBan).not.toContain('backtick');
  });
});

describe('duongDanDich / ghiVault', () => {
  it('mặc định ~/.ihomecrm/vault.md; từ chối đích trong repo', () => {
    const home = taoThuMuc();
    const repo = taoThuMuc();
    expect(duongDanDich({ env: {}, repoRoot: repo, home })).toBe(join(home, '.ihomecrm', 'vault.md'));
    expect(() => duongDanDich({ env: { IHOMECRM_VAULT: join(repo, 'x.md') }, repoRoot: repo, home })).toThrow();
  });

  it('ghi quyền 600 và không đè vault không do script tạo', () => {
    const d = taoThuMuc();
    const p = join(d, 'sub', 'vault.md');
    ghiVault(p, DANH_DAU + '\nA=1\n');
    expect(statSync(p).mode & 0o777).toBe(0o600);
    ghiVault(p, DANH_DAU + '\nA=2\n');
    expect(readFileSync(p, 'utf8')).toContain('A=2');

    const that = join(d, 'that.md');
    writeFileSync(that, '# vault thật\n');
    expect(() => ghiVault(that, DANH_DAU + '\n')).toThrow();
    expect(readFileSync(that, 'utf8')).toBe('# vault thật\n');
    expect(existsSync(that)).toBe(true);
  });
});
