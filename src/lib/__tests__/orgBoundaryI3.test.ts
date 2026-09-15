import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bất biến biên giới tổ chức — phần I3 của đợt rà soát 15/09/2026.
 *
 * ĐO ĐỊNH NGHĨA SỐNG, KHÔNG ĐO MỘT FILE MIGRATION.
 *   Repo chỉ sửa hành vi SQL bằng forward-fix (`CREATE OR REPLACE` trong một
 *   file MỚI), và mọi file cũ bị provenance băm sha256 nên bất biến. Test ghim
 *   một file cụ thể vì thế xanh vĩnh viễn kể cả khi hàm thật đã đổi — đúng lớp
 *   lỗi mà scripts/check-migration-test-liveness.mjs sinh ra để chặn. Nên ở đây
 *   quét toàn bộ thư mục migration và lấy lần CREATE CUỐI CÙNG.
 *
 * Bốn bất biến, mỗi cái ứng với một chỗ hở đã đo trên production 15/09/2026:
 *   1. Không đường ghi nào còn ĐOÁN organization_id ra hằng số tổ chức thật.
 *   2. Vai chủ sở hữu nhận diện bằng system_key, không bằng tên tự do.
 *   3. Cửa tạo toà nhận hệ quyền v3, và toà mới tự sinh phạm vi phân quyền.
 *   4. Hai đường đọc "được xem toà này không" nói cùng một câu.
 */

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations");

/** Bỏ chú thích dòng để chữ trong chú thích không làm test xanh/đỏ giả. */
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, "");

let corpusCache: { file: string; sql: string }[] | null = null;
function migrationCorpus(): { file: string; sql: string }[] {
  if (!corpusCache) {
    corpusCache = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({ file: f, sql: stripComments(readFileSync(join(MIG_DIR, f), "utf8")) }));
  }
  return corpusCache;
}

/**
 * Cắt đúng THÂN một định nghĩa, không lấy cả file.
 *
 * Cần cắt vì một file migration thường có thêm khối NGHIỆM THU nhắc lại chính
 * chuỗi mà test đang cấm (ví dụ so tập người lọt cửa "trước và sau" phải viết
 * ra tên vai cũ). Soi cả file là bắt nhầm phép kiểm thành vi phạm.
 */
function catThanHam(sql: string, from: number): string {
  const tag = /\$([A-Za-z_]*)\$/.exec(sql.slice(from, from + 600));
  if (!tag) return sql.slice(from);
  const open = from + tag.index + tag[0].length;
  const close = sql.indexOf(tag[0], open);
  return close === -1 ? sql.slice(from) : sql.slice(from, close + tag[0].length);
}

/** Định nghĩa SỐNG của một hàm = lần CREATE cuối cùng theo thứ tự timestamp. */
function liveFunction(qualified: string): { file: string; sql: string } {
  const [schema, fn] = qualified.split(".");
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${fn}\\s*\\(`, "i");
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) {
    const found = re.exec(m.sql);
    if (found) hit = { file: m.file, sql: catThanHam(m.sql, found.index) };
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của ${qualified}`);
  return hit;
}

/** Bản CREATE POLICY cuối cùng của một policy trên một bảng. */
function livePolicy(policy: string, table: string): { file: string; sql: string } {
  const re = new RegExp(`CREATE\\s+POLICY\\s+${policy}\\s+ON\\s+public\\.${table}\\b`, "i");
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) {
    const found = re.exec(m.sql);
    if (found) {
      const end = m.sql.indexOf(";", found.index);
      hit = { file: m.file, sql: m.sql.slice(found.index, end === -1 ? undefined : end + 1) };
    }
  }
  if (!hit) throw new Error(`Không tìm thấy CREATE POLICY ${policy} ON public.${table}`);
  return hit;
}

describe("I3.1 — không đường ghi nào đoán organization_id ra tổ chức THẬT", () => {
  // public._autofill_org kết thúc bằng hằng số org thật khi không suy được.
  // Nó chỉ nguy hiểm khi CÒN trigger trỏ vào; file cuối cùng nhắc tới nó phải
  // là file gỡ nó ra, không phải file gắn thêm.
  it("migration cuối cùng động tới _autofill_org là migration GỠ trigger", () => {
    const nhac = migrationCorpus().filter((m) => /_autofill_org\b(?!_)/.test(m.sql));
    expect(nhac.length).toBeGreaterThan(0);
    const cuoi = nhac[nhac.length - 1];
    expect(
      /proname\s*=\s*'_autofill_org'/.test(cuoi.sql),
      `${cuoi.file} là file cuối cùng động tới public._autofill_org mà không phải file chuyển trigger. ` +
        "Gắn thêm trigger cho hàm đoán org là mở lại đúng cửa I3.1 đã đóng.",
    ).toBe(true);
  });

  it("autofill_org_strict suy được đủ các cột cha mà _autofill_org vốn suy", () => {
    const { file, sql } = liveFunction("app_private.autofill_org_strict");
    // Ba cột này là chỗ 33 bảng chuyển sang sẽ NỔ nếu hàm không biết chúng:
    // income_expense_items chỉ có income_expense_id, và _autofill_org vốn suy
    // được cả account_id lẫn customer_id.
    for (const cot of ["income_expense_id", "account_id", "customer_id", "batch_id"]) {
      expect(sql, `${file}: autofill_org_strict thiếu cột cha ${cot}`).toContain(`'${cot}'`);
    }
  });

  it("autofill_org_strict vẫn FAIL-CLOSED (nổ 23502), không rơi về hằng số org", () => {
    const { file, sql } = liveFunction("app_private.autofill_org_strict");
    expect(sql, `${file}: mất nhánh RAISE`).toMatch(/RAISE\s+EXCEPTION/i);
    expect(sql).toContain("23502");
    expect(
      /aaaa0000-0000-4000-8000-000000000001/.test(sql),
      `${file}: autofill_org_strict nhắc tới hằng số tổ chức THẬT — nó phải nổ, không được đoán.`,
    ).toBe(false);
  });

  it("chỉ tra bảng cha khi giá trị ĐÚNG DẠNG uuid", () => {
    // public_room_events.session_id là text (id phiên trình duyệt). Không có
    // chốt này thì mọi dòng thiếu org của bảng đó nổ 22P02.
    const { file, sql } = liveFunction("app_private.autofill_org_strict");
    expect(sql, `${file}: thiếu chốt dạng uuid trước khi ép kiểu`).toMatch(
      /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/i,
    );
  });
});

