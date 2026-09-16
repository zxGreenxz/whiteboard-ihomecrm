// Guard TĨNH cho đợt "Cọc & thanh lý" (plan con H2 · rà soát 15/09/2026).
//
// Bốn lỗi được vá đều nằm trong plpgsql nên vitest không chạy được logic thật.
// File này chốt HÌNH DẠNG của định nghĩa ĐANG CHẠY — và chỉ của định nghĩa đang
// chạy: mọi khẳng định đo lần CREATE cuối cùng trên toàn thư mục migration, chứ
// không ghim một file (xem scripts/check-migration-test-liveness.mjs).
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
      .map((f) => ({
        file: f,
        sql: stripComments(readFileSync(join(MIG_DIR, f), "utf8")),
      }));
  }
  return corpusCache;
}

const createRe = (fnName: string) =>
  new RegExp(
    "CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\." + fnName + "\\s*\\(",
    "i",
  );

/** Định nghĩa SỐNG của một hàm = lần CREATE cuối cùng theo thứ tự timestamp. */
function liveDefinitionOf(fnName: string): { file: string; sql: string } {
  const re = createRe(fnName);
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
  const start = sql.search(createRe(fnName));
  const rest = sql.slice(start);
  const end = rest.indexOf("$function$", rest.indexOf("$function$") + 10);
  return end === -1 ? rest : rest.slice(0, end + 10);
}

const SETTLE = "settle_previous_debt_sources";
const RECOMPUTE = "recompute_contract_deposit_paid";
const APPROVE = "approve_contract_termination_v1";
const IMPL = "terminate_contract_move_out_impl";

describe("H2 — định nghĩa sống nằm trong migration, cắt được đúng thân hàm", () => {
  it.each([SETTLE, RECOMPUTE, APPROVE, IMPL])(
    "%s có định nghĩa cắt được bằng $function$",
    (fn) => {
      const body = liveBodyOf(fn);
      expect(body.startsWith("CREATE")).toBe(true);
      expect(body.endsWith("$function$")).toBe(true);
    },
  );
});

describe("H2.1 — nợ cọc kéo sang hoá đơn không ghi tay contracts.deposit_paid", () => {
  it("không còn UPDATE contracts ... deposit_paid trong trigger tất toán", () => {
    // deposit_paid là số DẪN XUẤT (contract_deposit_paid_derived). Trigger này
    // SECURITY DEFINER nên nó lách được a00_guard_contract_deposit_paid — guard
    // chỉ chặn current_user IN ('authenticated','anon'). Ghi tay ở đây tạo ra
    // cọc không có phiếu nào đứng sau, và lần recompute kế tiếp xoá nó đi.
    const body = liveBodyOf(SETTLE);
    expect(body).not.toMatch(/UPDATE\s+public\.contracts/i);
    expect(body).not.toMatch(/deposit_paid\s*=/i);
  });

  it("nhánh 'deposit' vẫn được nhận diện và bỏ qua tường minh", () => {
    // Bỏ hẳn ELSIF sẽ khiến người đọc sau tưởng là quên; giữ nhánh + CONTINUE
    // nói rõ đây là quyết định.
    expect(liveBodyOf(SETTLE)).toMatch(/src_type\s*=\s*'deposit'/i);
  });

  it("nhánh 'invoice' chỉ đụng hoá đơn CÙNG tổ chức", () => {
    // previous_debt_sources là jsonb do client dựng: không chặn org thì một
    // payload trỏ sang id hoá đơn của công ty khác vẫn được ghi chú + recompute.
    expect(liveBodyOf(SETTLE)).toMatch(/organization_id\s*=\s*NEW\.organization_id/i);
  });
});

