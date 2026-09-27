import { sqlEvidence } from "./helpers/sqlEvidence";
// Guard TĨNH cho đợt "Hoàn lại khách khi thanh lý" (22/08/2026).
//
// Toàn bộ quyết định nằm trong plpgsql nên vitest không chạy được logic thật —
// phép toán đã có test thuần ở terminationSettlement.test.ts; file này chốt
// HÌNH DẠNG của SQL đang chạy.
//
// Mọi khẳng định đo ĐỊNH NGHĨA SỐNG (lần CREATE cuối cùng trên toàn bộ thư mục
// migration), không ghim một file. Ghim file là "test không thể đỏ": repo chỉ
// sửa hành vi bằng forward-fix, nên định nghĩa sống sẽ dời sang file khác trong
// khi test vẫn xanh vĩnh viễn. Xem scripts/check-migration-test-liveness.mjs.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");

const stripComments = sqlEvidence;

let corpusCache: { file: string; sql: string }[] | null = null;
function migrationCorpus(): { file: string; sql: string }[] {
  if (!corpusCache) {
    corpusCache = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({
        file: f,
        sql: stripComments(readFileSync(join(MIG_DIR, f), "utf8")),
      }));
  }
  return corpusCache;
}

/** Định nghĩa SỐNG của một hàm = lần CREATE cuối cùng theo thứ tự timestamp. */
function liveDefinitionOf(fnName: string): { file: string; sql: string } {
  const re = new RegExp(
    `CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`,
    "i",
  );
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) {
    if (re.test(m.sql)) hit = m;
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của public.${fnName}`);
  return hit;
}

/** Cắt đúng thân một hàm khỏi file chứa nó, để không bắt nhầm hàm hàng xóm. */
function liveBodyOf(fnName: string): string {
  const { sql } = liveDefinitionOf(fnName);
  const start = sql.search(
    new RegExp(
      `CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`,
      "i",
    ),
  );
  const rest = sql.slice(start);
  const end = rest.indexOf("$function$", rest.indexOf("$function$") + 10);
  return end === -1 ? rest : rest.slice(0, end + 10);
}

const IMPL = "terminate_contract_move_out_impl";
const MID = "terminate_contract_move_out";
const OUTER = "terminate_contract_move_out_with_credit_v1";

describe("hoàn lại khách khi thanh lý — chữ ký và luồng tham số", () => {
  it.each([IMPL, MID])("%s nhận p_refund_items", (fn) => {
    expect(liveBodyOf(fn)).toContain("p_refund_items jsonb DEFAULT '[]'::jsonb");
  });

  it("_with_credit_v1 nhận p_refund_items ở CUỐI chữ ký", () => {
    const body = liveBodyOf(OUTER);
    expect(body).toContain(
      "p_idempotency_key text, p_refund_items jsonb DEFAULT '[]'::jsonb)",
    );
  });

  it("khoản hoàn nằm trong payload_hash idempotency", () => {
    // Thiếu nó thì hai cú thanh lý khác khoản hoàn bị coi là replay của nhau và
    // cú thứ hai trả kết quả cũ mà không ghi gì.
    const body = liveBodyOf(OUTER);
    const hashBlock = body.slice(
      body.indexOf("v_hash := md5("),
      body.indexOf(")::text);", body.indexOf("v_hash := md5(")),
    );
    expect(hashBlock).toContain("'refund_items'");
  });

  it("mỗi lớp chuyển tiếp p_refund_items xuống lớp dưới", () => {
    expect(liveBodyOf(OUTER)).toContain("COALESCE(p_refund_items, '[]'::jsonb)");
    expect(liveBodyOf(MID)).toContain("COALESCE(p_refund_items, '[]'::jsonb)");
  });
});

describe("hoàn lại khách — bất biến nghĩa vụ hoàn cọc", () => {
  const impl = () => liveBodyOf(IMPL);

  it("nhánh cọc GIỮ NGUYÊN công thức cũ", () => {
    // contract_terminations.refund_amount là cột GENERATED = total_deposit −
    // deductions, và preview_termination_refund_v1 đối chiếu chính nó với cọc
    // thật đang giữ. Hai dòng dưới xê dịch là cảnh báo VUOT_COC_THAT thành vô
    // nghĩa.
    expect(impl()).toContain("v_applied_dep := LEAST(v_deposit, v_charges);");
    expect(impl()).toContain("v_refund_dep  := v_deposit - v_applied_dep;");
  });

  it("khoản hoàn chỉ cấn vào công nợ CÒN LẠI sau cọc và credit", () => {
    expect(impl()).toContain(
      "v_charges_left := GREATEST(v_charges - v_deposit - v_excess, 0);",
    );
    expect(impl()).toContain("v_owed_applied := LEAST(v_owed, v_charges_left);");
    expect(impl()).toContain("v_refund_owed  := v_owed - v_owed_applied;");
  });

  it("KHÔNG ghi khoản hoàn vào prorated_rent/prorated_services", () => {
    // Hai cột đó nằm ở vế TRỪ của công thức generated refund_amount — ghi vào
    // đó sẽ làm số nghĩa vụ hoàn cọc teo lại đúng bằng khoản mình hoàn.
    const body = impl();
    const inserts = [...body.matchAll(/\bINSERT\s+INTO\s+(?:public\.)?contract_terminations\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*;/gi)];
    expect(inserts, "exactly one audit INSERT in live move-out body").toHaveLength(1);
    const insert = inserts[0];
    const columns = insert[1].split(",").map((s) => s.trim());
    const values = insert[2].split(",").map((s) => s.trim());
    expect(new Set(columns).size).toBe(columns.length);
    expect(values).toHaveLength(columns.length);
    const before = body.slice(0, insert.index);
    const finalRecord = /v_audit\.id\s*:=\s*v_term_id;([\s\S]*?)UPDATE app_private\.termination_write_capabilities/.exec(before);
    expect(finalRecord, "final audit record before insert proof").not.toBeNull();
    // This is a straight-line record construction, not defaults behind IF FALSE.
    expect(finalRecord![1].replace(/v_audit\.\w+\s*:=\s*[^;]+;/g, "").trim(), "straight-line audit construction").toBe("");
    const proofStart = finalRecord!.index! + finalRecord![0].length - "UPDATE app_private.termination_write_capabilities".length;
    expect(before.slice(proofStart).replace(/\s+/g, " ").trim(), "audit proof-to-INSERT interval").toBe(
      "UPDATE app_private.termination_write_capabilities SET expected_after=to_jsonb(v_audit)-ARRAY['refund_amount','total_deductions'],phase=0 " +
      "WHERE transaction_id=pg_current_xact_id() AND backend_pid=pg_backend_pid() AND termination_id=v_term_id " +
      "AND actor_id=auth.uid() AND phase=-1; " +
      "IF NOT FOUND THEN RAISE EXCEPTION 'Missing audit insert proof' USING ERRCODE='42501'; END IF;",
    );
    // Only the proven straight-line construction supplies values. The exact
    // proof interval above cannot mutate the record or supply a dead repair.
    for (const [column, expected] of Object.entries({
      outstanding_debt: "v_debt", early_termination_fee: "v_penalty+v_extra",
      prorated_rent: "0", prorated_days: "0", prorated_services: "0",
      total_deposit: "v_deposit", rent_refund_amount: "v_owed",
    })) {
      expect(columns, `audit column ${column}`).toContain(column);
      expect(values[columns.indexOf(column)], `audit INSERT value ${column}`).toBe(`v_audit.${column}`);
      const assignments = [...finalRecord![1].matchAll(new RegExp(`\\bv_audit\\.${column}\\s*:=\\s*([^;]+);`, "gi"))];
      expect(assignments.length, `audit assignment ${column}`).toBeGreaterThan(0);
      expect(assignments.at(-1)![1].replace(/\s/g, ""), `final audit assignment ${column}`).toBe(expected);
    }
  });

  it("số quyết toán ròng cộng thêm khoản hoàn", () => {
    expect(impl()).toContain("v_S           := v_pool + v_owed - v_charges;");
    expect(impl()).toContain("v_applied     := LEAST(v_pool + v_owed, v_charges);");
  });
});

describe("hoàn lại khách — bút toán và KQKD", () => {
  const impl = () => liveBodyOf(IMPL);

  it("phần bị cấn đi qua cặp bút toán nội bộ, không đụng sổ tiền thật", () => {
    const body = impl();
    expect(body).toContain("termination.rent_refund_offset");
    expect(body).toContain("termination.rent_refund_revenue");
    // Cả hai chân đều trên sổ nội bộ v_acc_int ⇒ net 0, không ra két.
    const offset = body.slice(body.indexOf("IF v_owed_applied > 0 THEN"));
    expect(offset.slice(0, offset.indexOf("END IF;"))).not.toContain("v_acc_rcpt");
  });

  it("hạng mục hoàn tiền phòng là is_deposit=FALSE (VÀO KQKD)", () => {
    // Tiền phòng đã từng ghi doanh thu nên trả lại là giảm lãi thật. Dùng nhầm
    // loại của hoàn cọc (is_deposit=TRUE, ngoài KQKD) sẽ thổi phồng lợi nhuận.
    const body = impl();
    expect(body).toContain("'Hoàn tiền phòng thanh lý'");
    const dong = body
      .split("\n")
      .filter((l) => l.includes("v_type_rentref") && l.includes("is_deposit"));
    expect(dong.length).toBeGreaterThan(0);
    for (const l of dong) {
      expect(l, `hạng mục hoàn tiền phòng phải is_deposit=FALSE: ${l}`).toContain(
        "SET is_deposit = FALSE",
      );
    }
  });

  it("hoàn cọc vẫn là is_deposit=TRUE (NGOÀI KQKD)", () => {
    const body = impl();
    const dong = body
      .split("\n")
      .filter((l) => l.includes("v_type_dep") && l.includes("is_deposit"));
    expect(dong.length).toBeGreaterThan(0);
    for (const l of dong) expect(l).toContain("SET is_deposit = TRUE");
  });

  it("phần chi thật đi CHUNG phiếu chi hoàn, không đẻ phiếu riêng", () => {
    // get_refund_forfeit_summary cố ý lấy total_amount của CẢ phiếu vì "cả phiếu
    // là số tiền TRẢ LẠI KHÁCH", và đã gộp sẵn hoàn cọc + hoàn tiền thừa.
    const body = impl();
    expect(body).toContain(
      "IF v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN",
    );
    expect(body).toContain("v_refund_dep + v_refund_exc + v_refund_owed");
    const item = body.slice(body.indexOf("IF v_refund_owed > 0 THEN"));
    expect(item.slice(0, 600)).toContain("v_refund_voucher");
  });

  it("chỉ có đúng MỘT phiếu chi hoàn mang system_source termination.refund", () => {
    const body = impl();
    expect(body.split("'termination.refund'").length - 1).toBe(1);
  });
});

describe("hoàn lại khách — migration an toàn khi chạy lại", () => {
  const migration = readFileSync(
    join(MIG_DIR, "20260822093000_termination_customer_refund_items.sql"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("drop chữ ký cũ có IF EXISTS và create lại bằng OR REPLACE", () => {
    expect(migration).toContain("DROP FUNCTION IF EXISTS public.terminate_contract_move_out(");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_impl");
  });

  it("cột audit là cột THƯỜNG, thêm bằng IF NOT EXISTS", () => {
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS rent_refund_amount numeric(15,2) NOT NULL DEFAULT 0",
    );
    expect(migration).toContain("is_generated = 'NEVER'");
  });

  it("postflight chặn overload — PostgREST sẽ chọn nhầm nếu còn hai bản", () => {
    expect(migration).toContain("có overload");
    expect(migration).toMatch(/proname = 'terminate_contract_move_out'\)\s*<>\s*1/);
  });

  it("cấp lại ACL đúng như đo trên prod trước khi drop", () => {
    // _impl KHÔNG được mở cho authenticated; _with_credit_v1 KHÔNG có service_role.
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb) TO service_role;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb) TO authenticated;",
    );
    expect(migration).toContain("_impl không được mở cho authenticated");
  });

  it("KHÔNG đụng nhánh bỏ cọc", () => {
    expect(migration).not.toContain("terminate_contract_forfeit");
    expect(migration).not.toContain("termination.forfeit_revenue");
  });
});
