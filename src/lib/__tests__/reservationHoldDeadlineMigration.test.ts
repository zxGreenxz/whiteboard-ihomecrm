// Guard TĨNH cho migration "hạn phải làm hợp đồng" (bảng
// public.reservation_hold_deadlines + writer set_reservation_hold_deadline_v1).
//
// Quyết định nằm 100% trong SQL/plpgsql nên vitest không chạy được logic thật.
// Thứ test này chốt là HÌNH DẠNG của định nghĩa ĐANG SỐNG — đọc lần CREATE cuối
// cùng trên toàn bộ thư mục migration, không ghim một file (Contract §8 +
// scripts/check-migration-test-liveness.mjs: ghim file làm test xanh vĩnh viễn
// vì file cũ bị đóng băng bởi provenance, còn hành vi thật dời sang file mới).
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

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
 * Lần CREATE cuối cùng của một hàm public — định nghĩa đang sống.
 *
 * `body` là RIÊNG thân hàm, cắt từ `CREATE ... FUNCTION` tới hết `$…$;`.
 * KHÔNG được để test soi cả file: khối tự-kiểm và các khối guard của chính
 * migration nhắc lại đúng những chuỗi mà test đi tìm ("VOLATILE",
 * "can_access_building"), nên `toContain` trên cả file vẫn xanh kể cả khi thân
 * hàm đã bị gỡ mất bất biến. Đã đo bằng đột biến: hai phép kiểm sống sót vì
 * đúng lý do này.
 *
 * `whole` giữ nguyên cả file cho các phép kiểm về GRANT/REVOKE — chúng nằm
 * NGOÀI thân hàm nên phải soi ở phạm vi file.
 */
function liveFunction(fnName: string): { file: string; whole: string; body: string } {
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`, "i");
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) if (re.test(m.sql)) hit = m;
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của public.${fnName}`);

  const start = hit.sql.search(re);
  const rest = hit.sql.slice(start);
  // Thân hàm kết thúc ở dấu dollar-quote đóng: `AS $tag$ … $tag$;`
  const tag = /\bAS\s+(\$[a-z_]*\$)/i.exec(rest);
  let body = rest;
  if (tag) {
    const openEnd = tag.index + tag[0].length;
    const close = rest.indexOf(tag[1], openEnd);
    if (close > 0) body = rest.slice(0, close + tag[1].length);
  }
  return { file: hit.file, whole: hit.sql, body };
}

/** Mọi migration có nhắc tới bảng — để soi policy dù nó nằm ở file khác. */
function filesMentioning(token: string): { file: string; sql: string }[] {
  return migrationCorpus().filter((m) => m.sql.includes(token));
}

const TABLE = "reservation_hold_deadlines";
const FN = "set_reservation_hold_deadline_v1";

