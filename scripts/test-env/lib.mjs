// Thư viện dùng chung cho môi trường TEST riêng (project Supabase `ihomecrm-test`).
//
// VÌ SAO TỒN TẠI: chủ cần một bản sao ĐẦY ĐỦ production (dữ liệu, tài khoản, vai trò,
// file) để thử tính năng mới trước khi phát hành. Org TEST cũ nằm CHUNG database với
// công ty thật (cccc…, xoá 08/08/2026) và đã gây nhân đôi số liệu — lần này tách hẳn
// sang project thứ hai. Mọi script trong thư mục này GHI vào project TEST và CHỈ ĐỌC
// production.
//
// CHỐT AN TOÀN (không được nới):
//   1. `batBuocDichTest(ref)` từ chối mọi ref bằng production, và hỏi Management API
//      để chắc tên project đúng là `ihomecrm-test`.
//   2. Chuỗi kết nối production chỉ dùng cho pg_dump / SELECT trong transaction
//      READ ONLY.
//   3. Mật khẩu chỉ đi qua PGPASSFILE tạm (xoá khi thoát) hoặc biến môi trường —
//      không bao giờ lên dòng lệnh hay stdout.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pgPassLine, readPoolerPassword } from "../backup-before-schema.mjs";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const PROD_REF = "tryymsxyyckgbrmmvozx";
export const TEST_PROJECT_NAME = "ihomecrm-test";

// Schema ỨNG DỤNG: thứ được xoá sạch rồi dựng lại từ production mỗi lần đồng bộ.
// Mọi schema khác (auth, storage, realtime, extensions, cron, vault, graphql…) thuộc
// nền tảng Supabase — chỉ chép DỮ LIỆU cần thiết (auth.users) hoặc tái lập đúng phần
// ứng dụng cắm vào đó (policy/trigger trên storage.objects, trigger trên auth.users).
export const APP_SCHEMAS = ["public", "app_private", "api", "clone_org", "demo_snapshot", "supabase_migrations"];

// Schema riêng của TEST, KHÔNG bị xoá khi đồng bộ: sổ file đã chép, lịch sử đồng bộ.
export const TEST_ENV_SCHEMA = "test_env";

// Cron production KHÔNG dựng lại trên TEST, kèm lý do.
export const CRON_BO_QUA = {
  clone_org_sync_worker: "cơ chế org TEST cũ (đã xoá 08/08) — vô nghĩa trên project riêng",
  network_center_watchdog_liveness_v1: "không worker nào báo nhịp về TEST ⇒ watchdog sẽ báo sự cố giả hàng loạt",
  network_center_watchdog_maintenance_v1: "đi cặp với watchdog liveness",
};

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

/**
 * Vault duy nhất là CLAUDE.local.md ở CHECKOUT CHÍNH (Contract §9). Worktree không có
 * bản sao, nên dò: biến IHOMECRM_VAULT → repo hiện tại → checkout chính (thư mục cha
 * của git common dir). Trên CI không có vault: mọi thứ đến từ biến môi trường.
 */
