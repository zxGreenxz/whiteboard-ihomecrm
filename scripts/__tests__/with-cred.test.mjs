// Test cho scripts/with-cred.mjs — nạp credential vào env TIẾN TRÌNH CON, không in ra.
//
// Mọi ca chạy thật đều trỏ IHOMECRM_VAULT vào vault giả trong thư mục tạm, nên test
// không bao giờ đọc vault thật của máy. Giá trị giả ghép lúc chạy.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { dungLoiGoi, maThoat, thoatDoiSoCmd, thuMucLamViec, timLenh } from '../with-cred.mjs';

const SCRIPT = resolve(import.meta.dirname, '..', 'with-cred.mjs');
const PAT_GIA = 'sbp_' + 'f'.repeat(40);
const GH_GIA = 'ghp_' + 'H'.repeat(36);

const tam = [];
function thuMuc() {
  const d = mkdtempSync(join(tmpdir(), 'with-cred-'));
  tam.push(d);
  return d;
}
afterEach(() => {
  for (const d of tam.splice(0)) rmSync(d, { recursive: true, force: true });
});

function khoaPath(env) {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

/** Env sạch credential + vault giả. */
function envThu(vaultText, them = {}) {
  const d = thuMuc();
  const vault = join(d, 'vault.md');
  writeFileSync(vault, vaultText);
  const env = { ...process.env, IHOMECRM_VAULT: vault, ...them };
  for (const k of ['SUPABASE_PAT', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'GH_TOKEN', 'VERCEL_TOKEN', 'IHOMECRM_SECRET_FILE', 'npm_lifecycle_event', 'INIT_CWD']) {
    if (!(k in them)) delete env[k];
  }
  return env;
}

function chay(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 60_000 });
}

