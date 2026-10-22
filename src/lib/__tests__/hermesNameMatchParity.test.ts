import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJobQuickInput } from "../jobQuickInput";

// Bộ vector giải tên dùng chung với hàm SQL public.hermes_write_name_resolve_v1 (D7, Hermes Đợt 1 nền chung;
// infra/hermes-broker/name-match-vectors.json, kiểm SQL ở infra/hermes-broker/write-name-resolve-sql.test.mjs).
// Ca có web=true: bộ nhập nhanh Công việc của web phải cho đúng kết quả mà hàm SQL cho. Ca web=false là chỗ web
// còn hẹp hơn (giữ dấu khi so toà/phòng, khớp một token, không tên thường gọi); khi web chuyển sang gọi hàm SQL
// thì bỏ cờ này. Đổi luật khớp ở một phía mà quên phía kia ⇒ test này hoặc test SQL đỏ.
type Vector = { field: string; wanted: string; building?: string; expect?: string; why?: string; web: boolean };
type Entry = { key: string; name: string; code?: string | null; building?: string; deleted?: boolean; virtual?: boolean; active?: boolean };
const vectors = JSON.parse(readFileSync(new URL("../../../infra/hermes-broker/name-match-vectors.json", import.meta.url), "utf8")) as {
  buildings: Entry[]; rooms: Entry[]; jobTypes: Entry[]; cases: Vector[];
};
// Web chỉ nạp toà/phòng còn hoạt động và loại việc đang bật (như hàm SQL lọc).
const buildings = vectors.buildings.filter((b) => !b.deleted && !b.virtual).map((b) => ({ id: b.key, name: b.name, code: b.code ?? null }));
const rooms = vectors.rooms.filter((r) => !r.deleted).map((r) => ({ id: r.key, name: r.name, code: r.code ?? null, building_id: r.building ?? null }));
const jobTypes = vectors.jobTypes.filter((j) => j.active !== false).map((j) => ({ id: j.key, name: j.name }));
const nameOf = (key: string) => vectors.buildings.find((b) => b.key === key)?.name ?? key;
const today = new Date("2026-10-21T10:00:00+07:00");

describe("Hermes name-match vectors (web parity)", () => {
  const webCases = vectors.cases.filter((c) => c.web);
  it("has web-applicable cases for buildings, rooms and job types", () => {
    expect(new Set(webCases.map((c) => c.field))).toEqual(new Set(["building", "room", "jobType"]));
  });
  for (const c of webCases) {
    it(`${c.field} '${c.wanted}' ⇒ ${c.expect ?? c.why}`, () => {
      // Câu nhập nhanh: "<phòng> <toà> <loại việc> <mô tả>"; "tn" = cả toà.
      const text = c.field === "building" ? `tn ${c.wanted} Sửa kiểm tra`
        : c.field === "room" ? `${c.wanted} ${nameOf(c.building ?? "")} Sửa kiểm tra`
        : `tn 1392QT ${c.wanted} kiểm tra`;
      const parsed = parseJobQuickInput(text, today, buildings, rooms, jobTypes);
      const got = c.field === "building" ? parsed.buildingId : c.field === "room" ? parsed.roomId : parsed.jobTypeId;
      expect(got ?? null).toBe(c.expect ?? null);
    });
  }
});
