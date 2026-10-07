// Log CI của repo PUBLIC ai cũng đọc được. Hai máy đối chiếu tiền chạy trên dữ
// liệu production trong job `reconcile-money`, nên trên CI chúng chỉ được in phán
// quyết, số đếm và mã chỗ lệch — không số tiền, số dư hay tên sổ. Local vẫn in đủ.
//
// Test chạy ĐÚNG script thật trong tiến trình con; chỉ thay ranh giới mạng bằng
// fetch giả (preload), và fetch giả ném lỗi với mọi URL lạ nên không lần nào chạm
// được Supabase thật hay credential của máy.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AN_TREN_CI,
  dinhDangTien,
  laLogCongKhai,
  vanBanNguoiDung,
} from "../lib/che-so-lieu-ci.mjs";

const SCRIPTS = fileURLToPath(new URL("..", import.meta.url));

// Mọi số tiền fixture đều >= 1 triệu, nên trên CI không được còn nhóm nghìn nào
// kiểu 1.234.567 hay một dãy >= 7 chữ số liền.
const SO_TIEN_LO_RA = /\d{1,3}(?:\.\d{3}){2,}|\d{7,}/;

const FIXTURE_ENV = {
  SUPABASE_PAT: "sbp_fixture_only",
  SUPABASE_PROJECT_REF: "fixtureref",
  VITE_SUPABASE_URL: "https://fixture.supabase.invalid",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture_only",
  SUPABASE_TEST_EMAIL: "fixture@example.invalid",
  SUPABASE_TEST_PASSWORD: "fixture-only",
};

const MANAGEMENT_API = "https://api.supabase.com/v1/projects/fixtureref/database/query";

const PRELOAD_V1 = `
const S = process.env.FIXTURE_SCENARIO;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.href === '${MANAGEMENT_API}') {
    const q = JSON.parse(init.body).query;
    if (q.includes('GROUP BY 1')) return json([{ m: '2026-09', c: 1001 }]);
    if (q.includes('SUM(total_amount)')) return json([{ v: '555444333' }]);
    if (q.includes('accounts_with_balance')) return json([{ v: '999888777', c: 4 }]);
    throw new Error('unexpected SQL');
  }
  if (url.origin !== 'https://fixture.supabase.invalid') throw new Error('unexpected URL ' + url.origin);
  if (url.pathname === '/auth/v1/token') return json({
    access_token: 'fixture-access', token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fixture-refresh',
    user: { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated',
      email: 'fixture@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
  });
  if (url.pathname === '/rest/v1/rpc/get_income_expense_layer_stats') {
    return json([{ cash_income: S === 'lech' ? 555000000 : 555444000, internal_income: 333, pending_income: 0 }]);
  }
  if (url.pathname === '/rest/v1/income_expenses') {
    const off = Number(url.searchParams.get('offset') ?? 0);
    if (off === 0) return json(Array.from({ length: 1000 }, () => ({ total_amount: 555000 })));
    if (off === 1000) return json([{ total_amount: 444333 }]);
    return json([]);
  }
  throw new Error('unexpected path ' + url.pathname);
};
`;

const PRELOAD_V2 = `
const S = process.env.FIXTURE_SCENARIO;
const rows = (q) => {
  if (q.includes('to_regclass')) return [{ v2: true, legacy: true, lines: true }];
  if (q.includes('FROM public.accounts_with_balance_v2 WHERE is_virtual = false')) return [{ c: 3 }];
  if (q.includes('AS diff')) {
    return S === 'lech'
      ? [{ account_id: 'acc-fixture-1', organization_id: 'org-fixture-1', name: 'So quy fixture rieng',
          legacy_amount: '777666555', v2_amount: '777000000', diff: '-666555' }]
      : [];
  }
  if (q.includes('SUM(pl.signed_amount)')) return [{ v: '888777666', c: 1001 }];
  if (q.includes('SUM(s.signed_amount)')) return [{ v: '888000000' }];
  const off = /OFFSET (\\d+)/.exec(q);
  if (off) {
    const o = Number(off[1]);
    if (o === 0) return Array.from({ length: 1000 }, () => ({ s: '888000' }));
    if (o === 1000) return [{ s: '777666' }];
    return [];
  }
  throw new Error('unexpected SQL');
};
globalThis.fetch = async (input, init = {}) => {
  if (String(input) !== '${MANAGEMENT_API}') throw new Error('unexpected URL');
  return new Response(JSON.stringify(rows(JSON.parse(init.body).query)), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};
`;