describe('with-cred — chạy thật', () => {
  it('nạp PAT cho cả hai tên, env có sẵn thắng vault, không in giá trị', () => {
    const env = envThu(`${PAT_GIA}\nGH_TOKEN=${GH_GIA}\n`, { GH_TOKEN: 'gh-cua-env' });
    const kiem = [
      `const e = process.env;`,
      `const ok = e.SUPABASE_PAT === ${JSON.stringify(PAT_GIA)} && e.SUPABASE_ACCESS_TOKEN === e.SUPABASE_PAT`,
      ` && e.GH_TOKEN === 'gh-cua-env';`,
      `process.exit(ok ? 7 : 9);`,
    ].join('');
    const r = chay(['node', '-e', kiem], env);
    expect(r.status).toBe(7);
    expect(r.stdout + r.stderr).not.toContain(PAT_GIA);
    expect(r.stdout + r.stderr).not.toContain(GH_GIA);
    // Thiếu thì chỉ in TÊN.
    expect(r.stderr).toMatch(/SUPABASE_DB_PASSWORD/);
    expect(r.stderr).toMatch(/VERCEL_TOKEN/);
  });

  it('trả nguyên mã thoát của lệnh con', () => {
    const r = chay(['node', '-e', 'process.exit(42)'], envThu(PAT_GIA));
    expect(r.status).toBe(42);
  });

  it('credential KHÔNG rò sang tiến trình cha (chỉ env con)', () => {
    const before = process.env.SUPABASE_PAT;
    chay(['node', '-e', 'process.exit(0)'], envThu(PAT_GIA));
    expect(process.env.SUPABASE_PAT).toBe(before);
  });

  it('không có lệnh ⇒ in cách dùng, thoát 2', () => {
    const r = chay([], envThu(''));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Cách dùng/);
  });

  it('lệnh không tồn tại ⇒ 127', () => {
    const r = chay(['lenh-khong-ton-tai-' + Date.now()], envThu(''));
    expect(r.status).toBe(127);
  });

  it.runIf(process.platform === 'win32')('Windows: lệnh .cmd nhận đúng đối số có dấu cách, nháy, %, &', () => {
    const d = thuMuc();
    writeFileSync(join(d, 'in-doi-so.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    writeFileSync(join(d, 'in-doi-so.cmd'), '@node "%~dp0in-doi-so.js" %*\r\n');
    const env = envThu('');
    const k = khoaPath(env);
    env[k] = `${d};${env[k]}`;
    // Hai lượt: file .cmd đọc lại `%*` lần nữa, nên nháy kép nằm TRONG đối số làm lệch
    // trạng thái nháy của các đối số SAU nó (giới hạn của mọi shim .cmd, đã ghi ở đầu
    // with-cred.mjs) — không trộn nháy kép với `&` trong cùng một lượt.
    for (const doiSo of [
      ['a b', '100%', '%PATH%', 'c&d', '^mu', 'cuoi\\'],
      ['--sql', 'select 1 as "ok"', 'x"y'],
    ]) {
      const r = chay(['in-doi-so', ...doiSo], env);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(doiSo);
    }
  });
});

describe('with-cred — dựng lời gọi', () => {
  it('ngoài Windows: gọi thẳng, không qua shell', () => {
    expect(dungLoiGoi('gh', ['run', 'list'], { platform: 'linux', env: {} })).toEqual({ command: 'gh', args: ['run', 'list'], options: {} });
  });

  it('Windows: .cmd đi qua cmd.exe với đối số đã thoát; .exe gọi thẳng', () => {
    const d = thuMuc();
    writeFileSync(join(d, 'cong-cu.cmd'), '@echo off\r\n');
    // Như thư mục nodejs: script sh `npm` không đuôi nằm cạnh `npm.cmd` — phải chọn .cmd.
    writeFileSync(join(d, 'cong-cu'), '#!/bin/sh\n');
    writeFileSync(join(d, 'chuong-trinh.exe'), '');
    const env = { PATH: d, PATHEXT: '.EXE;.CMD', ComSpec: 'cmd.exe' };
    expect(timLenh('cong-cu', { env, platform: 'win32' })?.toLowerCase()).toBe(join(d, 'cong-cu.cmd').toLowerCase());
    const goi = dungLoiGoi('cong-cu', ['a b'], { env, platform: 'win32' });
    expect(goi.command).toBe('cmd.exe');
    expect(goi.args).toEqual(['/d', '/s', '/c', '"cong-cu ^"a^ b^""']);
    expect(goi.options).toEqual({ windowsVerbatimArguments: true });
    const exe = dungLoiGoi('chuong-trinh', ['x'], { env, platform: 'win32' });
    expect(exe.command.toLowerCase()).toBe(join(d, 'chuong-trinh.exe').toLowerCase());
    expect(exe.options).toEqual({});
  });

  it('thoát đối số cmd: nháy kép và gạch chéo cuối được nhân đôi đúng chỗ', () => {
    expect(thoatDoiSoCmd('x"y')).toBe('^"x\\^"y^"');
    expect(thoatDoiSoCmd('a\\')).toBe('^"a\\\\^"');
    expect(thoatDoiSoCmd('')).toBe('^"^"');
  });

  it('thư mục làm việc: INIT_CWD chỉ khi chạy qua npm run with-cred', () => {
    const d = thuMuc();
    expect(thuMucLamViec({ npm_lifecycle_event: 'with-cred', INIT_CWD: d }, 'goc')).toBe(d);
    expect(thuMucLamViec({ npm_lifecycle_event: 'build', INIT_CWD: d }, 'goc')).toBe('goc');
    expect(thuMucLamViec({}, 'goc')).toBe('goc');
  });

  it('mã thoát theo tín hiệu', () => {
    expect(maThoat(0, null)).toBe(0);
    expect(maThoat(3, null)).toBe(3);
    expect(maThoat(null, 'SIGINT')).toBe(130);
    expect(maThoat(null, 'SIGLAUNCH')).toBe(1);
  });
});
