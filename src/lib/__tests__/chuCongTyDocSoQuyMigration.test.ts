// Guard TĨNH cho "chủ công ty đọc được mọi sổ quỹ" (24/09/2026).
//
// Lỗi gốc: chủ công ty không giữ sổ nào ⇒ RLS `accounts` giấu mọi sổ ⇒ danh sách
// Thu chi (nối `accounts!inner`) trống. Hành vi thật đã đo bằng JWT trên môi trường
// TEST (xem migration). File này chốt HÌNH DẠNG của định nghĩa ĐANG CHẠY — lần
// CREATE cuối cùng trên toàn thư mục migration, không ghim một file
// (scripts/check-migration-test-liveness.mjs).
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

let corpusCache: { file: string; sql: string }[] | null = null;
function corpus(): { file: string; sql: string }[] {
  if (!corpusCache) {
    corpusCache = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({ file: f, sql: stripComments(readFileSync(join(MIG_DIR, f), "utf8")) }));
  }
  return corpusCache;
}

/** Lần cuối một regex khớp trên toàn thư mục (thứ tự timestamp) — kèm vị trí trong file. */
function lastMatch(re: RegExp): { file: string; sql: string; at: number } {
  let hit: { file: string; sql: string; at: number } | null = null;
  for (const m of corpus()) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const x of m.sql.matchAll(g)) hit = { ...m, at: x.index ?? 0 };
  }
  if (!hit) throw new Error(`Không tìm thấy ${re}`);
  return hit;
}

/** Thân hàm SỐNG của app_private.<ten>: từ CREATE cuối tới hết khối dollar-quote. */
function liveFunction(ten: string): { file: string; text: string } {
  const { file, sql, at } = lastMatch(
    new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+app_private\\.${ten}\\s*\\(`, "i"),
  );
  const rest = sql.slice(at);
  const tag = rest.match(/AS\s+(\$[a-z_]*\$)/i)?.[1];
  if (!tag) throw new Error(`Không thấy dollar-quote của ${ten}`);
  const open = rest.indexOf(tag);
  const close = rest.indexOf(tag, open + tag.length);
  return { file, text: rest.slice(0, close + tag.length) };
}

/** Câu CREATE POLICY SỐNG (tới dấu `;`), kèm file chứa nó. */
function livePolicy(ten: string): { file: string; text: string } {
  const { file, sql, at } = lastMatch(new RegExp(`CREATE\\s+POLICY\\s+${ten}\\s+ON\\s+public\\.accounts`, "i"));
  return { file, text: sql.slice(at, sql.indexOf(";", at) + 1) };
}

const HELPER = "my_company_owner_org_ids_v1";

describe("ie_visible_cashbook_ids_v1 — quyền xem TỒN QUỸ", () => {
  const { text } = liveFunction("ie_visible_cashbook_ids_v1");

  it("có nhánh chủ công ty, dạng set-based", () => {
    expect(text).toMatch(/a\.organization_id\s+IN\s*\(\s*SELECT\s+app_private\.my_company_owner_org_ids_v1\(\)\s*\)/i);
  });

  it("giữ nguyên ba nhánh cũ và hai bộ lọc", () => {
    expect(text).toMatch(/public\.is_super_admin\(\)/);
    expect(text).toMatch(/a\.user_id\s*=\s*auth\.uid\(\)/);
    expect(text).toMatch(/SELECT\s+app_private\.my_possessed_cashbook_ids_v1\(\)/);
    expect(text).toMatch(/a\.deleted_at\s+IS\s+NULL/i);
    expect(text).toMatch(/a\.organization_id\s*=\s*ANY\s*\(\s*public\.my_org_ids\(\)\s*\)/i);
  });
});

describe(`app_private.${HELPER} — tập org mà người gọi là chủ`, () => {
  const { file, text } = liveFunction(HELPER);
  const sqlFile = corpus().find((m) => m.file === file)!.sql;

  it("neo theo VAI (ie_actor_is_company_owner_v1), theo đúng người gọi", () => {
    expect(text).toMatch(/app_private\.ie_actor_is_company_owner_v1\s*\(\s*m\.organization_id\s*,\s*m\.user_id\s*\)/i);
    expect(text).toMatch(/m\.user_id\s*=\s*auth\.uid\(\)/i);
    expect(text).toMatch(/m\.status\s*=\s*'ACTIVE'/i);
  });

  it("SECURITY DEFINER + STABLE + ghim search_path, không khoá dòng (án lệ 25006)", () => {
    expect(text).toMatch(/SECURITY\s+DEFINER/i);
    expect(text).toMatch(/\bSTABLE\b/i);
    expect(text).toMatch(/SET\s+search_path/i);
    expect(text).not.toMatch(/FOR\s+(SHARE|UPDATE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)/i);
  });

  it("thu quyền từng vai rồi chỉ cấp authenticated", () => {
    expect(sqlFile).toMatch(
      new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+app_private\\.${HELPER}\\(\\)\\s+FROM\\s+PUBLIC,\\s*anon,\\s*authenticated`, "i"),
    );
    expect(sqlFile).toMatch(new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+app_private\\.${HELPER}\\(\\)\\s+TO\\s+authenticated\\s*;`, "i"));
    const grants = [...sqlFile.matchAll(new RegExp(`GRANT[^;]*${HELPER}[^;]*;`, "gi"))].map((m) => m[0]);
    expect(grants.some((g) => /\banon\b|service_role|PUBLIC/i.test(g))).toBe(false);
  });
});

describe("policy accounts_select_company_owner", () => {
  const { text } = livePolicy("accounts_select_company_owner");

  it("PERMISSIVE, chỉ SELECT, chỉ authenticated, gọi helper một lần mỗi truy vấn", () => {
    expect(text).toMatch(/AS\s+PERMISSIVE/i);
    expect(text).toMatch(/FOR\s+SELECT/i);
    expect(text).toMatch(/TO\s+authenticated\s/i);
    expect(text).toMatch(/USING\s*\(\s*organization_id\s+IN\s*\(\s*SELECT\s+app_private\.my_company_owner_org_ids_v1\(\)\s*\)\s*\)/i);
    expect(text).not.toMatch(/WITH\s+CHECK/i);
  });

  it("không bị DROP sau lần CREATE cuối", () => {
    const create = lastMatch(/CREATE\s+POLICY\s+accounts_select_company_owner\s+ON\s+public\.accounts/i);
    const drops = corpus().flatMap((m) =>
      [...m.sql.matchAll(/DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?accounts_select_company_owner\s+ON\s+public\.accounts/gi)].map(
        (x) => ({ file: m.file, at: x.index ?? 0 }),
      ),
    );
    const sau = drops.filter((d) => d.file > create.file || (d.file === create.file && d.at > create.at));
    expect(sau).toEqual([]);
  });

  it("chỉ ĐỌC: không policy ghi nào dựa vào helper", () => {
    const ghi = corpus().flatMap((m) =>
      [...m.sql.matchAll(/CREATE\s+POLICY[^;]*?FOR\s+(INSERT|UPDATE|DELETE|ALL)[^;]*;/gi)]
        .map((x) => x[0])
        .filter((p) => p.includes(HELPER)),
    );
    expect(ghi).toEqual([]);
  });
});
