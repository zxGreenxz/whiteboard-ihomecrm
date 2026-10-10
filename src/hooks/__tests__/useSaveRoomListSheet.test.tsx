// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Giả lập chuỗi supabase.from(t).update(p).eq("id", id).select(cols).single(): ghi lại lệnh, trả dòng theo `reply`.
const m = vi.hoisted(() => ({
  calls: [] as { table: string; patch: Record<string, unknown>; id: string; select: string }[],
  reply: (_table: string, patch: Record<string, unknown>, id: string): { data: unknown; error: unknown } => ({ data: { id, ...patch }, error: null }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => ({
          select: (select: string) => ({
            single: async () => { m.calls.push({ table, patch, id, select }); return m.reply(table, patch, id); },
          }),
        }),
      }),
    }),
  },
}));

import { RoomListSheetSaveError, sheetCellKeys, useSaveRoomListSheet } from "../useSaveRoomListSheet";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>{children}</QueryClientProvider>
);

describe("useSaveRoomListSheet", () => {
  beforeEach(() => {
    m.calls = [];
    m.reply = (_t, patch, id) => ({ data: { id, ...patch }, error: null });
  });

  it("mỗi phòng một lệnh với đúng các cột đổi; trả khoá ô đã xác nhận", async () => {
    const { result } = renderHook(() => useSaveRoomListSheet(), { wrapper });
    const saved = await result.current.mutateAsync({
      buildings: [{ id: "b1", phone: "0901 234 567" }],
      rooms: [
        { id: "r1", rentPrice: 4800000, area: 25, roomType: "Gác", amenities: ["Máy lạnh"], saleStatusNote: "Trống từ 5/11", saleStatusKey: "k1" },
        { id: "r2", saleNote: null },
      ],
    });
    expect(m.calls.map((c) => [c.table, c.id, c.patch])).toEqual([
      ["buildings", "b1", { public_contact_phone: "0901 234 567" }],
      ["rooms", "r1", { rent_price: 4800000, area: 25, room_type: "Gác", amenities: ["Máy lạnh"], sale_status_note: "Trống từ 5/11", sale_status_note_key: "k1" }],
      ["rooms", "r2", { sale_note: null }],
    ]);
    expect(saved).toEqual(["phone:b1", "price:r1", "type:r1", "amenities:r1", "status:r1", "policy:r2"]);
  });

  const changes = { buildings: [{ id: "b1", phone: null }], rooms: [{ id: "r1", rentPrice: 4800000 }, { id: "r2", saleNote: "x" }] };

  it("phòng đầu lưu xong, phòng sau bị từ chối → giữ khoá ô đã lưu, báo tổng số ô", async () => {
    m.reply = (_t, patch, id) => (id === "r2" ? { data: null, error: { code: "42501", message: "denied" } } : { data: { id, ...patch }, error: null });
    const { result } = renderHook(() => useSaveRoomListSheet(), { wrapper });
    expect(sheetCellKeys(changes)).toEqual(["phone:b1", "price:r1", "policy:r2"]);
    const error = await result.current.mutateAsync(changes).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RoomListSheetSaveError);
    expect(error).toMatchObject({ savedKeys: ["phone:b1", "price:r1"], total: 3, failure: { code: "42501" } });
  });

  it("biên nhận lệch (dòng trả về khác giá vừa gửi) → không nhận ô đó là đã lưu", async () => {
    m.reply = (table, patch, id) => ({ data: table === "rooms" ? { id, ...patch, rent_price: 1 } : { id, ...patch }, error: null });
    const { result } = renderHook(() => useSaveRoomListSheet(), { wrapper });
    const error = await result.current.mutateAsync(changes).catch((e: unknown) => e);
    expect(error).toMatchObject({ savedKeys: ["phone:b1"], total: 3 });
    expect(m.calls.map((c) => c.id)).toEqual(["b1", "r1"]); // dừng ngay, không ghi tiếp r2
  });
});