describe("I3.2 — vai chủ sở hữu nhận diện bằng system_key, không bằng tên", () => {
  const HAM_CUA_CHU = [
    "public._termination_ensure_type",
    "public.get_ie_auto_approve_threshold_v1",
    "public.set_ie_auto_approve_threshold_v1",
    "public.set_membership_status_v1",
  ];

  it.each(HAM_CUA_CHU)("%s không so vai theo chuỗi tên", (fn) => {
    const { file, sql } = liveFunction(fn);
    expect(
      /r\.name\s*=\s*'Chủ sở hữu tổ chức'/.test(sql),
      `${file}: ${fn} còn nhận diện vai chủ bằng TÊN. Tên vai là text tự do — ` +
        "đổi tên trong Cài đặt là tổ chức mất chủ.",
    ).toBe(false);
    expect(sql, `${file}: ${fn} phải neo vào system_key`).toMatch(
      /r\.system_key\s*=\s*'TENANT_OWNER'/,
    );
  });
});

describe("I3.3 — chủ công ty tạo được toà, toà mới có phạm vi phân quyền", () => {
  it("buildings_insert_rbac nhận quyền theo hệ v3, không chỉ staff_assignments", () => {
    const { file, sql } = livePolicy("buildings_insert_rbac", "buildings");
    expect(sql, `${file}: cửa tạo toà chưa nhận authorized_scope_v3`).toContain(
      "authorized_scope_v3",
    );
    expect(sql).toContain("buildings.create");
    // Vế cũ phải còn: nới cửa không được âm thầm thu hẹp của ai đang dùng.
    expect(sql, `${file}: mất vế staff_assignments cũ`).toContain("staff_assignments");
  });

  it("chỉ org_wide mới tạo được toà — quyền một toà không phải quyền tạo toà", () => {
    const { file, sql } = livePolicy("buildings_insert_rbac", "buildings");
    expect(sql, `${file}: phải đọc org_wide`).toMatch(/org_wide/);
    expect(
      /building_ids/.test(sql),
      `${file}: cửa tạo toà không được xét building_ids — toà mới chưa tồn tại để trỏ tới.`,
    ).toBe(false);
  });

  it("có trigger AFTER INSERT trên buildings sinh authorization_scopes", () => {
    const co = migrationCorpus().some(
      (m) =>
        /CREATE\s+TRIGGER\s+\w+\s+AFTER\s+INSERT\s+ON\s+public\.buildings/i.test(m.sql) &&
        /sinh_authorization_scope/i.test(m.sql),
    );
    expect(
      co,
      "Không có trigger sinh authorization_scopes cho toà mới — toà mới sẽ vô hình trong hộp thoại Phân quyền.",
    ).toBe(true);
  });
});

describe("I3.5 — hai đường đọc quyền xem toà nói cùng một câu", () => {
  it("can_access_building loại trừ toà của tài khoản demo, giống buildings_for_v3", () => {
    const { file, sql } = liveFunction("public.can_access_building");
    expect(sql, `${file}: thiếu mệnh đề sandbox`).toContain("sandbox_org_ids");
    expect(
      sql,
      `${file}: thiếu mệnh đề loại trừ toà demo mà app_private.buildings_for_v3 đã có từ 01/08. ` +
        "Thiếu nó thì RLS giấu toà demo khi đọc bảng nhưng báo cáo SECURITY DEFINER vẫn thấy.",
    ).toContain("demo_user_ids");
  });

  it("hồ sơ super admin chỉ lộ cho người cùng tổ chức", () => {
    const { file, sql } = livePolicy("profiles_select_super_admin", "profiles");
    expect(
      sql,
      `${file}: policy vẫn cho MỌI người đăng nhập đọc hồ sơ super admin.`,
    ).toContain("cung_to_chuc_voi_toi_v1");
    // Vế cũ phải còn, nếu không thì nhân viên khác đội mất chủ trong ô
    // "Người nhận" khi bàn giao tiền (án lệ JOEY, 20260701150000).
    expect(sql).toContain("is_user_super_admin");
  });
});
