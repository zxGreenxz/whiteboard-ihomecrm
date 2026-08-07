// Guard TĨNH cho bất biến: "lương tính theo THỜI ĐIỂM HOÀN THÀNH, không phải
// thời điểm TẠO công việc" (audit 2026-07-20).
//
// Quyết định nằm 100% trong plpgsql nên vitest không chạy được logic thật —
// thay vào đó ta đọc file migration và chốt hình dạng của biểu thức ngày.
// Test tích hợp thật (seed job qua ranh giới tháng rồi gọi salary_work_ledger)
// nằm ở scripts/check-salary-completion-date.mjs — chạy trên org DEMO.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");

/**
 * Bỏ comment `-- ...` — các migration mô tả LỖI CŨ trong phần header (kèm cả
 * đoạn SQL sai để đối chiếu), nên nếu quét cả comment thì guard sẽ báo động giả.
 */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

/**
 * Đọc + bóc comment TOÀN BỘ migration đúng MỘT lần cho cả file test.
 *
 * Trước đây `liveDefinitionOf` quét lại từ đầu ở MỖI lời gọi: 627 file × ~8 ca
 * test = hơn 5.000 lượt đọc đĩa. Nó chạy được khi repo còn ít migration, rồi
 * lặng lẽ chạm trần: đo 07/08/2026 một ca mất 9.595 ms trong khi timeout mặc
 * định của vitest là 5.000 ms — test ĐỎ vì HẾT GIỜ, không phải vì bất biến bị
 * vi phạm. Kiểu đỏ đó tệ hơn đỏ thật: nó dạy người ta rằng file test này "hay
 * lỗi vặt", và lần bất biến hỏng thật cũng sẽ bị bỏ qua.
 *
 * Nới timeout thì che triệu chứng; đệm lại thì bỏ hẳn nguyên nhân, và số
 * migration còn tăng tiếp.
 */
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

/** Định nghĩa SỐNG của một hàm = lần CREATE cuối cùng theo thứ tự timestamp. */
function liveDefinitionOf(fnName: string): { file: string; sql: string } {
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`, "i");
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) {
    if (re.test(m.sql)) hit = m;
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của public.${fnName}`);
  return hit;
}

describe("bất biến: engine lương đọc completion_time, KHÔNG đọc created_at", () => {
  // Các hàm quyết định TIỀN hoặc NGÀY CÔNG từ một dòng jobs.
  const MONEY_FNS = ["salary_work_ledger", "award_job_bonus", "v5_tick_from_job"];

  it.each(MONEY_FNS)("%s không bucket theo j.created_at", (fn) => {
    const { file, sql } = liveDefinitionOf(fn);
    // Bắt cả `vn_local_date(j.created_at)` lẫn fallback
    // `COALESCE(j.completion_time, j.created_at)` — sau migration
    // 20260720181000 đã có CHECK bảo đảm COMPLETED ⇒ completion_time NOT NULL,
    // nên fallback là code chết và phải bị gỡ để lỗi nổ to.
    const offenders = [
      /vn_local_(date|dow|time)\s*\(\s*[a-z_]*\.?created_at/i,
      /COALESCE\s*\(\s*[a-z_]*\.?completion_time\s*,\s*[a-z_]*\.?created_at/i,
    ];
    for (const re of offenders) {
      expect(
        re.test(sql),
        `${file}: public.${fn} còn dùng created_at làm mốc tính lương (${re}). ` +
          `Lương phải tính theo jobs.completion_time — xem audit 2026-07-20.`,
      ).toBe(false);
    }
  });

  it.each(MONEY_FNS)("%s vẫn neo múi giờ VN qua vn_local_*", (fn) => {
    const { file, sql } = liveDefinitionOf(fn);
    expect(
      /vn_local_(date|time|dow)\s*\(/.test(sql),
      `${file}: public.${fn} không còn gọi vn_local_* — ép kiểu ::date trần sẽ ` +
        `dùng giờ UTC và đẩy việc làm đêm sang ngày/tháng khác.`,
    ).toBe(true);
  });

  it("jobs có CHECK bắt buộc completion_time khi COMPLETED", () => {
    const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    const found = files.some((f) =>
      /jobs_completed_needs_completion_time/.test(readFileSync(join(MIG_DIR, f), "utf8")),
    );
    expect(found, "Thiếu constraint jobs_completed_needs_completion_time").toBe(true);
  });

  it("có trigger đóng dấu completion_time phía server", () => {
    const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    const found = files.some((f) =>
      /trigger_jobs_stamp_completion_time/.test(readFileSync(join(MIG_DIR, f), "utf8")),
    );
    expect(
      found,
      "Thiếu trigger jobs_stamp_completion_time — thiếu nó thì client tự đặt giờ hoàn thành được.",
    ).toBe(true);
  });
});

describe("bất biến: FE không được tự gửi completion_time", () => {
  it("useCompleteJob không gửi completion_time lên server", () => {
    const src = readFileSync(join(process.cwd(), "src", "hooks", "useJobs.ts"), "utf8");
    const completeBlock = src.slice(src.indexOf("useCompleteJob"));
    expect(
      /completion_time\s*:/.test(completeBlock),
      "useJobs.ts gửi completion_time — server phải là nơi duy nhất đóng dấu mốc này.",
    ).toBe(false);
  });

  it("cổng ảnh chấp nhận cả attachments lẫn completion_attachments", () => {
    const { file, sql } = liveDefinitionOf("salary_work_ledger");
    expect(
      /job_photo_ok\s*\(/.test(sql),
      `${file}: salary_work_ledger không dùng job_photo_ok — FE ghi ảnh vào ` +
        `jobs.attachments nên gate chỉ đọc completion_attachments sẽ trả has_photo=false ` +
        `cho 100% việc, và bật requirePhoto sẽ đưa mọi khoản thưởng về 0đ.`,
    ).toBe(true);
  });
});
