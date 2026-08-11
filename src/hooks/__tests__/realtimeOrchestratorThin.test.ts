// Ranh giới giữa ORCHESTRATOR và DESCRIPTOR của hệ realtime.
//
// Thiết kế (plan P1-14): descriptor khai theo miền — bảng nào đổi thì invalidate
// query key nào — còn hub chỉ điều phối: mở channel, gom sự kiện, debounce, dọn.
//
// Vì sao cần ghim bằng test: ranh giới này không có gì cưỡng chế. Thêm một `if
// (entry.table === "invoices")` vào hub là cách sửa nhanh nhất khi vội, và mỗi
// lần như vậy hub lại biết thêm một chút về nghiệp vụ. Sau vài lần thì descriptor
// không còn là nguồn sự thật, mà là nửa nguồn sự thật — loại tệ nhất, vì người
// đọc vẫn tin nó đủ.
//
// Ba khẳng định dưới đây cố ý ĐO ĐƯỢC chứ không phải cảm tính, và mỗi cái kèm
// mốc đã đo ngày 11/08/2026.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SYNC_ENTRIES } from "@/hooks/realtime";
import { REALTIME_SYNC_TABLES } from "@/lib/realtime/syncTables";

const doc = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const HUB = doc("../useRealtimeDataSync.ts");

describe("hub realtime giữ vai điều phối", () => {
  it("hub KHÔNG nhắc tên bảng nghiệp vụ nào — tên bảng thuộc về descriptor", () => {
    // Đây là phép đo trực tiếp của "mỏng": hub biết cách CHẠY, không biết CHẠY GÌ.
    const nhacTen = REALTIME_SYNC_TABLES.filter((t) => HUB.includes(`"${t}"`) || HUB.includes(`'${t}'`));
    expect(nhacTen, `hub nhắc thẳng tên bảng: ${nhacTen.join(", ")}`).toEqual([]);
  });

  it("hub KHÔNG chứa query key nghiệp vụ — invalidate là việc của descriptor", () => {
    const key = [...new Set(SYNC_ENTRIES.flatMap((e) => e.keys.map((k) => String(k[0]))))];
    const nhacKey = key.filter((k) => HUB.includes(`"${k}"`) || HUB.includes(`'${k}'`));
    // `business-performance` là ngoại lệ ĐÃ BIẾT: hub gom nhiều bảng vào một lượt
    // làm mới báo cáo, nên nó buộc phải biết tên nhóm đó. Khai tường minh ở đây
    // thay vì nới khẳng định — một ngoại lệ có tên thì cãi được.
    expect(nhacKey).toEqual(["business-performance"]);
  });

  it("hub đủ ngắn để đọc hết trong một lượt (đo 11/08/2026: 168 dòng)", () => {
    // Không phải luật thẩm mỹ: ngưỡng 260 để một lần phình 50% thì đỏ, còn sửa
    // bình thường thì không. Vượt ngưỡng nghĩa là có logic nghiệp vụ trôi vào —
    // đọc lại xem nó thuộc descriptor nào.
    expect(HUB.split(/\r?\n/).length).toBeLessThan(260);
  });
});

describe("descriptor là nguồn sự thật", () => {
  it("mỗi bảng trong danh sách chuẩn có đúng MỘT descriptor", () => {
    const dem = new Map<string, number>();
    for (const e of SYNC_ENTRIES) dem.set(e.table, (dem.get(e.table) ?? 0) + 1);
    expect([...dem.entries()].filter(([, n]) => n > 1)).toEqual([]);
    expect(dem.size).toBe(REALTIME_SYNC_TABLES.length);
  });

  it("không descriptor nào rỗng key — khai một bảng rồi không invalidate gì là subscribe câm", () => {
    for (const e of SYNC_ENTRIES) {
      expect(e.keys.length, `${e.table} không có key nào`).toBeGreaterThan(0);
    }
  });

  it("chống-xanh-rỗng: có ít nhất 13 bảng và 3 file miền", () => {
    expect(REALTIME_SYNC_TABLES.length).toBeGreaterThanOrEqual(13);
    for (const f of ["contracts", "finance", "operations"]) {
      expect(doc(`../realtime/${f}.ts`).length).toBeGreaterThan(200);
    }
  });
});
