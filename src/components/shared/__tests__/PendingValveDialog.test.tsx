// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { PendingValveDialog } from "../PendingValveDialog";
import { createFinancialPendingStore, PENDING_SETTLE_MS } from "@/lib/financialPending";
import { createPendingValve } from "@/lib/pendingValve";

// 09:00 ngày 24/11/2026 giờ Việt Nam.
const T0 = Date.parse("2026-11-24T02:00:00.000Z");
const scope = { namespace: "voucher-lifecycle", userId: "u1", organizationId: "actor-scope", businessKey: "v1" };

function harness() {
  const map = new Map<string, string>();
  const failing = { setItem: false };
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { if (failing.setItem) throw new Error("quota"); map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
  let clock = T0;
  const now = () => new Date(clock);
  const store = createFinancialPendingStore({ storage, now });
  const valve = createPendingValve({ storage, now });
  const block = (blockedOperation = "huỷ phiếu") => act(() => { valve.report({ pending: store.read(scope)!, blockedOperation, store }); });
  return { failing, store, valve, block, advance: (ms: number) => { clock += ms; } };
}
const button = (name: string) => screen.queryByRole("button", { name });

beforeEach(() => { toast.success.mockClear(); toast.error.mockClear(); });
afterEach(cleanup);

describe("PendingValveDialog", () => {
  it("không hiện gì khi không có lần ghi nào bị chặn", () => {
    const h = harness();
    render(<PendingValveDialog valve={h.valve} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("dấu đã quá 2 phút: nêu việc đang kẹt, giờ kẹt, mã bản ghi và việc vừa bấm; xác nhận thì gỡ đúng dấu và ghi nhật ký", () => {
    const h = harness();
    h.store.markPending(scope, { attemptId: "a1", operation: "duyệt phiếu" });
    h.store.recordCompleted(scope, "a1", ["pc-0042"]);
    h.advance(PENDING_SETTLE_MS);
    render(<PendingValveDialog valve={h.valve} />);
    h.block();

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Lần gửi trước chưa rõ kết quả");
    expect(dialog.textContent).toContain("duyệt phiếu");
    expect(dialog.textContent).toContain("09:00 ngày 24/11/2026");
    expect(dialog.textContent).toContain("pc-0042");
    expect(dialog.textContent).toContain("Bạn vừa bấm");
    expect(dialog.textContent).toContain("huỷ phiếu");
    expect(button("Kiểm tra lại")).not.toBeNull();

    fireEvent.click(button("Đã kiểm tra, cho làm tiếp")!);
    expect(h.store.read(scope)).toBeNull();
    expect(h.valve.readLog("u1")).toMatchObject([{ attemptId: "a1", operation: "duyệt phiếu", recordIds: ["pc-0042"] }]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("dấu chưa quá 2 phút: chỉ báo đang chờ, không có nút gỡ; đủ 2 phút bấm «Kiểm tra lại» mới hiện nút gỡ", () => {
    const h = harness();
    h.store.markPending(scope, { attemptId: "a1", operation: "duyệt phiếu" });
    h.advance(60_000);
    render(<PendingValveDialog valve={h.valve} />);
    h.block();

    expect(screen.getByRole("alertdialog").textContent).toContain("Lần gửi trước đang chờ kết quả");
    expect(screen.getByRole("alertdialog").textContent).toContain("Thử lại sau ít phút");
    expect(button("Đã kiểm tra, cho làm tiếp")).toBeNull();

    fireEvent.click(button("Kiểm tra lại")!);
    expect(button("Đã kiểm tra, cho làm tiếp")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Vẫn chưa đủ 2 phút");

    h.advance(60_000);
    fireEvent.click(button("Kiểm tra lại")!);
    expect(button("Đã kiểm tra, cho làm tiếp")).not.toBeNull();
    expect(h.store.read(scope)?.attemptId).toBe("a1");
  });

  it("«Kiểm tra lại» thấy dấu đã được gỡ ở nơi khác thì đóng hộp và báo bấm lại", () => {
    const h = harness();
    h.store.markPending(scope, { attemptId: "a1" });
    h.advance(PENDING_SETTLE_MS);
    render(<PendingValveDialog valve={h.valve} />);
    h.block();
    h.store.clearConfirmed(scope, "a1");

    fireEvent.click(button("Kiểm tra lại")!);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(h.valve.readLog("u1")).toEqual([]);
  });

  it("không lưu được nhật ký: báo lỗi, giữ dấu, hộp vẫn mở", () => {
    const h = harness();
    h.store.markPending(scope, { attemptId: "a1" });
    h.advance(PENDING_SETTLE_MS);
    render(<PendingValveDialog valve={h.valve} />);
    h.block();
    h.failing.setItem = true;

    fireEvent.click(button("Đã kiểm tra, cho làm tiếp")!);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(h.store.read(scope)?.attemptId).toBe("a1");
    expect(screen.queryByRole("alertdialog")).not.toBeNull();
  });

  it("«Đóng» không gỡ dấu; dấu cũ không có tên thao tác hiện theo nhãn của namespace", () => {
    const h = harness();
    h.store.markPending(scope, { attemptId: "a1" });
    h.advance(PENDING_SETTLE_MS);
    render(<PendingValveDialog valve={h.valve} />);
    h.block();

    expect(screen.getByRole("alertdialog").textContent).toContain("duyệt, huỷ hoặc khôi phục phiếu thu chi");
    expect(screen.getByRole("alertdialog").textContent).toContain("Chưa có mã nào được ghi nhận");
    fireEvent.click(button("Đóng")!);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.store.read(scope)?.attemptId).toBe("a1");
    expect(h.valve.readLog("u1")).toEqual([]);
  });
});
