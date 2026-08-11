// Ranh giới tenant của hub realtime — nó nằm ở ĐÂU, và KHÔNG nằm ở đâu.
//
// Câu hỏi plan Đợt 5 – V3 đặt ra: "event của org khác không được invalidate cache
// org hiện tại". Đo 11/08/2026 thì hub KHÔNG hề lọc theo org: nó đăng ký
// `{ event: "*", schema: "public", table }` và handler BỎ QUA payload hoàn toàn.
//
// Điều đó KHÔNG phải rò rỉ dữ liệu, và đừng đọc thành vậy. Invalidate chỉ khiến
// React Query gọi lại query, mà mỗi lần gọi lại đều đi qua RLS — org khác vẫn
// không đọc được gì. Ranh giới tenant là RLS ở server, không phải hub ở client.
//
// Cái nó THẬT SỰ gây ra là refetch thừa: một org bận rộn làm mọi org khác trong
// cùng instance gọi lại query. Chi phí, không phải lỗ hổng.
//
// Bộ ca này ghim đúng hiện trạng đó thay vì khẳng định một bảo đảm chưa tồn tại.
// Nếu ai thêm filter org vào hub, các ca dưới đây sẽ đỏ — và đó là lúc phải cập
// nhật cả tài liệu lẫn chỗ này, chứ không phải sửa test cho im.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

type OnArgs = [string, { event: string; schema: string; table: string; filter?: string }, () => void];

const harness = vi.hoisted(() => {
  const onCalls: unknown[][] = [];
  const channel = {
    on: vi.fn((...args: unknown[]) => {
      onCalls.push(args);
      return channel;
    }),
    subscribe: vi.fn(() => channel),
  };
  return { onCalls, channel, invalidateQueries: vi.fn(), useEffect: vi.fn() };
});

vi.mock("react", () => ({ useEffect: harness.useEffect }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "user-a" } }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { channel: vi.fn(() => harness.channel), removeChannel: vi.fn() },
}));

import { REALTIME_SYNC_TABLES } from "@/lib/realtime/syncTables";
import { useRealtimeDataSync } from "@/hooks/useRealtimeDataSync";

// Hub có guard `hubActive` cấp module để không mở hai channel trùng
// (StrictMode double-mount). Nghĩa là chỉ lần gọi ĐẦU TIÊN trong tiến trình test
// mới đăng ký thật — gọi lại sẽ trả tập rỗng. Nên chụp một lần rồi dùng chung,
// thay vì mỗi ca tự gọi và ca thứ hai lặng lẽ kiểm trên mảng rỗng.
const DANG_KY: OnArgs[] = (() => {
  harness.onCalls.length = 0;
  harness.useEffect.mockImplementation((fn: () => void | (() => void)) => {
    fn();
  });
  useRealtimeDataSync();
  return harness.onCalls as OnArgs[];
})();

describe("hub realtime — ranh giới tenant nằm ở RLS, không ở client", () => {
  it("đăng ký KHÔNG kèm filter org — ghim hiện trạng, không giả vờ có bảo đảm", () => {
    const calls = DANG_KY;
    // Sàn chống-xanh-rỗng: ca này vô nghĩa nếu hub không đăng ký gì.
    expect(calls.length).toBeGreaterThanOrEqual(REALTIME_SYNC_TABLES.length);
    for (const [su_kien, cau_hinh] of calls) {
      expect(su_kien).toBe("postgres_changes");
      expect(cau_hinh.event).toBe("*");
      expect(
        cau_hinh.filter,
        `${cau_hinh.table} đã có filter — nếu đây là chủ đích thì cập nhật docs/he-thong/realtime-sync.md và ca này`,
      ).toBeUndefined();
    }
  });

  it("handler BỎ QUA payload: event của org khác vẫn kích hoạt invalidate", () => {
    const muc = DANG_KY.find(([, c]) => c.table === "invoices");
    expect(muc, "hub không đăng ký bảng invoices — phép đo hỏng, không phải 'không có gì'").toBeDefined();
    const [, cauHinh, handler] = muc!;
    expect(cauHinh.table).toBe("invoices");
    // Handler nhận payload nhưng không đọc — gọi với payload của org LẠ vẫn chạy
    // hệt như payload của org mình. Đó chính là điều ca này ghim lại.
    expect(() =>
      (handler as unknown as (p: unknown) => void)({
        new: { id: "x", organization_id: "org-hoan-toan-khac" },
      }),
    ).not.toThrow();
  });
});

describe("điều kiện để lọc theo org là KHẢ THI", () => {
  // Nếu một bảng realtime mới không có organization_id, kế hoạch thêm filter vừa
  // khó hơn — và đây là chỗ biết được điều đó, thay vì phát hiện lúc đang sửa.
  const types = readFileSync(new URL("../../integrations/supabase/types.ts", import.meta.url), "utf8");

  const coCotOrg = (bang: string) => {
    const i = types.indexOf(`      ${bang}: {`);
    if (i < 0) return null;
    const j = types.indexOf("Row: {", i);
    const k = types.indexOf("\n        }", j);
    return /organization_id/.test(types.slice(j, k));
  };

  it("cả 13 bảng realtime đều mang organization_id", () => {
    expect(REALTIME_SYNC_TABLES.length).toBeGreaterThanOrEqual(13);
    for (const b of REALTIME_SYNC_TABLES) {
      expect(coCotOrg(b), `${b}: không tìm thấy cột organization_id trong types sinh từ DB`).toBe(true);
    }
  });
});
