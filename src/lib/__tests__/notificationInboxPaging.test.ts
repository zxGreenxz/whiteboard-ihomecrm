import { describe, expect, it } from "vitest";
import {
  SO_DONG_MOI_TRANG,
  boLocHopThu,
  canDoiMoc,
  dieuKienKeyset,
  gopDongHopThu,
  mocTrangSau,
  type InboxCursor,
  type InboxRowKey,
} from "@/lib/notifications/inboxPaging";

const T1 = "2026-10-21T08:00:00.123456+00:00";
const T0 = "2026-10-21T07:00:00+00:00";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

/**
 * Bộ đánh giá tối thiểu cho đúng phần cú pháp `or=` mà keyset dùng (lt/lte/eq trên
 * created_at, lt trên id, nhóm and(...)), để kiểm DÒNG NÀO lọt chứ không chỉ so chuỗi.
 */
function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let inQuote = false;
  for (const ch of list) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote && ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    if (!inQuote && ch === "(") depth++;
    if (!inQuote && ch === ")") depth--;
    cur += ch;
  }
  return [...out, cur];
}
function holds(cond: string, row: InboxRowKey): boolean {
  if (cond.startsWith("and(")) return splitTop(cond.slice(4, -1)).every((p) => holds(p, row));
  if (cond.startsWith("or(")) return splitTop(cond.slice(3, -1)).some((p) => holds(p, row));
  const [col, op, ...rest] = cond.split(".");
  const raw = rest.join(".").replace(/^"|"$/g, "");
  const actual = col === "created_at" ? Date.parse(row.created_at) : row.id;
  const value = col === "created_at" ? Date.parse(raw) : raw;
  if (op === "lt") return actual < value;
  if (op === "lte") return actual <= value;
  if (op === "eq") return actual === value;
  throw new Error(`toán tử chưa hỗ trợ: ${op}`);
}
const loc = (cursor: InboxCursor, rows: InboxRowKey[]) => {
  const keyset = dieuKienKeyset(cursor);
  if (!keyset) return rows;
  return rows.filter((row) => splitTop(keyset).some((c) => holds(c, row)));
};

describe("keyset hộp thư", () => {
  const rows: InboxRowKey[] = [
    { id: B, created_at: T1 },
    { id: A, created_at: T1 },
    { id: "00000000-0000-4000-8000-000000000009", created_at: T0 },
  ];

  it("không có mốc ⇒ không lọc keyset, phạm vi giữ nguyên", () => {
    expect(dieuKienKeyset(null)).toBeNull();
    expect(boLocHopThu("organization_id.eq.X", null)).toBe("organization_id.eq.X");
  });

  it("trang đầu của Xem thêm lấy CẢ nhóm cùng created_at (id = null)", () => {
    expect(loc({ created_at: T1, id: null }, rows).map((r) => r.id)).toEqual([B, A, rows[2]!.id]);
  });

  it("trang sau dùng keyset chặt (created_at, id) — không lặp, không sót dòng cùng mốc", () => {
    expect(loc({ created_at: T1, id: B }, rows).map((r) => r.id)).toEqual([A, rows[2]!.id]);
    expect(loc({ created_at: T1, id: A }, rows).map((r) => r.id)).toEqual([rows[2]!.id]);
  });

  it("timestamp được bọc nháy kép (có : . +) và gộp với phạm vi thành MỘT biểu thức or", () => {
    const filter = boLocHopThu("metadata->>event.neq.LIFECYCLE,metadata->>event.is.null", { created_at: T1, id: A });
    expect(filter).toBe(
      `and(or(metadata->>event.neq.LIFECYCLE,metadata->>event.is.null),or(created_at.lt."${T1}",and(created_at.eq."${T1}",id.lt."${A}")))`,
    );
  });

  it("trang hụt ⇒ hết; trang đủ ⇒ mốc là dòng cuối", () => {
    expect(mocTrangSau(rows)).toBeUndefined();
    const full = Array.from({ length: SO_DONG_MOI_TRANG }, (_, i) => ({ id: `id-${i}`, created_at: T0 }));
    expect(mocTrangSau(full)).toEqual({ created_at: T0, id: `id-${SO_DONG_MOI_TRANG - 1}` });
  });

  it("gộp nguồn: khử trùng theo id, sắp mới trước, cùng mốc thì id lớn trước", () => {
    const merged = gopDongHopThu([{ id: A, created_at: T1 }], [{ id: B, created_at: T1 }, { id: A, created_at: T1 }], [rows[2]!]);
    expect(merged.map((r) => r.id)).toEqual([B, A, rows[2]!.id]);
  });

  it("dời mốc chỉ khi dòng cuối của top 200 MỚI HƠN mốc (dòng mới chèn lên đầu)", () => {
    const moc: InboxCursor = { created_at: T0, id: null };
    expect(canDoiMoc(moc, { id: A, created_at: T1 })).toBe(true);
    expect(canDoiMoc(moc, { id: A, created_at: T0 })).toBe(false);
    expect(canDoiMoc({ created_at: T1, id: null }, { id: A, created_at: T0 })).toBe(false);
    expect(canDoiMoc(moc, undefined)).toBe(false);
  });
});