describe("bảng reservation_hold_deadlines", () => {
  it("có migration tạo bảng", () => {
    const creators = migrationCorpus().filter((m) =>
      new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?public\\.${TABLE}\\b`, "i").test(m.sql),
    );
    expect(creators.length).toBeGreaterThan(0);
  });

  it("bật RLS", () => {
    const all = filesMentioning(TABLE).map((m) => m.sql).join("\n");
    expect(all).toMatch(new RegExp(`ALTER\\s+TABLE\\s+public\\.${TABLE}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, "i"));
  });

  it("migration tự chốt chủ-bảng = definer-writer", () => {
    // Nếu hai vai khác nhau thì đường ghi DUY NHẤT bị chính RLS của bảng chặn,
    // và chuyện đó chỉ lộ lúc người dùng thật bấm lưu — DDL vẫn xanh.
    // Cố ý KHÔNG đòi FORCE RLS: vai chạy migration (`postgres`) có BYPASSRLS
    // nên FORCE và ENABLE cho hành vi giống hệt; đòi FORCE là đòi một lớp bảo
    // vệ không tồn tại.
    const all = filesMentioning(TABLE).map((m) => m.sql).join("\n");
    expect(all).toMatch(/c\.relowner\s*=\s*p\.proowner/i);
  });

  it("có policy biên giới tổ chức RESTRICTIVE và policy che org sandbox", () => {
    // Contract §5: bảng mới có organization_id BẮT BUỘC có _hide_sandbox_admin.
    const all = filesMentioning(TABLE).map((m) => m.sql).join("\n");
    expect(all).toContain(`${TABLE}_org_boundary`);
    expect(all).toMatch(/AS\s+RESTRICTIVE\s+FOR\s+ALL/i);
    expect(all).toContain(`${TABLE}_hide_sandbox_admin`);
    expect(all).toContain("sandbox_org_ids");
    expect(all).toContain("my_org_ids");
  });

  it("KHÔNG mở ghi trực tiếp cho authenticated", () => {
    // Đường ghi duy nhất phải là RPC: chỉ ở đó mới kiểm được quyền TOÀ của
    // phiếu — RLS chỉ nhìn thấy organization_id của chính dòng này.
    const all = filesMentioning(TABLE).map((m) => m.sql).join("\n");
    expect(all).toMatch(new RegExp(`GRANT\\s+SELECT\\s+ON\\s+TABLE\\s+public\\.${TABLE}\\s+TO\\s+authenticated`, "i"));
    expect(all).not.toMatch(
      new RegExp(`GRANT\\s+(ALL|INSERT|UPDATE|DELETE)[^;]*ON\\s+TABLE\\s+public\\.${TABLE}[^;]*TO[^;]*authenticated`, "i"),
    );
    expect(all).toMatch(new RegExp(`REVOKE\\s+ALL\\s+ON\\s+TABLE\\s+public\\.${TABLE}\\s+FROM\\s+PUBLIC,\\s*anon`, "i"));
  });

  it("THU HỒI tường minh khỏi authenticated, không chỉ khỏi PUBLIC/anon", () => {
    // ÁN LỆ 22/08/2026 — đo ngay sau lần apply đầu tiên:
    //   authenticated : DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
    // Supabase có `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO
    // authenticated` nên quyền được cấp NGAY tại CREATE TABLE, và
    // `REVOKE ALL ... FROM PUBLIC, anon` KHÔNG chạm authenticated (nó không
    // nằm trong PUBLIC). `GRANT SELECT` sau đó chỉ cộng vào một tập vốn đã đầy.
    // Bảng vẫn không hở vì RLS thiếu policy ghi — nhưng lớp phòng thủ thứ hai
    // thì không tồn tại, đúng thứ thiết kế tuyên bố là có.
    const all = filesMentioning(TABLE).map((m) => m.sql).join("\n");
    expect(all).toMatch(
      new RegExp(`REVOKE\\s+ALL\\s+ON\\s+TABLE\\s+public\\.${TABLE}\\s+FROM\\s+authenticated`, "i"),
    );
  });

  it("có tự-kiểm ĐO tập quyền thật, không chỉ gõ câu REVOKE", () => {
    // Câu REVOKE có mặt trong file không chứng minh tập quyền cuối cùng đúng —
    // đó chính là cách lỗi trên lọt qua. Migration phải tự đọc
    // role_table_grants sau khi ghi.
    const all = filesMentioning(TABLE).map((m) => m.sql).join("\n");
    expect(all).toContain("role_table_grants");
    expect(all).toMatch(/grantee\s*=\s*'authenticated'/i);
  });

  it("khoá ngoại về income_expenses có ON DELETE CASCADE", () => {
    // Xoá phiếu mà bỏ lại hạn mồ côi thì hàng đợi sẽ hiện việc của một phiếu
    // không còn tồn tại.
    const all = filesMentioning(TABLE).map((m) => m.sql).join("\n");
    expect(all).toMatch(/REFERENCES\s+public\.income_expenses\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i);
  });
});

describe(`writer ${FN}`, () => {
  it("là SECURITY DEFINER và VOLATILE", () => {
    const { body } = liveFunction(FN);
    expect(body).toMatch(/SECURITY\s+DEFINER/i);
    // GOTCHA repo (đã cắn 5 lần): hàm lấy khoá dòng mà khai STABLE thì PostgREST
    // chạy trong transaction READ ONLY và ném 25006 — gọi bằng SQL vẫn xanh.
    expect(body).toMatch(/\bVOLATILE\b/i);
    expect(body).not.toMatch(/^\s*STABLE\s*$/im);
    expect(body).toMatch(/SET\s+search_path/i);
  });

  it("kiểm tư cách phiếu trước khi ghi", () => {
    const { body } = liveFunction(FN);
    expect(body).toMatch(/FOR\s+UPDATE/i);
    expect(body).toContain("deleted_at");
    expect(body).toContain("contract_id");
    expect(body).toMatch(/'INCOME'/);
  });

  it("kiểm quyền toà nhà — không tin client", () => {
    const { body } = liveFunction(FN);
    expect(body).toMatch(/can_access_building\s*\(\s*v_ie\.building_id\s*\)/i);
    expect(body).toMatch(/ie_all_buildings_scope\s*\(\s*v_ie\.building_id\s*\)/i);
    expect(body).toMatch(/auth\.uid\(\)/);
  });

  it("từ chối hạn nằm trước ngày lập phiếu", () => {
    // Hạn trước voucher_date là đã trễ ngay lúc tạo ⇒ thẻ đỏ giả trên bàn xử lý.
    const { body } = liveFunction(FN);
    expect(body).toMatch(/p_hold_until\s*<\s*v_ie\.voucher_date/i);
  });

  it("NULL nghĩa là xoá hạn, không phải lỗi", () => {
    const { body } = liveFunction(FN);
    expect(body).toMatch(/IF\s+p_hold_until\s+IS\s+NULL\s+THEN/i);
    expect(body).toMatch(new RegExp(`DELETE\\s+FROM\\s+public\\.${TABLE}`, "i"));
  });

  it("không phơi cho anon", () => {
    // GRANT/REVOKE nằm NGOÀI thân hàm ⇒ soi ở phạm vi file.
    const { whole } = liveFunction(FN);
    expect(whole).toMatch(new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${FN}[^;]*FROM\\s+PUBLIC,\\s*anon`, "i"));
    expect(whole).toMatch(new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${FN}[^;]*TO\\s+authenticated`, "i"));
  });
});
