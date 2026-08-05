#!/usr/bin/env node
/**
 * Dựng stack Supabase CỤC BỘ cho E2E OpenClaw.
 *
 * VÌ SAO KHÔNG DÙNG `supabase start`: repo có 35 cặp file migration trùng số
 * version (cặp `016` có từ 21/11/2025, cả 35 cặp đều trên origin/main), nên CLI
 * chết ở UNIQUE của supabase_migrations.schema_migrations. Và replay theo tên
 * file cũng bất khả thi ở tầng SQL: 016_meter_readings_enhancements.sql đọc
 * `contracts.building_id`, cột KHÔNG migration nào tạo ra — điều này repo đã tự
 * ghi ở scripts/network-center-disposable-db.mjs:958-972.
 *
 * Nên schema đến từ `pg_dump --schema-only` của production, và các dịch vụ được
 * dựng tay quanh nó:
 *
 *   oc-harness  supabase/postgres:17.6.1.156   127.0.0.1:54330  schema production
 *   oc-rest     postgrest/postgrest:v12.2.3    127.0.0.1:54331  REST + RPC
 *   oc-auth     supabase/gotrue:v2.177.0       127.0.0.1:54332  đăng nhập
 *   oc-gw       nginx:1.27-alpine              127.0.0.1:54333  gộp thành 1 origin
 *
 * Mọi cổng bind 127.0.0.1, KHÔNG phải 0.0.0.0: án lệ trong dự án này là Docker
 * chọc thủng UFW và để lộ một Postgres dùng-một-lần ra Internet suốt 3 ngày.
 *
 * Cách dùng:
 *   node scripts/openclaw-local-stack.mjs up       # dựng 4 container
 *   node scripts/openclaw-local-stack.mjs status   # kiểm từng tầng
 *   node scripts/openclaw-local-stack.mjs down     # dọn sạch
 *
 * Baseline schema phải có sẵn trước (xem docs/openclaw-zalo/runbooks/) — script
 * này KHÔNG tự chụp dump production.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NETWORK = "oc-net";
const PG = "oc-harness";
const REST = "oc-rest";
const AUTH = "oc-auth";
const GW = "oc-gw";

/** Cùng một secret cho PostgREST và GoTrue. Lệch nhau thì đăng nhập được mà RPC 401. */
const JWT_SECRET = process.env.OPENCLAW_LOCAL_JWT_SECRET
  ?? "super-secret-jwt-token-with-at-least-32-characters-long";
/** Mật khẩu chỉ tồn tại trong container cục bộ, không phải bí mật production. */
const DB_PASSWORD = process.env.OPENCLAW_LOCAL_DB_PASSWORD ?? "harness";

const GATEWAY_CONF = `server {
  listen 8000;
  server_name _;
  set $cors "http://127.0.0.1:4173";

  location /auth/v1/ {
    if ($request_method = OPTIONS) { return 204; }
    proxy_pass http://${AUTH}:9999/;
    add_header Access-Control-Allow-Origin $cors always;
    add_header Access-Control-Allow-Headers "authorization,apikey,content-type,x-client-info,x-supabase-api-version" always;
    add_header Access-Control-Allow-Methods "GET,POST,PUT,PATCH,DELETE,OPTIONS" always;
  }
  location /rest/v1/ {
    if ($request_method = OPTIONS) { return 204; }
    proxy_pass http://${REST}:3000/;
    add_header Access-Control-Allow-Origin $cors always;
    add_header Access-Control-Allow-Headers "authorization,apikey,content-type,content-profile,accept-profile,prefer,x-client-info" always;
    add_header Access-Control-Allow-Methods "GET,POST,PUT,PATCH,DELETE,OPTIONS" always;
    add_header Access-Control-Expose-Headers "content-range,content-profile" always;
  }
  # Realtime và Storage chưa dựng. Trả 501 kèm lý do thay vì để treo: một khoảng
  # lặng ở đây hiện ra dưới dạng "test chậm" chứ không phải "tính năng thiếu",
  # và đó là kiểu che giấu tệ nhất.
  location /realtime/v1/ { return 501 '{"error":"realtime chua dung trong stack cuc bo"}'; }
  location /storage/v1/  { return 501 '{"error":"storage chua dung trong stack cuc bo"}'; }
}
`;

