// Bug 26/08/2026: bảng "Chào mừng" hiện lại mãi cho tài khoản cũ.
//
// Nguyên nhân gốc: cờ onboarding_completed là cờ THEO USER, nhưng câu đọc chỉ
// lọc theo `key` rồi gọi maybeSingle(). RLS của settings cho super admin và
// staff thấy row của user khác (settings_super_admin_all / settings_select_staff),
// nên khi tồn tại ≥2 row cùng key, PostgREST trả lỗi PGRST116 "multiple rows",
// data = null, và cờ bị đọc thành false vĩnh viễn — dù row của chính user là true.
//
// Test này mô phỏng đúng cảnh đó: DB có 2 row onboarding_completed (của user
// hiện tại + của user khác, cả hai true). Hàm đọc PHẢI lọc theo user_id để
// trả về true.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { user_id: string; key: string; value: unknown };

let rows: Row[] = [];

function taoQueryBuilder() {
  const filters: Array<(r: Row) => boolean> = [];
  const builder = {
    select: () => builder,
    eq: (column: keyof Row, val: unknown) => {
      filters.push((r) => r[column] === val);
      return builder;
    },
    // Hành vi thật của PostgREST/supabase-js: >1 row khớp → lỗi PGRST116, data null.
    maybeSingle: async () => {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (matched.length > 1) {
        return {
          data: null,
          error: { code: "PGRST116", message: "multiple (or no) rows returned" },
        };
      }
      return { data: matched[0] ? { value: matched[0].value } : null, error: null };
    },
  };
  return builder;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => taoQueryBuilder() },
}));

const { fetchOnboardingCompleted } = await import("../onboardingCompleted");

beforeEach(() => {
  rows = [];
});

describe("fetchOnboardingCompleted", () => {
  it("vẫn đọc đúng cờ của mình khi RLS cho thấy row của user khác", async () => {
    rows = [
      { user_id: "user-toi", key: "onboarding_completed", value: true },
      { user_id: "user-khac", key: "onboarding_completed", value: true },
    ];
    await expect(fetchOnboardingCompleted("user-toi")).resolves.toBe(true);
  });

  it("false khi chính user chưa có row (user mới thật sự)", async () => {
    rows = [{ user_id: "user-khac", key: "onboarding_completed", value: true }];
    await expect(fetchOnboardingCompleted("user-toi")).resolves.toBe(false);
  });

  it("false khi row của mình chưa true", async () => {
    rows = [{ user_id: "user-toi", key: "onboarding_completed", value: false }];
    await expect(fetchOnboardingCompleted("user-toi")).resolves.toBe(false);
  });

  it("không nhặt nhầm setting khác của cùng user", async () => {
    rows = [{ user_id: "user-toi", key: "dark_mode", value: true }];
    await expect(fetchOnboardingCompleted("user-toi")).resolves.toBe(false);
  });
});
