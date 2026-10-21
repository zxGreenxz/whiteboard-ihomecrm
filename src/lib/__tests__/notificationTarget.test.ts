import { describe, expect, it } from "vitest";
import { dichThongBao, duongDanDuPhong, nhanHoThongBao } from "@/lib/notifications/notificationTarget";
import { NOTIFICATION_FALLBACK_URL } from "@/lib/notificationRoutes";

const INV = "11111111-1111-4111-8111-111111111111";
const CON = "22222222-2222-4222-8222-222222222222";
const ALL = { __superadmin: true };
const CHI_HOP_DONG = { contracts: { view: true } };

describe("dichThongBao — mọi đích qua allow-list + kiểm quyền", () => {
  it("metadata.url đứng trước khoá ngoại", () => {
    expect(dichThongBao({ type: "ACTION_REQUIRED", invoice_id: INV, metadata: { url: "/my-day" } }, ALL)).toBe("/my-day");
  });

  it("dòng cũ chỉ có invoice_id: thiếu quyền hoá đơn thì hạ về đích dự phòng, không đá về '/'", () => {
    expect(dichThongBao({ type: "PAYMENT_REMINDER", invoice_id: INV }, ALL)).toBe(`/invoices/${INV}`);
    expect(dichThongBao({ type: "PAYMENT_REMINDER", invoice_id: INV }, CHI_HOP_DONG)).toBe(NOTIFICATION_FALLBACK_URL);
    expect(dichThongBao({ type: "CONTRACT_EXPIRING", contract_id: CON }, CHI_HOP_DONG)).toBe(`/contracts/${CON}`);
  });

  it("khoá ngoại méo không mở đường điều hướng lạ", () => {
    expect(dichThongBao({ type: "PAYMENT_REMINDER", invoice_id: "../../x" }, ALL)).toBeNull();
    expect(duongDanDuPhong({ type: "CUSTOM" })).toBeNull();
    expect(dichThongBao({ type: "SALARY_BONUS" }, {})).toBe("/finance/salary");
  });
});

describe("nhanHoThongBao — nhãn họ của dòng server", () => {
  it("BILLING tách quá hạn / sắp đến hạn; các họ khác có nhãn riêng", () => {
    expect(nhanHoThongBao({ type: "OVERDUE_INVOICE", metadata: { event: "BILLING" } })).toBe("Hoá đơn quá hạn");
    expect(nhanHoThongBao({ type: "PAYMENT_REMINDER", metadata: { event: "BILLING" } })).toBe("Hoá đơn sắp đến hạn");
    expect(nhanHoThongBao({ type: "CONTRACT_EXPIRING", metadata: { event: "CONTRACT_EXPIRY" } })).toBe("HĐ sắp hết hạn");
    expect(nhanHoThongBao({ type: "DEPOSIT_SHORTFALL", metadata: { event: "DEPOSIT" } })).toBe("Thiếu cọc");
    expect(nhanHoThongBao({ type: "ACTION_REQUIRED", metadata: { event: "LIFECYCLE" } })).toBe("Theo dõi trả phòng");
  });

  it("không có họ server ⇒ null (giữ nhãn theo loại)", () => {
    expect(nhanHoThongBao({ type: "ACTION_REQUIRED", metadata: { event: "E1" } })).toBeNull();
    expect(nhanHoThongBao({ type: "CUSTOM", metadata: null })).toBeNull();
  });
});
