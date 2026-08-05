#!/usr/bin/env node
/**
 * Gieo đồ thị phân quyền của tổ chức DEMO vào stack cục bộ
 * (xem scripts/openclaw-local-stack.mjs).
 *
 * NGUYÊN TẮC: vai trò và quyền được CHÉP từ production vì chúng không tham chiếu
 * người dùng nào; còn người dùng thì TẠO MỚI trong GoTrue cục bộ rồi ánh xạ
 * membership sang uuid mới. Không chép `auth.users`, đặc biệt là không chép hash
 * mật khẩu — nó không cần cho việc test và là rủi ro không có lý do tồn tại.
 *
 * Chuỗi nối quyền, phải đủ cả bốn mắt xích thì RPC mới trả dữ liệu:
 *   organization_memberships -> role_bindings -> role_binding_scopes
 *                                             -> authorization_scopes
 *
 * CHỈ ĐỌC production. CHỈ GHI vào container cục bộ.
 *
 * Cách dùng: node scripts/openclaw-local-seed.mjs
 * Chạy lại được nhiều lần: mọi insert đều `on conflict do nothing`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PG = "oc-harness";
const GATEWAY = "http://127.0.0.1:54333";
const DEMO_ORG = "dddd0000-0000-4000-8000-000000000001";
const POOLER = "aws-1-ap-southeast-1.pooler.supabase.com";
/** Mật khẩu người dùng cục bộ. Không phải bí mật: chỉ tồn tại trong container này. */
const LOCAL_PASSWORD = process.env.OPENCLAW_LOCAL_USER_PASSWORD ?? "HarnessLocal!2026";

const USERS = ["chunha", "ketoan", "quanly"];

function docker(args) {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.error) return { code: 1, out: "", err: r.error.message };
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

const sql = (statement) =>
  docker(["exec", PG, "psql", "-U", "postgres", "-d", "postgres", "-tAc", statement]);

/**
 * Đọc mật khẩu DB production lúc chạy. KHÔNG in ra, KHÔNG đưa lên dòng lệnh —
 * nó đi qua stdin vào một .pgpass tạm trong container rồi bị xoá ở cuối.
 */
function readProductionCredentials() {
  // Một git worktree KHÔNG mang theo CLAUDE.local.md hay supabase/.temp/ của
  // riêng nó — cả hai nằm ở worktree chính. gen-supabase-types.mjs đã phải xử lý
  // đúng chuyện này; ở đây hỏi git thay vì đoán số cấp thư mục cần đi ngược lên.
  const roots = [resolve(process.cwd())];
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" });
  if (common.status === 0 && common.stdout.trim()) {
    roots.push(resolve(common.stdout.trim(), ".."));
  }

  const readFirst = (relative) => {
    for (const root of roots) {
      try {
        return readFileSync(resolve(root, relative), "utf8");
      } catch { /* thử gốc tiếp theo */ }
    }
    throw new Error(`Không tìm thấy ${relative} ở: ${roots.join(", ")}`);
  };

  const ref = readFirst("supabase/.temp/project-ref").trim();
  const match = readFirst("CLAUDE.local.md").match(/verify pooler login\): `([^`]+)`/u);
  if (!match) throw new Error("Không đọc được mật khẩu pooler từ CLAUDE.local.md");
  return { ref, password: match[1].trim() };
}

function withProductionAccess(run) {
  const { ref, password } = readProductionCredentials();
  const line = `${POOLER}:5432:*:postgres.${ref}:${password}\n`;
  const write = spawnSync("docker", ["exec", "-i", PG, "sh", "-c",
    "cat > /tmp/.pgpass && chmod 600 /tmp/.pgpass"], { input: line, encoding: "utf8" });
  if (write.status !== 0) throw new Error("Không ghi được .pgpass vào container");
  const conn = `host=${POOLER} port=5432 user=postgres.${ref} dbname=postgres sslmode=require`;
  try {
    return run(conn);
  } finally {
    docker(["exec", "-u", "root", PG, "sh", "-c", "rm -f /tmp/.pgpass"]);
  }
}

/** Xuất một truy vấn từ production ra CSV trong container. */
function exportCsv(conn, name, query) {
  const r = docker(["exec", PG, "sh", "-c",
    `PGPASSFILE=/tmp/.pgpass psql '${conn}' -c "\\copy (${query}) to '/work/${name}.csv' with csv"`]);
  const count = docker(["exec", PG, "sh", "-c", `wc -l < /work/${name}.csv`]).out;
  console.log(`  ${name.padEnd(24)} ${count} dòng${r.code === 0 ? "" : ` (LỖI: ${r.err.split("\n")[0]})`}`);
}

/** Nạp CSV qua bảng tạm rồi insert on-conflict, để chạy lại nhiều lần không vỡ. */
function loadCsv(name, table, where = "true") {
  const script = [
    `create temp table t_${name} (like ${table} including defaults);`,
    `\\copy t_${name} from '/work/${name}.csv' with csv`,
    `insert into ${table} select * from t_${name} where ${where} on conflict do nothing;`,
  ].join("\n");
  docker(["exec", PG, "sh", "-c", `cat > /work/load_${name}.sql <<'EOF'\n${script}\nEOF`]);
  const r = docker(["exec", PG, "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=off", "-f", `/work/load_${name}.sql`]);
  const inserted = (r.out.match(/INSERT 0 (\d+)/u) ?? [])[1] ?? "?";
  console.log(`  ${table.padEnd(34)} thêm ${inserted}`);
}

async function createUser(handle) {
  const email = `demo.${handle}@username.ihomecrm.local`;
  const response = await fetch(`${GATEWAY}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: LOCAL_PASSWORD }),
  });
  const body = await response.json().catch(() => ({}));
  const id = body.id ?? body.user?.id
    ?? sql(`select id from auth.users where email='${email}'`).out;
  console.log(`  ${handle.padEnd(10)} ${id || "KHÔNG TẠO ĐƯỢC"}`);
  return id;
}

