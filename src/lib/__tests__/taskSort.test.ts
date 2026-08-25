import { describe, it, expect } from "vitest";
import {
  sortJobs,
  defaultTaskSort,
  TASK_SORT_OPTIONS,
  taskSortLabel,
  isSameTaskSort,
  type TaskSort,
} from "../taskSort";

type Row = { id: string; deadline: string | null; created_at: string };

const mk = (id: string, deadline: string | null, created_at: string): Row => ({
  id,
  deadline,
  created_at,
});

// Bộ dữ liệu mô phỏng ảnh chụp thật: nhiều phiếu cùng hạn 23:59, vài phiếu
// không hạn, ngày tạo lệch với hạn.
const rows: Row[] = [
  mk("a", "2026-09-03T23:59:00+07:00", "2026-08-20T10:00:00+07:00"),
  mk("b", "2026-08-20T23:59:00+07:00", "2026-08-18T10:00:00+07:00"),
  mk("c", "2026-09-04T23:59:00+07:00", "2026-08-22T10:00:00+07:00"),
  mk("d", null, "2026-08-25T10:00:00+07:00"),
  mk("e", "2026-08-23T23:59:00+07:00", "2026-08-19T10:00:00+07:00"),
];

describe("sortJobs", () => {
  it("sắp theo hạn hoàn thành tăng dần (gần hết hạn trước)", () => {
    const out = sortJobs(rows, { field: "deadline", dir: "asc" });
    expect(out.map((r) => r.id)).toEqual(["b", "e", "a", "c", "d"]);
  });

  it("sắp theo hạn hoàn thành giảm dần (xa hạn nhất trước)", () => {
    const out = sortJobs(rows, { field: "deadline", dir: "desc" });
    expect(out.map((r) => r.id)).toEqual(["c", "a", "e", "b", "d"]);
  });

  it("việc KHÔNG có hạn luôn nằm cuối ở CẢ hai chiều", () => {
    for (const dir of ["asc", "desc"] as const) {
      const out = sortJobs(rows, { field: "deadline", dir });
      expect(out[out.length - 1].id).toBe("d");
    }
  });

  it("sắp theo ngày tạo, mặc định là mới nhất trước", () => {
    expect(defaultTaskSort).toEqual({ field: "created_at", dir: "desc" });
    expect(sortJobs(rows, defaultTaskSort).map((r) => r.id)).toEqual([
      "d",
      "c",
      "a",
      "e",
      "b",
    ]);
    expect(sortJobs(rows, { field: "created_at", dir: "asc" }).map((r) => r.id)).toEqual([
      "b",
      "e",
      "a",
      "c",
      "d",
    ]);
  });

  it("cùng hạn thì phá hoà ổn định: created_at giảm dần rồi tới id", () => {
    const same: Row[] = [
      mk("z", "2026-08-23T23:59:00+07:00", "2026-08-01T10:00:00+07:00"),
      mk("y", "2026-08-23T23:59:00+07:00", "2026-08-05T10:00:00+07:00"),
      mk("x", "2026-08-23T23:59:00+07:00", "2026-08-05T10:00:00+07:00"),
    ];
    const out = sortJobs(same, { field: "deadline", dir: "asc" });
    // y và x cùng created_at ⇒ id nhỏ hơn trước; z tạo sớm nhất nên xuống cuối.
    expect(out.map((r) => r.id)).toEqual(["x", "y", "z"]);
    // Chạy lại trên mảng đã sắp phải ra y hệt (idempotent ⇒ không nhảy khi re-render).
    expect(sortJobs(out, { field: "deadline", dir: "asc" }).map((r) => r.id)).toEqual([
      "x",
      "y",
      "z",
    ]);
  });

  it("không sửa mảng đầu vào", () => {
    const before = rows.map((r) => r.id);
    sortJobs(rows, { field: "deadline", dir: "asc" });
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("chịu được deadline/created_at hỏng — coi như không có, không ném lỗi", () => {
    const dirty: Row[] = [
      mk("ok", "2026-08-23T23:59:00+07:00", "2026-08-01T10:00:00+07:00"),
      mk("bad", "khong-phai-ngay", "cung-khong-phai-ngay"),
    ];
    const out = sortJobs(dirty, { field: "deadline", dir: "asc" });
    expect(out.map((r) => r.id)).toEqual(["ok", "bad"]);
  });

  it("4 lựa chọn menu là duy nhất và có nhãn riêng", () => {
    const labels = TASK_SORT_OPTIONS.map(taskSortLabel);
    expect(new Set(labels).size).toBe(TASK_SORT_OPTIONS.length);
    expect(TASK_SORT_OPTIONS.some((o: TaskSort) => isSameTaskSort(o, defaultTaskSort))).toBe(true);
  });
});