function docker(args, { quiet = true } = {}) {
  // maxBuffer rộng tay: gốc PostgREST trả đặc tả swagger ~1 MB, vượt mặc định
  // 1 MB của spawnSync và làm status trả `null` (ENOBUFS). Lần đầu viết hàm này
  // tôi đọc `null` đó thành "PostgREST không trả lời" trong khi nó vẫn chạy —
  // công cụ báo động giả còn tệ hơn không có công cụ.
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  if (result.error) return { code: 1, out: "", err: result.error.message };
  return { code: result.status ?? 1, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

const running = (name) => docker(["inspect", "-f", "{{.State.Running}}", name]).out === "true";

function requirePostgres() {
  if (running(PG)) return;
  console.error(
    `Chưa có container ${PG}. Baseline schema phải được chụp và nạp trước; script này\n` +
    `chỉ dựng các dịch vụ quanh nó.`,
  );
  process.exit(1);
}

function up() {
  requirePostgres();
  docker(["network", "create", NETWORK]);
  docker(["network", "connect", NETWORK, PG]);

  // authenticator trong dump là NOLOGIN không mật khẩu; PostgREST cần đăng nhập được.
  docker(["exec", PG, "psql", "-U", "supabase_admin", "-d", "postgres", "-q", "-c",
    `alter role authenticator with login password '${DB_PASSWORD}'`]);
  docker(["exec", PG, "psql", "-U", "supabase_admin", "-d", "postgres", "-q", "-c",
    `alter role supabase_auth_admin with login password '${DB_PASSWORD}'`]);

  docker(["rm", "-f", REST]);
  docker(["run", "-d", "--name", REST, "--network", NETWORK, "-p", "127.0.0.1:54331:3000",
    "-e", `PGRST_DB_URI=postgres://authenticator:${DB_PASSWORD}@${PG}:5432/postgres`,
    "-e", "PGRST_DB_SCHEMAS=public,api,storage",
    "-e", "PGRST_DB_ANON_ROLE=anon",
    "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`,
    "-e", "PGRST_DB_USE_LEGACY_GUCS=false",
    "postgrest/postgrest:v12.2.3"]);

  // GoTrue tự chạy migration của nó và LẤP luôn các bảng auth mà dump không nạp
  // được (nạp bằng `postgres` không ghi nổi vào schema auth).
  docker(["rm", "-f", AUTH]);
  docker(["run", "-d", "--name", AUTH, "--network", NETWORK, "-p", "127.0.0.1:54332:9999",
    "-e", "GOTRUE_API_HOST=0.0.0.0", "-e", "PORT=9999",
    "-e", "GOTRUE_DB_DRIVER=postgres",
    "-e", `DATABASE_URL=postgres://supabase_auth_admin:${DB_PASSWORD}@${PG}:5432/postgres?search_path=auth&sslmode=disable`,
    "-e", "GOTRUE_SITE_URL=http://127.0.0.1:4173",
    "-e", "GOTRUE_URI_ALLOW_LIST=http://127.0.0.1:4173,http://localhost:4173",
    "-e", `GOTRUE_JWT_SECRET=${JWT_SECRET}`,
    "-e", "GOTRUE_JWT_EXP=3600", "-e", "GOTRUE_JWT_AUD=authenticated",
    "-e", "GOTRUE_JWT_ADMIN_ROLES=service_role",
    "-e", "GOTRUE_DISABLE_SIGNUP=false", "-e", "GOTRUE_MAILER_AUTOCONFIRM=true",
    "-e", "API_EXTERNAL_URL=http://127.0.0.1:54332",
    "supabase/gotrue:v2.177.0"]);

  const dir = mkdtempSync(join(tmpdir(), "oc-gw-"));
  const conf = join(dir, "default.conf");
  writeFileSync(conf, GATEWAY_CONF, "utf8");
  docker(["rm", "-f", GW]);
  docker(["run", "-d", "--name", GW, "--network", NETWORK, "-p", "127.0.0.1:54333:8000",
    "-v", `${conf}:/etc/nginx/conf.d/default.conf:ro`, "nginx:1.27-alpine"]);

  console.log("Đã dựng. Cổng gộp: http://127.0.0.1:54333");
  console.log("Chạy `node scripts/openclaw-local-stack.mjs status` sau vài giây để kiểm từng tầng.");
}

function status() {
  for (const name of [PG, REST, AUTH, GW]) {
    console.log(`${name.padEnd(12)} ${running(name) ? "đang chạy" : "KHÔNG chạy"}`);
  }
  // Cắt ngay ở 200 byte: chỉ cần biết nó CÓ nói gì không, không cần cả đặc tả.
  const rest = docker(["exec", GW, "sh", "-c",
    `wget -qO- http://${REST}:3000/ | head -c 200`]);
  console.log(`PostgREST     ${rest.out.includes("swagger") ? "trả lời" : `KHÔNG trả lời (${rest.err || rest.out || "im lặng"})`}`);
  const auth = docker(["exec", GW, "sh", "-c",
    `wget -qO- http://${AUTH}:9999/health | head -c 200`]);
  console.log(`GoTrue        ${auth.out.includes("GoTrue") ? "trả lời" : `KHÔNG trả lời (${auth.err || auth.out || "im lặng"})`}`);
}

function down() {
  for (const name of [GW, AUTH, REST]) docker(["rm", "-f", name]);
  docker(["network", "rm", NETWORK]);
  console.log(`Đã dọn ${GW}, ${AUTH}, ${REST} và mạng ${NETWORK}. Container ${PG} giữ nguyên.`);
}

const command = process.argv[2];
if (command === "up") up();
else if (command === "status") status();
else if (command === "down") down();
else {
  console.error("Dùng: node scripts/openclaw-local-stack.mjs <up|status|down>");
  process.exit(1);
}
