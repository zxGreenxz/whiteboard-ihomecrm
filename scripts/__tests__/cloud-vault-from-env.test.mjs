// Test cho scripts/cloud-vault-from-env.mjs — vault phiên cloud ghép từ env.
//
// Ca quan trọng: vault sinh ra phải đọc được bằng CHÍNH các mẫu của hợp đồng và các
// hàm của scripts/lib/vault.mjs, và giá trị sai dạng không được lọt vào như "có khóa".
// Giá trị giả được ghép lúc chạy để không có chuỗi giống secret nằm trong mã nguồn.
// Test này chứng minh parser, KHÔNG chứng minh key thật dùng được.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DANH_DAU, chay, dungVault, duongDanDich, ghiVault } from '../cloud-vault-from-env.mjs';
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
    NVR_950NK_USERNAME: 'camera-proof-user',
    NVR_950NK_PASSWORD: 'camera-proof-' + lap('x', 12),
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

function chayThu(env) {
  const home = taoThuMuc();
  const repoRoot = taoThuMuc();
  const ra = [];
  const ma = chay({ env, home, repoRoot, log: (s) => ra.push(s), loi: (s) => ra.push(s) });
  return { ma, ra: ra.join('\n'), dich: join(home, '.ihomecrm', 'vault.md') };
}

describe('dungVault', () => {
  it('khớp mọi mẫu nhận dạng của hợp đồng trừ GH_TOKEN (không ghi token harness)', () => {
    const { vanBan, co, saiDang } = dungVault(envDayDu());
    for (const c of HOP_DONG.credentials) {
      if (c.name === 'GH_TOKEN') {
        expect(vanBan).not.toMatch(new RegExp(c.detect));
        continue;
      }
      expect(vanBan, c.name).toMatch(new RegExp(c.detect));
    }
    expect(co).not.toContain('GH_TOKEN');
    expect(co).toContain('FLEET_PASS_QUANLY2');
    expect(saiDang).toEqual([]);
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

  it('không ghi giá trị sai dạng hoặc lệch mẫu hợp đồng; chỉ trả TÊN', () => {
    const { vanBan, co, thieu, saiDang } = dungVault({
      SUPABASE_PAT: 'sbp_' + lap('a', 40) + 'thua',
      VERCEL_TOKEN: 'khong-dung-tien-to-' + lap('v', 20),
      GOONG_API_KEY: 'co khoang trang',
      TEST_ACCOUNT_PASSWORD: 'co`backtick',
      TEST_PASS: 'a@vi-du.test mk1; hong',
      FLEET_PASS_CHUNHA: 'f1',
    });
    expect(co).toEqual(['FLEET_PASS_CHUNHA']);
    expect(saiDang.sort()).toEqual(['GOONG_API_KEY', 'SUPABASE_PAT', 'TEST_ACCOUNT_PASSWORD', 'TEST_PASS', 'VERCEL_TOKEN']);
    expect(thieu).toContain('SUPABASE_DB_PASSWORD');
    for (const lo of ['thua', 'khong-dung', 'khoang trang', 'backtick', 'mk1']) expect(vanBan).not.toContain(lo);
  });

  it('mật khẩu có dấu cách vẫn đọc được qua mẫu pooler', () => {
    const { vanBan, co } = dungVault({ SUPABASE_DB_PASSWORD: 'mk co cach' });
    expect(co).toEqual(['SUPABASE_DB_PASSWORD']);
    expect(docMatKhauPooler(vanBan)).toBe('mk co cach');
  });
});

describe('chay — không báo thành công giả', () => {
  it('0 khi mọi biến đã khai đều ghi được; quyền 600; xuất IHOMECRM_VAULT ra CLAUDE_ENV_FILE', () => {
    const envFile = join(taoThuMuc(), 'env');
    writeFileSync(envFile, '');
    const { ma, ra, dich } = chayThu({ ...envDayDu(), CLAUDE_ENV_FILE: envFile });
    expect(ma).toBe(0);
    expect(statSync(dich).mode & 0o777).toBe(0o600);
    expect(readFileSync(envFile, 'utf8')).toBe(`export IHOMECRM_VAULT=${JSON.stringify(dich)}\n`);
    expect(ra).not.toContain(envDayDu().SUPABASE_PAT);
  });

  it('1 khi có biến sai dạng dù vault vẫn được dựng', () => {
    const { ma, ra } = chayThu({ SUPABASE_PAT: 'sbp_' + lap('a', 40), VERCEL_TOKEN: 'sai' });
    expect(ma).toBe(1);
    expect(ra).toMatch(/KHÔNG được ghi.*VERCEL_TOKEN/);
  });

  it('3 khi environment chưa khai biến nào; không tạo vault, không xuất env', () => {
    const envFile = join(taoThuMuc(), 'env');
    writeFileSync(envFile, '');
    const { ma, ra, dich } = chayThu({ GH_TOKEN: 'ghp_' + lap('G', 36), CLAUDE_ENV_FILE: envFile });
    expect(ma).toBe(3);
    expect(ra).toMatch(/KHÔNG tạo vault/);
    expect(() => statSync(dich)).toThrow();
    expect(readFileSync(envFile, 'utf8')).toBe('');
  });

  it('1 khi đích có vault không do script tạo — không đè', () => {
    const home = taoThuMuc();
    const that = join(home, 'that.md');
    writeFileSync(that, '# vault thật\n');
    const ra = [];
    const ma = chay({
      env: { SUPABASE_PAT: 'sbp_' + lap('a', 40), IHOMECRM_VAULT: that },
      home,
      repoRoot: taoThuMuc(),
      log: (s) => ra.push(s),
      loi: (s) => ra.push(s),
    });
    expect(ma).toBe(1);
    expect(ra.join('\n')).toMatch(/KHÔNG ghi được vault/);
    expect(readFileSync(that, 'utf8')).toBe('# vault thật\n');
  });
});

describe('duongDanDich / ghiVault', () => {
  it('mặc định ~/.ihomecrm/vault.md; từ chối đích trong repo', () => {
    const home = taoThuMuc();
    const repo = taoThuMuc();
    expect(duongDanDich({ env: {}, repoRoot: repo, home })).toBe(join(home, '.ihomecrm', 'vault.md'));
    expect(() => duongDanDich({ env: { IHOMECRM_VAULT: join(repo, 'x.md') }, repoRoot: repo, home })).toThrow();
  });

  it('ghi đè được vault do chính script tạo (phiên resume)', () => {
    const p = join(taoThuMuc(), 'sub', 'vault.md');
    ghiVault(p, DANH_DAU + '\nA=1\n');
    ghiVault(p, DANH_DAU + '\nA=2\n');
    expect(readFileSync(p, 'utf8')).toContain('A=2');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
