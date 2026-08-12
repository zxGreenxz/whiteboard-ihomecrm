// Sổ cho scripts/check-raw-rpc-callers.mjs.
//
// Bộ đột biến trên file thật (5 ca: thêm literal · thêm edge invoke · thêm dynamic ·
// ĐỔI slug giữ nguyên số đếm · thu hẹp risk-map ⇒ exit 3) chạy lúc dựng gate và
// đúng cả 5. Không đưa vào đây vì nó ghi đè src/hooks/useInvoices.ts.
//
// Ca "đổi slug" đáng nhắc riêng: nó là lý do ratchet so TẬP VÂN TAY chứ không so
// số đếm. Xoá một lời gọi rồi thêm một lời gọi khác trong cùng lát giữ nguyên con
// số, và một ratchet đếm sẽ để lọt.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fileRuiRoCao, phanLoai, vanTayCuaNguon } from "../check-raw-rpc-callers.mjs";

const { tiers } = JSON.parse(readFileSync(new URL("../../tooling/risk-map.json", import.meta.url), "utf8"));
const baseline = JSON.parse(readFileSync(new URL("../../tooling/raw-rpc-callers-baseline.json", import.meta.url), "utf8"));

describe("vanTayCuaNguon — bốn dạng lời gọi thô", () => {
  const v = (src) => [...vanTayCuaNguon("f.ts", src)];

  it("bắt literal ở cả ba kiểu nháy", () => {
    expect(v(`supabase.rpc("a_v1", {})`)).toContain("f.ts::a_v1");
    expect(v(`supabase.rpc('b_v1', {})`)).toContain("f.ts::b_v1");
    expect(v("supabase.rpc(`c_v1`, {})")).toContain("f.ts::c_v1");
  });

  it("bắt cả biến thể `as any` — cast không làm lời gọi biến mất", () => {
    expect(v(`supabase.rpc("d_v1" as any, {})`)).toContain("f.ts::d_v1");
  });

  it("slug là BIẾN được ghi riêng thành DYNAMIC", () => {
    // Dạng này đáng lo nhất: không grep ra được, không đổi tên an toàn được, và
    // không công cụ nào biết nó gọi cái gì. Gộp chung với literal sẽ giấu mất.
    expect(v(`supabase.rpc(tenHam, {})`)).toEqual(["f.ts::DYNAMIC:tenHam"]);
  });

  it("bắt functions.invoke của Edge", () => {
    expect(v(`supabase.functions.invoke("llm-proxy")`)).toContain("f.ts::edge:llm-proxy");
  });

  it("file không gọi gì trả tập rỗng", () => {
    expect(v("const a = 1;")).toEqual([]);
  });

  it("hai lời gọi CÙNG slug trong một file chỉ ra một vân tay", () => {
    // Vân tay là `<file>::<slug>`, không phải số lần gọi — cố ý: mục tiêu là chặn
    // bề mặt mới, không phải đếm dòng.
    expect(v(`supabase.rpc("x_v1"); supabase.rpc("x_v1");`)).toEqual(["f.ts::x_v1"]);
  });

  it("ĐÒI dấu chấm phía trước — `rpc(...)` trần là hàm cục bộ, không phải lời gọi Supabase", () => {
    // Ca này từng làm test đầu tiên của tôi đỏ, và nó đáng giữ lại đúng như vậy:
    // phạm vi hẹp ở đây là CÓ CHỦ ĐÍCH, không phải bỏ sót. Bỏ dấu chấm sẽ bắt
    // nhầm mọi hàm tên `rpc` trong repo và biến gate thành thứ hay báo sai — mà
    // gate hay báo sai thì bị tắt.
    expect(v(`function rpc(a) {}\nrpc("khong_phai_supabase");`)).toEqual([]);
    expect(v(`supabase\n  .rpc("xuong_dong_v1", {})`)).toEqual(["f.ts::xuong_dong_v1"]);
  });
});

