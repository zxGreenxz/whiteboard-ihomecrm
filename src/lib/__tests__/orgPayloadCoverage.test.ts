import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Cửa chặn: MỌI lệnh ghi thẳng (`.insert(` / `.upsert(`) phía client vào 33
 * bảng có trigger autofill_org_strict phải gửi `organization_id`.
 *
 * Migration 20260915144656 (plan I3) làm trigger fail-closed: người thuộc hai
 * tổ chức mà payload thiếu organization_id thì INSERT nổ 23502. Test này quét
 * mã nguồn thay vì tin từng hook nhớ bọc — một chỗ mới quên là cả màn đó chết
 * với tài khoản hệ thống, mà unit test của hook mới thì chưa chắc có.
 *
 * Được coi là ĐÃ GỬI khi đối số của insert/upsert:
 *   - bắt đầu bằng `withOrg(` / `withOrgAll(` (src/lib/orgPayload.ts), hoặc
 *   - tự chứa `organization_id` (đường ghi suy org từ cha, vd phiếu lương).
 */
const BANG = [
  "accounts", "assets", "building_fee_accounts", "building_services",
  "contract_customers", "contract_extensions", "contract_services",
  "contract_tenants", "contract_terminations", "contract_transfers", "contracts",
  "customers", "deposits", "document_templates", "excess_amounts", "floors",
  "income_expense_batch_items", "income_expense_batches", "income_expense_items",
  "income_expense_types", "income_expenses", "invoice_items", "invoices", "jobs",
  "leads", "meter_readings", "meters", "payments", "rooms", "salary_streak_state",
  "services", "tenants", "vehicles",
] as const;

/**
 * File đang do plan khác sửa song song (rà soát 15/09) — gỡ khỏi đây ngay khi
 * nhánh đó gộp xong. Mỗi dòng phải có lý do; không phải danh sách cho qua.
 */
const MIEN_TRU: ReadonlyArray<{ file: string; ly_do: string }> = [
];

const SRC = join(process.cwd(), "src");
const FROM_RE = new RegExp(`\\.from\\(\\s*['"](${BANG.join("|")})['"]\\s*\\)`, "g");

function* duyetTs(dir: string): Generator<string> {
  for (const ten of readdirSync(dir)) {
    const p = join(dir, ten);
    if (statSync(p).isDirectory()) {
      if (ten === "__tests__" || ten === "node_modules") continue;
      yield* duyetTs(p);
    } else if (/\.tsx?$/.test(ten) && !/\.(test|spec)\.tsx?$/.test(ten) && !ten.endsWith(".d.ts")) {
      yield p;
    }
  }
}

/** Đối số của lời gọi bắt đầu tại `moTai` (vị trí ngay sau dấu `(`). */
function docDoiSo(text: string, moTai: number): string {
  let sau = 1;
  for (let i = moTai; i < text.length; i++) {
    const c = text[i];
    if (c === "(") sau++;
    else if (c === ")") {
      sau--;
      if (sau === 0) return text.slice(moTai, i);
    }
  }
  return text.slice(moTai);
}

interface DiemGhi { file: string; dong: number; bang: string; lenh: string; doiSo: string }

export function quetDiemGhi(root = SRC): DiemGhi[] {
  const ra: DiemGhi[] = [];
  for (const file of duyetTs(root)) {
    const text = readFileSync(file, "utf8");
    FROM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FROM_RE.exec(text)) !== null) {
      // Chuỗi gọi kết thúc ở dấu `;` đầu tiên sau `.from(...)`.
      const ket = text.indexOf(";", m.index);
      const chuoi = text.slice(m.index, ket === -1 ? undefined : ket);
      const lenh = /\.(insert|upsert)\(/.exec(chuoi);
      if (!lenh) continue;
      const moTai = m.index + lenh.index + lenh[0].length;
      ra.push({
        file: relative(process.cwd(), file).replace(/\\/g, "/"),
        dong: text.slice(0, m.index).split("\n").length,
        bang: m[1],
        lenh: lenh[1],
        doiSo: docDoiSo(text, moTai).trim(),
      });
    }
  }
  return ra;
}

export function daGuiOrg(doiSo: string): boolean {
  return /^withOrg(All)?\(/.test(doiSo) || /\borganization_id\b/.test(doiSo);
}

describe("mọi insert/upsert client vào 33 bảng có trigger autofill_org_strict phải gửi organization_id", () => {
  const diem = quetDiemGhi();

  it("bộ quét còn thấy đường ghi (chống xanh-rỗng)", () => {
    // Đo 16/09/2026: 45 điểm ghi trên 17 file. Sàn 30 để bộ dò hỏng thì đỏ,
    // không phải để khớp con số.
    expect(diem.length).toBeGreaterThanOrEqual(30);
  });

  it("không còn điểm ghi nào thiếu organization_id ngoài danh sách miễn trừ", () => {
    const mienTru = new Set(MIEN_TRU.map((m) => m.file));
    const thieu = diem
      .filter((d) => !mienTru.has(d.file) && !daGuiOrg(d.doiSo))
      .map((d) => `${d.file}:${d.dong} ${d.lenh}(${d.bang})`);
    expect(thieu).toEqual([]);
  });

  it("miễn trừ chỉ giữ file còn thật sự thiếu — đã bọc thì phải gỡ khỏi danh sách", () => {
    for (const m of MIEN_TRU) {
      const conThieu = diem.some((d) => d.file === m.file && !daGuiOrg(d.doiSo));
      expect(conThieu, `${m.file} đã gửi organization_id đủ; gỡ khỏi MIEN_TRU`).toBe(true);
    }
  });
});