function chay(script, preload, { scenario, ci }) {
  const prefix = join(resolve(tmpdir()), "reconcile-ci-log-");
  const dir = mkdtempSync(prefix);
  try {
    const file = join(dir, "preload.mjs");
    writeFileSync(file, preload);
    const env = { ...process.env, ...FIXTURE_ENV, FIXTURE_SCENARIO: scenario };
    delete env.CI;
    if (ci) env.CI = "true";
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(file).href, join(SCRIPTS, script)], {
      cwd: dir,
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
  } finally {
    expect(resolve(dir).startsWith(prefix)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("che-so-lieu-ci", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["yes", true],
    ["", false],
    [undefined, false],
    ["false", false],
    ["0", false],
  ])("CI=%s ⇒ log công khai %s", (value, expected) => {
    expect(laLogCongKhai(value === undefined ? {} : { CI: value })).toBe(expected);
  });

  it("CI che số tiền và tên sổ; local in đủ theo vi-VN", () => {
    expect(dinhDangTien(1234567, { CI: "true" })).toBe(AN_TREN_CI);
    expect(dinhDangTien(1234567, {})).toBe((1234567).toLocaleString("vi-VN"));
    expect(vanBanNguoiDung("Quỹ riêng", { CI: "true" })).toBe("");
    expect(vanBanNguoiDung("Quỹ riêng", {})).toBe("Quỹ riêng");
  });
});

describe.each([
  ["reconcile-money.mjs", PRELOAD_V1, ["555.444.333"], ["999888777", "999.888.777"]],
  ["reconcile-money-v2.mjs", PRELOAD_V2, ["888.777.666"], []],
])("%s trên log CI", (script, preload, soTienLocal, soDuLocal) => {
  it("khớp: CI chỉ in phán quyết + số đếm, cùng mã thoát 0 với local", { timeout: 120_000 }, () => {
    const local = chay(script, preload, { scenario: "khop", ci: false });
    const ci = chay(script, preload, { scenario: "khop", ci: true });
    expect(local.status, local.out).toBe(0);
    expect(ci.status, ci.out).toBe(0);
    // Chống-xanh-rỗng: local PHẢI in số tiền, nếu không phép kiểm CI vô nghĩa.
    for (const so of soTienLocal) expect(local.out).toContain(so);
    expect(ci.out).toContain("PASS");
    expect(ci.out).toContain("1001");
    expect(ci.out).toContain(AN_TREN_CI);
    expect(ci.out).not.toMatch(SO_TIEN_LO_RA);
    for (const so of soDuLocal) expect(ci.out).not.toContain(so);
  });

  it("lệch: CI giữ phán quyết + mã thoát 1, không lộ số tiền", { timeout: 120_000 }, () => {
    const local = chay(script, preload, { scenario: "lech", ci: false });
    const ci = chay(script, preload, { scenario: "lech", ci: true });
    expect(local.status, local.out).toBe(1);
    expect(ci.status, ci.out).toBe(1);
    expect(ci.out).toContain("LỆCH");
    expect(ci.out).not.toMatch(SO_TIEN_LO_RA);
  });
});

describe("reconcile-money-v2 chỗ lệch trên log CI", () => {
  it("giữ mã sổ + mã tổ chức, bỏ tên sổ và số dư", { timeout: 120_000 }, () => {
    const local = chay("reconcile-money-v2.mjs", PRELOAD_V2, { scenario: "lech", ci: false });
    const ci = chay("reconcile-money-v2.mjs", PRELOAD_V2, { scenario: "lech", ci: true });
    expect(local.out).toContain("So quy fixture rieng");
    expect(local.out).toContain("777.666.555");
    expect(ci.out).toContain("acc-fixture-1");
    expect(ci.out).toContain("org-fixture-1");
    expect(ci.out).not.toContain("So quy fixture rieng");
    expect(ci.out).not.toContain("666.555");
  });
});