async function main() {
  if (docker(["inspect", "-f", "{{.State.Running}}", PG]).out !== "true") {
    console.error(`Chưa có container ${PG}. Chạy scripts/openclaw-local-stack.mjs up trước.`);
    process.exit(1);
  }

  console.log("=== 1) xuất dữ liệu phân quyền từ production (chỉ đọc) ===");
  withProductionAccess((conn) => {
    exportCsv(conn, "permission_definitions", "select * from public.permission_definitions");
    exportCsv(conn, "organization_roles",
      `select * from public.organization_roles where organization_id='${DEMO_ORG}'`);
    exportCsv(conn, "role_permissions",
      `select rp.* from public.role_permissions rp join public.organization_roles r on r.id=rp.role_id where r.organization_id='${DEMO_ORG}'`);
    exportCsv(conn, "authorization_scopes",
      `select * from public.authorization_scopes where organization_id='${DEMO_ORG}'`);
  });

  console.log("=== 2) tạo người dùng cục bộ qua GoTrue ===");
  const ids = {};
  for (const handle of USERS) ids[handle] = await createUser(handle);
  if (!ids.chunha) throw new Error("Không tạo được người dùng chunha; dừng.");

  console.log("=== 3) tổ chức DEMO ===");
  sql(`insert into public.organizations (id, slug, name, status, created_by)
       values ('${DEMO_ORG}','ihome-demo','iHome CRM (Demo)','ACTIVE','${ids.chunha}')
       on conflict (id) do nothing`);
  console.log(`  organizations                      ${sql(`select count(*) from public.organizations`).out}`);

  console.log("=== 4) nạp vai trò, quyền, phạm vi ===");
  loadCsv("permission_definitions", "public.permission_definitions");
  loadCsv("organization_roles", "public.organization_roles");
  loadCsv("role_permissions", "public.role_permissions");
  // CHỈ phạm vi cấp tổ chức: các dòng theo toà/khu vực có khoá ngoại sang
  // buildings/areas mà stack cục bộ chưa gieo, và không bài đo nào cần tới.
  loadCsv("authorization_scopes", "public.authorization_scopes", "scope_type = 'ORGANIZATION'");

  console.log("=== 5) membership + role_binding + phạm vi ===");
  sql(`insert into public.organization_memberships (organization_id, user_id, status, member_type)
       values ('${DEMO_ORG}','${ids.chunha}','ACTIVE','OWNER') on conflict do nothing`);
  sql(`insert into public.role_bindings (membership_id, role_id, organization_id)
       select m.id, r.id, '${DEMO_ORG}' from public.organization_memberships m
       cross join public.organization_roles r
       where m.user_id='${ids.chunha}' and m.organization_id='${DEMO_ORG}'
         and r.organization_id='${DEMO_ORG}' and r.name='Chủ sở hữu tổ chức'
       on conflict do nothing`);
  sql(`insert into public.role_binding_scopes (organization_id, role_binding_id, scope_id)
       select '${DEMO_ORG}', rb.id, s.id from public.role_bindings rb
       cross join public.authorization_scopes s
       where rb.organization_id='${DEMO_ORG}' and s.organization_id='${DEMO_ORG}'
         and s.scope_type='ORGANIZATION'
       on conflict do nothing`);

  console.log("=== 6) kiểm chứng: quyền có phân giải được không ===");
  const resolved = sql(
    `begin; select set_config('request.jwt.claims','{"sub":"${ids.chunha}","role":"authenticated"}',true);
     select coalesce(string_agg(x::text,','),'(RỖNG)') from app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.view') x; rollback;`,
  ).out.split("\n").filter(Boolean).at(-2) ?? "";
  console.log(`  openclaw_zalo.view -> ${resolved || "(không đọc được)"}`);
  if (!resolved.includes(DEMO_ORG)) {
    console.error("  CHƯA THÔNG: chuỗi membership -> role_binding -> scope còn đứt ở đâu đó.");
    process.exit(1);
  }
  console.log(`\nXong. Đăng nhập bằng demo.<${USERS.join("|")}>@username.ihomecrm.local`);
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});
