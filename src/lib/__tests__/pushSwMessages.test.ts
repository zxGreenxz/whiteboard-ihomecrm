import { describe, expect, it } from "vitest";
import { docThamSoMoApp, docTinServiceWorker } from "@/lib/push/swMessages";
import { chuanHoaIdThongBao, TRAN_ID_DANH_DAU } from "@/lib/notifications/notificationIds";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";

describe("docTinServiceWorker", () => {
  it("đọc notification-click, lọc id không phải uuid và org méo", () => {
    expect(docTinServiceWorker({
      type: "notification-click",
      url: "/thu-tien",
      notificationIds: [ID1, "x", 3, ID1.toUpperCase(), ID2],
      organizationId: "not-uuid",
    })).toEqual({ type: "notification-click", url: "/thu-tien", notificationIds: [ID1, ID2], organizationId: null });
  });

  it("tin lạ hoặc không phải object ⇒ null", () => {
    expect(docTinServiceWorker(null)).toBeNull();
    expect(docTinServiceWorker("push-received")).toBeNull();
    expect(docTinServiceWorker({ type: "khac" })).toBeNull();
    expect(docTinServiceWorker({ type: "push-received" })).toEqual({ type: "push-received" });
    expect(docTinServiceWorker({ type: "push-subscription-changed" })).toEqual({ type: "push-subscription-changed" });
  });
});

describe("docThamSoMoApp — ?notif=&org= khi SW mở tab mới", () => {
  it("không có tham số ⇒ null", () => {
    expect(docThamSoMoApp("?close=abc")).toBeNull();
  });

  it("tách id + công ty và giữ nguyên query còn lại của trang đích", () => {
    expect(docThamSoMoApp(`?handover=${ID2}&notif=${ID1},${ID2}&org=${ORG}`)).toEqual({
      notificationIds: [ID1, ID2],
      organizationId: ORG,
      conLai: `?handover=${ID2}`,
    });
  });

  it("id rác bị bỏ, query rỗng sau khi gỡ", () => {
    expect(docThamSoMoApp("?notif=abc&org=")).toEqual({ notificationIds: [], organizationId: null, conLai: "" });
  });

  it("cắt trần số id một lần đánh dấu", () => {
    const many = Array.from({ length: 80 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(chuanHoaIdThongBao(many)).toHaveLength(TRAN_ID_DANH_DAU);
  });
});