describe("phanLoai — hai loại, và ranh giới đúng chỗ nào", () => {
  it("slug sau BIẾN và Edge invoke là loại trình biên dịch không canh được", () => {
    expect(phanLoai("f.ts::DYNAMIC:tenHam")).toBe("khong-kiem-duoc");
    expect(phanLoai("f.ts::edge:llm-proxy")).toBe("khong-kiem-duoc");
  });

  it("slug VIẾT THẲNG là loại đã được kiểu canh", () => {
    // Không phải ý kiến — đo thật 12/08/2026 bằng file thử + `tsc -p tsconfig.app.json`:
    //   supabase.rpc("khong_ton_tai_v9", {})                    → TS2345 (liệt kê 648 tên hợp lệ)
    //   supabase.rpc("profit_close_state_v2", { p_sai_ten: 1 }) → TS2353
    // Bản đầu của gate khẳng định ngược lại, và đó là lý do nó khuyên sai.
    expect(phanLoai("f.ts::profit_close_state_v2")).toBe("literal");
    expect(phanLoai("f.ts::a_v1")).toBe("literal");
  });

  it("không nhầm slug chỉ TÌNH CỜ chứa chữ dynamic/edge", () => {
    // Ranh giới là TIỀN TỐ do chính gate gắn, không phải chuỗi con. Bắt theo
    // `includes` sẽ xếp nhầm một RPC tên `edge_case_v1` vào nhóm mù kiểu.
    expect(phanLoai("f.ts::edge_case_v1")).toBe("literal");
    expect(phanLoai("f.ts::sync_dynamic_rates_v1")).toBe("literal");
  });

  it("đọc đúng khi ĐƯỜNG DẪN chứa `::` hay tên lạ", () => {
    // Cắt ở `::` ĐẦU TIÊN — phần sau mới là slug.
    expect(phanLoai("src/hooks/useX.ts::DYNAMIC:fn")).toBe("khong-kiem-duoc");
  });
});

describe("fileRuiRoCao", () => {
  it("chỉ lấy tier đòi soi chéo, không lấy docs", () => {
    const ds = fileRuiRoCao(["src/hooks/useInvoices.ts", "docs/README.md", "src/lib/permissions.ts"], tiers);
    expect(ds).toContain("src/hooks/useInvoices.ts");
    expect(ds).toContain("src/lib/permissions.ts");
    expect(ds).not.toContain("docs/README.md");
  });

  it("file không thuộc tier nào bị loại", () => {
    expect(fileRuiRoCao(["mot/duong/la.ts"], tiers)).toEqual([]);
  });
});

describe("baseline", () => {
  it("chống-xanh-rỗng: baseline không rỗng và đủ ba dạng đã đo", () => {
    // Đo 12/08/2026: 104 vân tay = 101 literal + 3 dynamic + 0 edge.
    expect(baseline.fingerprints.length).toBeGreaterThanOrEqual(90);
    expect(baseline.fingerprints.some((f) => f.includes("::DYNAMIC:"))).toBe(true);
  });

  it("chống-xanh-rỗng cho phép ĐO MỚI: cả hai loại đều có mặt để so", () => {
    // Nếu một lát nào đó gộp hai loại lại làm một, hoặc `phanLoai` xếp tất cả về
    // cùng một rổ, báo cáo tách nhóm trở thành trang trí. Ca này bắt điều đó.
    const loai = new Set(baseline.fingerprints.map(phanLoai));
    expect([...loai].sort()).toEqual(["khong-kiem-duoc", "literal"]);
  });

  it("mọi vân tay đều đúng dạng `<file>::<slug>`", () => {
    for (const f of baseline.fingerprints) {
      expect(f, `${f} sai dạng`).toMatch(/^src\/.+\.tsx?::.+$/);
    }
  });

  it("đã sắp xếp — diff của baseline phải đọc được", () => {
    expect(baseline.fingerprints).toEqual([...baseline.fingerprints].sort());
  });
});