export function duongDanVault() {
  const ungVien = [];
  if (process.env.IHOMECRM_VAULT) ungVien.push(process.env.IHOMECRM_VAULT);
  ungVien.push(join(repoRoot, "CLAUDE.local.md"));
  try {
    const common = execFileSync("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    ungVien.push(join(dirname(common), "CLAUDE.local.md"));
  } catch { /* không phải git checkout */ }
  return ungVien.find((p) => existsSync(p)) ?? null;
}

let _vault;
export function docVault() {
  if (_vault !== undefined) return _vault;
  const p = duongDanVault();
  _vault = p ? readFileSync(p, "utf8") : "";
  return _vault;
}

function tuVault(re) {
  const m = docVault().match(re);
  return m ? m[1] : null;
}

export function credential() {
  const pat = process.env.SUPABASE_PAT || tuVault(/(sbp_[A-Za-z0-9]+)/);
  const prodDbPassword = process.env.SUPABASE_DB_PASSWORD || readPoolerPassword(docVault());
  const testRef = process.env.TEST_SUPABASE_REF || tuVault(/^TEST_SUPABASE_REF=([a-z0-9]{20})\s*$/m);
  const testDbPassword = process.env.TEST_SUPABASE_DB_PASSWORD || tuVault(/^TEST_SUPABASE_DB_PASSWORD=(\S+)\s*$/m);
  // Project TEST do tài khoản khác tạo ⇒ PAT production không thấy nó (403). PAT riêng
  // cho TEST chỉ cần cho các bước Management API (Data API, Auth, edge function);
  // thiếu thì các bước đó báo bỏ qua, phần database/file vẫn chạy.
  const testPat = process.env.TEST_SUPABASE_PAT || tuVault(/^TEST_SUPABASE_PAT=(sbp_[A-Za-z0-9_]+)\s*$/m) || null;
  const testSecretKey = process.env.TEST_SUPABASE_SECRET_KEY || tuVault(/^TEST_SUPABASE_SECRET_KEY=(\S+)\s*$/m) || null;
  const testPublishableKey = process.env.TEST_SUPABASE_PUBLISHABLE_KEY || tuVault(/^TEST_SUPABASE_PUBLISHABLE_KEY=(\S+)\s*$/m) || null;
  const testPoolerHost = process.env.TEST_SUPABASE_POOLER_HOST || tuVault(/^TEST_SUPABASE_POOLER_HOST=(\S+)\s*$/m) || null;
  // Seed sinh MẬT KHẨU TEST TẤT ĐỊNH (HMAC(seed, email)): vault và CI ra cùng một mật
  // khẩu mà không phải lưu từng mật khẩu làm secret. Chạy tại máy lần đầu thì tự sinh
  // seed và ghi vault; trên CI thiếu seed thì dừng trước mọi lệnh ghi.
  let passwordSeed = process.env.TEST_ENV_PASSWORD_SEED || tuVault(/^TEST_ENV_PASSWORD_SEED=(\S+)\s*$/m) || null;
  const vaultPath = duongDanVault();
  if (!passwordSeed && vaultPath && !process.env.CI) {
    passwordSeed = randomBytes(32).toString("base64url");
    appendFileSync(vaultPath, `\nTEST_ENV_PASSWORD_SEED=${passwordSeed}\n`);
    _vault = undefined;
  }
  const thieu = [];
  if (!pat) thieu.push("SUPABASE_PAT");
  if (!prodDbPassword) thieu.push("SUPABASE_DB_PASSWORD (pooler production)");
  if (!testRef) thieu.push("TEST_SUPABASE_REF");
  if (!testDbPassword) thieu.push("TEST_SUPABASE_DB_PASSWORD");
  if (!testSecretKey) thieu.push("TEST_SUPABASE_SECRET_KEY");
  if (!passwordSeed) thieu.push("TEST_ENV_PASSWORD_SEED");
  if (thieu.length) {
    throw new Error(`Thiếu credential: ${thieu.join(", ")}. Đặt biến môi trường hoặc ghi vào vault CLAUDE.local.md.`);
  }
  return { pat, prodDbPassword, testRef, testDbPassword, testPat, testSecretKey, testPublishableKey, testPoolerHost, passwordSeed };
}

// ---------------------------------------------------------------------------
// Management API
// ---------------------------------------------------------------------------

export async function mgmt(pat, method, path, body) {
  for (let lan = 1; lan <= 4; lan += 1) {
    const res = await fetch(`https://api.supabase.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 429 && lan < 4) {
      await new Promise((r) => setTimeout(r, 5000 * lan));
      continue;
    }
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
      // Không in body đầy đủ: response lỗi có thể vọng lại dữ liệu nhạy cảm.
      const msg = typeof json === "object" && json?.message ? json.message : String(text).slice(0, 200);
      const err = new Error(`Management API ${method} ${path} → ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
  throw new Error(`Management API ${method} ${path}: hết lượt thử (429)`);
}

/**
 * CHỐT AN TOÀN SỐ 1. Mọi thao tác GHI phải qua đây trước. Ba lớp độc lập:
 *   a) ref khác production;
 *   b) nếu có PAT của TEST: Management API xác nhận tên project là `ihomecrm-test`;
 *   c) DẤU TRONG DATABASE: bảng `test_env.danh_dau` chứa đúng ref TEST. Production
 *      không bao giờ có bảng này, nên kể cả khi chuỗi kết nối bị tráo (pooler, biến
 *      môi trường sai), lệnh ghi vẫn dừng. Dấu chỉ được TẠO khi database còn trống
 *      (project vừa tạo) — database có dữ liệu mà thiếu dấu thì từ chối.
 */
export async function batBuocDichTest(cred, test) {
  const ref = cred.testRef;
  if (!ref || ref === PROD_REF || test.includes(PROD_REF)) {
    throw new Error(`Đích "${ref}" là PRODUCTION hoặc rỗng — từ chối ghi.`);
  }
  if (cred.testPat) {
    const p = await mgmt(cred.testPat, "GET", `/v1/projects/${ref}`);
    if (p?.name !== TEST_PROJECT_NAME) {
      throw new Error(`Project ${ref} tên "${p?.name}", không phải "${TEST_PROJECT_NAME}" — từ chối ghi.`);
    }
    if (!/ACTIVE_HEALTHY/.test(String(p.status))) {
      throw new Error(`Project TEST ${ref} đang ở trạng thái ${p.status} — chờ ACTIVE_HEALTHY.`);
    }
  }
  const [dau] = psqlJson(test, `
    select to_regclass('${TEST_ENV_SCHEMA}.danh_dau') is not null as co_dau,
           (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
              and c.oid not in (select objid from pg_depend where deptype = 'e')) as bang_public,
           to_regnamespace('app_private') is not null as co_app_private`);
  if (dau.co_dau) {
    const [r] = psqlJson(test, `select ref from ${TEST_ENV_SCHEMA}.danh_dau limit 1`);
    if (r?.ref !== ref) throw new Error(`Dấu TEST trong database là "${r?.ref}", không khớp ${ref} — từ chối ghi.`);
    return;
  }
  if (Number(dau.bang_public) > 0 || dau.co_app_private) {
    throw new Error("Database đích CÓ dữ liệu nhưng KHÔNG có dấu TEST — có thể đang trỏ nhầm production. Từ chối ghi.");
  }
  psql(test, `CREATE SCHEMA IF NOT EXISTS ${TEST_ENV_SCHEMA};
REVOKE ALL ON SCHEMA ${TEST_ENV_SCHEMA} FROM PUBLIC, anon, authenticated;
CREATE TABLE ${TEST_ENV_SCHEMA}.danh_dau (ref text PRIMARY KEY, tao_luc timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON ${TEST_ENV_SCHEMA}.danh_dau FROM PUBLIC, anon, authenticated;
INSERT INTO ${TEST_ENV_SCHEMA}.danh_dau (ref) VALUES (${lit(ref)});`);
}

const _pooler = new Map();
/** Host session pooler (cổng 5432) của một project — mỗi project có thể khác tiền tố aws-0/aws-1. */
export async function poolerHost(pat, ref) {
  if (_pooler.has(ref)) return _pooler.get(ref);
  let host = null;
  try {
    const cfg = await mgmt(pat, "GET", `/v1/projects/${ref}/config/database/pooler`);
    const arr = Array.isArray(cfg) ? cfg : [cfg];
    host = arr.map((c) => c?.db_host).find(Boolean) ?? null;
  } catch { /* rơi về mặc định bên dưới */ }
  if (!host && ref === PROD_REF) host = "aws-1-ap-southeast-1.pooler.supabase.com";
  if (!host) throw new Error(`Không lấy được host pooler của ${ref}.`);
  _pooler.set(ref, host);
  return host;
}

// ---------------------------------------------------------------------------
// Kết nối PostgreSQL
// ---------------------------------------------------------------------------

const PG_BIN_CANDIDATES = ["C:/Program Files/PostgreSQL/17/bin", "C:/Program Files/PostgreSQL/18/bin", "/usr/lib/postgresql/17/bin"];

export function congCu(ten) {
  for (const dir of PG_BIN_CANDIDATES) {
    const p = join(dir, process.platform === "win32" ? `${ten}.exe` : ten);
    if (existsSync(p)) return p;
  }
  return ten; // PATH
}

export function kiemCongCu() {
  for (const ten of ["pg_dump", "pg_restore", "psql"]) {
    const r = spawnSync(congCu(ten), ["--version"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`Không chạy được ${ten}. Cài PostgreSQL client 17+.`);
    const major = Number(/(\d+)\.\d+/.exec(r.stdout)?.[1] ?? 0);
    if (major < 17) throw new Error(`${ten} bản ${major} — cần ≥ 17 (production chạy 17.6).`);
  }
}

const _donKhiThoat = [];
/** Đăng ký việc dọn (đồng bộ) chạy khi tiến trình thoát — kể cả khi bị SIGINT/SIGTERM. */
export function khiThoat(fn) {
  _donKhiThoat.push(fn);
}

let _passFile = null;
/**
 * Dựng MỘT PGPASSFILE tạm chứa mọi đích trong tiến trình này, gắn vào
 * process.env.PGPASSFILE để mọi tiến trình con (pg_dump/pg_restore/psql) thừa kế.
 * Xoá khi tiến trình thoát, kể cả khi lỗi.
 */
export function dangKyMatKhau(entries) {
  const lines = entries.map((e) => pgPassLine(e.host, 5432, "postgres", e.user, e.password)).join("");
  if (!_passFile) {
    _passFile = join(tmpdir(), `.pgpass-test-env-${process.pid}`);
    const don = () => {
      for (const fn of _donKhiThoat) { try { fn(); } catch { /* dọn tiếp phần còn lại */ } }
      try { rmSync(_passFile, { force: true }); } catch { /* đã xoá */ }
    };
    process.on("exit", don);
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { don(); process.exit(130); });
  }
  writeFileSync(_passFile, lines, { encoding: "utf8", mode: 0o600 });
  process.env.PGPASSFILE = _passFile;
}

export function uri(host, ref) {
  // Keepalive: pooler đóng kết nối im lặng lâu (xem backup-before-schema.mjs).
  return `postgresql://${encodeURIComponent(`postgres.${ref}`)}@${host}:5432/postgres` +
    "?keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_count=6&application_name=test-env-sync";
}

/** Dựng hai đích prod/test + nạp mật khẩu. */
export async function ketNoi(cred) {
  const [prodHost, testHost] = await Promise.all([
    poolerHost(cred.pat, PROD_REF),
    cred.testPoolerHost ?? poolerHost(cred.testPat ?? cred.pat, cred.testRef),
  ]);
  dangKyMatKhau([
    { host: prodHost, user: `postgres.${PROD_REF}`, password: cred.prodDbPassword },
    { host: testHost, user: `postgres.${cred.testRef}`, password: cred.testDbPassword },
  ]);
  return { prod: uri(prodHost, PROD_REF), test: uri(testHost, cred.testRef) };
}

/**
 * GUC giống nhau hai phía để `t::text` / pg_get_* in ra đúng một kiểu. SET LOCAL —
 * chỉ sống trong transaction: kết nối pooler có thể được trả cho client khác, không
 * được để GUC phiên (search_path = pg_catalog…) rò sang.
 */
export const SET_CHUAN = [
  "SET LOCAL TimeZone = 'UTC'",
  "SET LOCAL DateStyle = 'ISO, YMD'",
  "SET LOCAL IntervalStyle = 'postgres'",
  "SET LOCAL extra_float_digits = 1",
  "SET LOCAL bytea_output = 'hex'",
  "SET LOCAL search_path = pg_catalog",
].join(";\n") + ";\n";

/** Chạy một khối SQL bằng psql (stdin). Lỗi thì NÉM, không nuốt. */
export function psql(dich, sql, { dungKhiLoi = true, timeoutMs = 60 * 60 * 1000, env } = {}) {
  const r = spawnSync(congCu("psql"), ["-d", dich, "-X", "-q", "-v", `ON_ERROR_STOP=${dungKhiLoi ? 1 : 0}`, "-f", "-"], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...process.env, ...(env ?? {}) },
  });
  if (r.error) throw r.error;
  if (dungKhiLoi && r.status !== 0) {
    throw new Error(`psql lỗi (${r.status}): ${String(r.stderr || "").slice(0, 1500)}`);
  }
  return { stdout: String(r.stdout || ""), stderr: String(r.stderr || ""), status: r.status };
}

/** SELECT trả JSON, trong transaction READ ONLY. `sql` là câu SELECT; kết quả bọc json_agg. */
export function psqlJson(dich, sql) {
  const { stdout } = psql(dich, `BEGIN READ ONLY;\n${SET_CHUAN}\\pset tuples_only on\n\\pset format unaligned\nSELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql}\n) t;\nCOMMIT;\n`);
  return JSON.parse(stdout.trim() || "[]");
}

/**
 * Phiên psql DÀI HẠN — giữ một transaction mở để export snapshot cho pg_dump, rồi
 * chạy thêm truy vấn đo đạc TRONG CÙNG snapshot. Nhờ vậy số đếm/mã băm production
 * khớp đúng từng dòng với bản dump, không bị nhiễu bởi dữ liệu ghi trong lúc dump.
 */
export class PhienPsql {
  constructor(dich) {
    this.p = spawn(congCu("psql"), ["-d", dich, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=0"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.buf = "";
    this.err = "";
    this.cho = null;
    this.dem = 0;
    this.p.stdout.setEncoding("utf8");
    this.p.stderr.setEncoding("utf8");
    this.p.stdout.on("data", (d) => { this.buf += d; this._thu(); });
    this.p.stderr.on("data", (d) => { this.err += d; });
    this.p.on("exit", (code) => {
      if (this.cho) this.cho.reject(new Error(`psql thoát (${code}): ${this.err.slice(-800)}`));
    });
  }

  _thu() {
    if (!this.cho) return;
    // Dấu kết thúc mang luôn biến :ERROR của psql ("true" nếu lệnh cuối lỗi) — không
    // dựa vào thứ tự đến của hai pipe stdout/stderr, vốn không được bảo đảm.
    const m = new RegExp(`${this.cho.dau} (true|false)\\r?\\n`).exec(this.buf);
    if (!m) return;
    const out = this.buf.slice(0, m.index);
    this.buf = this.buf.slice(m.index + m[0].length);
    const { resolve: ok, reject: hong } = this.cho;
    this.cho = null;
    if (m[1] === "true" || this.err.includes("ERROR")) {
      const e = this.err;
      this.err = "";
      hong(new Error(`psql: ${e.slice(0, 1500)}`));
    } else {
      this.err = "";
      ok(out);
    }
  }

  chay(sql) {
    this.dem += 1;
    const dau = `__XONG_${this.dem}_${process.pid}__`;
    return new Promise((ok, hong) => {
      this.cho = { dau, resolve: ok, reject: hong };
      this.p.stdin.write(`${sql}\n\\echo ${dau} :ERROR\n`);
    });
  }

  async json(sql) {
    const out = await this.chay(`SELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql}\n) t;`);
    return JSON.parse(out.trim() || "[]");
  }

  async dong() {
    try { await this.chay("ROLLBACK;"); } catch { /* đã đóng */ }
    this.p.stdin.end();
    await new Promise((r) => this.p.on("close", r));
  }
}

// ---------------------------------------------------------------------------
// Tiện ích
// ---------------------------------------------------------------------------

export function ghiLog(buoc, msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${buoc.padEnd(12)} ${msg}`);
}

export function lit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

export function ident(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

export const SCHEMA_LIST_SQL = APP_SCHEMAS.map(lit).join(",");