describe("H2.2 — recompute cọc luôn ghi lại, kể cả khi hết phiếu", () => {
  it("không còn early-return khi đếm phiếu bằng 0", () => {
    // Gỡ liên kết phiếu cọc CUỐI CÙNG ⇒ v_count_any = 0 ⇒ hàm trả về sớm và
    // deposit_paid cũ ở lại. Số cọc đó thành tiền hoàn thật ở màn thanh lý.
    expect(liveBodyOf(RECOMPUTE)).not.toMatch(/v_count_any/i);
  });

  it("luôn đặt deposit_paid bằng contract_deposit_paid_derived", () => {
    // Chuyển về từ ieWriterDepositReconcileMigration.test.ts 15/09/2026: ở đó
    // nó đo file 20260729120000 đã đóng băng, tức đo một bản đã bị thay.
    const body = liveBodyOf(RECOMPUTE);
    expect(body).toMatch(
      /v_total\s*:=\s*public\.contract_deposit_paid_derived\(p_contract_id\);/i,
    );
    expect(body).toMatch(/SET\s+deposit_paid\s*=\s*v_total/i);
    // Vẫn chỉ ghi khi số thật sự đổi — tránh bump updated_at vô cớ và tránh
    // đánh thức các trigger dây chuyền trên contracts.
    expect(body).toMatch(/deposit_paid IS DISTINCT FROM v_total/i);
  });
});

describe("H2.3 — duyệt thanh lý: cap theo cọc thật, có amount, không cướp phòng", () => {
  const approve = () => liveBodyOf(APPROVE);

  it("kẹp số hoàn theo cọc THỰC NHẬN, không tin cột GENERATED", () => {
    // refund_amount = total_deposit − khấu trừ. total_deposit là cọc THOẢ THUẬN
    // trên hồ sơ, không phải cọc đã vào két. Khách ký cọc 10tr mà mới đóng 4tr
    // thì phiếu hoàn vẫn ghi theo 10tr.
    const body = approve();
    expect(body).toMatch(/contract_deposit_paid_derived\s*\(/i);
    expect(body).toMatch(/v_refund\s*:=\s*v_deposit_real\s*;/i);
  });

  it("item phiếu hoàn truyền amount tường minh", () => {
    // Hiện item sống nhờ trigger auto_calc_item_amount ghi đè amount. Trigger đó
    // là mục H3.1; call-site phải đúng trước để lúc trigger thôi ghi đè thì
    // không có phiếu nào amount NULL.
    const body = approve();
    const insert = body.slice(body.indexOf("insert into public.income_expense_items"));
    expect(insert).toMatch(/quantity,\s*unit_price,\s*amount/i);
  });

  it("trả phòng dùng đúng predicate NOT EXISTS của trigger trạng thái phòng", () => {
    // update rooms set status='AVAILABLE' vô điều kiện sẽ xoá cả RESERVED (cọc
    // giữ chỗ của khách kế) lẫn OCCUPIED của hợp đồng còn hiệu lực khác.
    const body = approve();
    const step5 = body.slice(body.indexOf("update public.rooms"));
    expect(step5.length).toBeGreaterThan(0);
    expect(step5).toMatch(/not exists/i);
    expect(step5).toMatch(/status in \('ACTIVE',\s*'EXTENDED'\)/i);
  });

  it("gọi lại recompute_room_reservation để phục hồi cờ RESERVED", () => {
    expect(approve()).toMatch(/recompute_room_reservation\s*\(/i);
  });
});

describe("H2.4 — thanh lý trả phòng không nuốt lỗi ghi audit", () => {
  it("không còn EXCEPTION WHEN OTHERS trong terminate_contract_move_out_impl", () => {
    // Audit best-effort nghĩa là: hợp đồng ĐÃ TERMINATED, phiếu tiền ĐÃ ghi, mà
    // contract_terminations không có dòng nào — đúng lớp lỗi đã vá cho
    // transfer_room ở 20260731050000.
    expect(liveBodyOf(IMPL)).not.toMatch(/EXCEPTION\s+WHEN\s+OTHERS/i);
  });

  it("INSERT contract_terminations vẫn nằm trong luồng chính", () => {
    expect(liveBodyOf(IMPL)).toMatch(/INSERT INTO contract_terminations/i);
  });
});
