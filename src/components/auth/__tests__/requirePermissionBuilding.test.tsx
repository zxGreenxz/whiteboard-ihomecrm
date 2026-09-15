// @vitest-environment jsdom
//
// D1 — route guard phải hỏi được "toà NÀY", không chỉ "có quyền ở đâu đó".
//
// Route chi tiết của một toà (`/buildings/:id`, `/apartments/:id`…) biết chính
// xác mình đang đứng ở đâu. Không truyền toà vào thì nhân viên chỉ được phân
// công một toà vẫn mở được trang của toà khác, đọc xong mới phát hiện rỗng —
// hoặc tệ hơn, thấy nút thao tác mà máy chủ sẽ từ chối.
//
// Bỏ trống `buildingId` phải giữ NGUYÊN hành vi cũ: rất nhiều route không gắn
// với toà nào và không được siết đột ngột.
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const perms = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
}));
vi.mock("@/hooks/useMyPermissions", () => ({ useMyPermissions: () => perms }));

import { RequirePermission } from "../RequirePermission";

const TOA_A = "11111111-1111-4111-8111-111111111111";
const TOA_B = "22222222-2222-4222-8222-222222222222";

const ve = (buildingId?: string) =>
  render(
    <MemoryRouter initialEntries={["/buildings/x"]}>
      <Routes>
        <Route
          path="/buildings/x"
          element={
            <RequirePermission module="buildings" action="view" buildingId={buildingId}>
              <div>NOI DUNG</div>
            </RequirePermission>
          }
        />
        <Route path="/" element={<div>TRANG CHU</div>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  cleanup();
  perms.data = undefined;
  perms.isLoading = false;
});

describe("RequirePermission — buildingId", () => {
  it("chỉ có quyền ở toà A: vào toà A thì thấy nội dung", () => {
    perms.data = {
      buildings: { view: { org_wide: false, building_ids: [TOA_A], cashbook_ids: [] } },
    };
    ve(TOA_A);
    expect(screen.getByText("NOI DUNG")).toBeTruthy();
  });

  it("chỉ có quyền ở toà A: vào toà B thì bị đá về trang chủ", () => {
    perms.data = {
      buildings: { view: { org_wide: false, building_ids: [TOA_A], cashbook_ids: [] } },
    };
    ve(TOA_B);
    expect(screen.getByText("TRANG CHU")).toBeTruthy();
  });

  it("org_wide thì toà nào cũng vào được", () => {
    perms.data = {
      buildings: { view: { org_wide: true, building_ids: [], cashbook_ids: [] } },
    };
    ve(TOA_B);
    expect(screen.getByText("NOI DUNG")).toBeTruthy();
  });

  it("không truyền buildingId: giữ nguyên hành vi cũ (có quyền ở đâu đó là vào được)", () => {
    perms.data = {
      buildings: { view: { org_wide: false, building_ids: [TOA_A], cashbook_ids: [] } },
    };
    ve(undefined);
    expect(screen.getByText("NOI DUNG")).toBeTruthy();
  });

  it("map boolean cũ (v1): buildingId KHÔNG siết thêm", () => {
    perms.data = { buildings: { view: true } };
    ve(TOA_B);
    expect(screen.getByText("NOI DUNG")).toBeTruthy();
  });
});
