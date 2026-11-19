// @vitest-environment jsdom
// Biểu mẫu xin nghỉ phép trên màn Hôm nay: chọn từ ngày → đến ngày (mặc định một ngày), xem trước số ngày (bỏ Chủ
// nhật), gửi đúng khoảng + lý do, báo đúng kết quả máy chủ; lỗi kiểm tại chỗ không gửi đơn; lỗi máy chủ hiện tại chỗ.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  isPending: false,
  success: vi.fn(),
  info: vi.fn(),
  /** Lịch ngày làm của công ty (vn_workdays) mà biểu mẫu đọc để xem trước; undefined = đang tải. */
  workdays: { data: undefined as string[] | undefined, isError: false },
  calendarArgs: [] as Array<[string, string]>,
}));

vi.mock("@/hooks/useMyDay", () => ({
  useRequestLeaveRange: () => ({ mutateAsync: m.mutateAsync, isPending: m.isPending }),
  useLeaveWorkdays: (from: string, to: string) => { m.calendarArgs.push([from, to]); return m.workdays; },
  leaveRequestErrorMessage: (error: { message?: string }) => `máy chủ: ${error.message}`,
}));
vi.mock("sonner", () => ({ toast: { success: m.success, info: m.info } }));

import { leaveWorkDays } from "@/lib/leaveDates";
import { LeaveRequestForm } from "../LeaveRequestForm";

/** Công ty không có ngày lễ nào từ 01/11/2026 đến 31/01/2027: ngày làm = mọi ngày trừ Chủ nhật. */
const KHONG_LE = leaveWorkDays("2026-11-01", "2027-01-31");

const TODAY = "2026-11-19";
const onDone = vi.fn();

function renderForm(left = 5) {
  return render(<LeaveRequestForm today={TODAY} left={left} onDone={onDone} />);
}
const field = (name: string) => screen.getByLabelText(name, { exact: false }) as HTMLInputElement;
const pick = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  m.isPending = false;
  m.workdays = { data: KHONG_LE, isError: false };
  m.calendarArgs = [];
});

describe("LeaveRequestForm", () => {
  it("chọn Từ ngày thì Đến ngày theo cùng ngày; kéo dài khoảng thì xem trước số ngày bỏ Chủ nhật", () => {
    renderForm();
    pick("Từ ngày", "2026-11-20");
    expect(field("Đến ngày").value).toBe("2026-11-20");
    expect(field("Từ ngày").min).toBe(TODAY);
    expect(field("Đến ngày").min).toBe("2026-11-20");
    expect(screen.getByText("ngày 20/11/2026")).toBeTruthy();
    pick("Đến ngày", "2026-11-23");
    expect(screen.getByText("3 ngày: 20/11 → 23/11")).toBeTruthy();
    expect(screen.getByText(/Chủ nhật không tính/)).toBeTruthy();
    expect(screen.getByText(/Số dư tính đến tháng này còn 5 ngày/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gửi đơn 3 ngày" })).toBeTruthy();
  });

  it("gửi đúng khoảng và lý do; báo đã gửi, ngày đã có đơn giữ nguyên, rồi đóng", async () => {
    m.mutateAsync.mockResolvedValue({ from: "2026-11-20", to: "2026-11-23", requested: ["2026-11-20", "2026-11-23"], existing: ["2026-11-21"], holidays: [], batch: "b" });
    renderForm();
    pick("Từ ngày", "2026-11-20");
    pick("Đến ngày", "2026-11-23");
    fireEvent.change(field("Lý do"), { target: { value: "Về quê" } });
    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn 3 ngày" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(m.mutateAsync).toHaveBeenCalledWith({ from: "2026-11-20", to: "2026-11-23", reason: "Về quê" });
    expect(m.success).toHaveBeenCalledWith(
      "Đã gửi đơn nghỉ 2 ngày: 20/11, 23/11. Đơn đang chờ duyệt, ngày công chưa được xác nhận. Ngày 21/11/2026 đã có đơn từ trước nên giữ nguyên.",
    );
  });

  it("Đến ngày để trống ⇒ nghỉ đúng một ngày Từ ngày", async () => {
    m.mutateAsync.mockResolvedValue({ from: TODAY, to: TODAY, requested: [TODAY], existing: [], holidays: [], batch: "b" });
    renderForm();
    pick("Từ ngày", TODAY);
    pick("Đến ngày", "");
    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn" }));
    await waitFor(() => expect(m.mutateAsync).toHaveBeenCalledWith({ from: TODAY, to: TODAY, reason: "" }));
    expect(m.success).toHaveBeenCalledWith("Đã gửi đơn nghỉ ngày 19/11/2026. Đơn đang chờ duyệt, ngày công chưa được xác nhận.");
  });

  it("mọi ngày đã có đơn ⇒ báo không gửi thêm, không báo thành công", async () => {
    m.mutateAsync.mockResolvedValue({ from: "2026-11-20", to: "2026-11-21", requested: [], existing: ["2026-11-20", "2026-11-21"], holidays: [], batch: null });
    renderForm();
    pick("Từ ngày", "2026-11-20");
    pick("Đến ngày", "2026-11-21");
    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn 2 ngày" }));
    await waitFor(() => expect(m.info).toHaveBeenCalledWith("Ngày 20/11 → 21/11 đã có đơn nghỉ từ trước — không gửi thêm."));
    expect(m.success).not.toHaveBeenCalled();
  });

  it.each([
    ["chưa chọn ngày", "", "", "Chọn ngày bắt đầu nghỉ."],
    ["ngày đã qua", "2026-11-18", "2026-11-18", "Chọn hôm nay hoặc ngày sau đó."],
    ["kết thúc trước bắt đầu", "2026-11-23", "2026-11-20", "Ngày kết thúc phải bằng hoặc sau ngày bắt đầu."],
    ["dài hơn 31 ngày", "2026-11-20", "2026-12-21", "Mỗi đơn tối đa 31 ngày — chia thành nhiều đơn."],
    ["chỉ Chủ nhật", "2026-11-22", "2026-11-22", "Chủ nhật đã là ngày nghỉ — không cần xin phép."],
  ])("%s ⇒ báo ngay tại ô, không gửi đơn", async (_ten, from, to, message) => {
    renderForm();
    pick("Từ ngày", from);
    pick("Đến ngày", to);
    fireEvent.submit(field("Từ ngày").closest("form") as HTMLFormElement);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(m.mutateAsync).not.toHaveBeenCalled();
  });

  it("máy chủ từ chối (vd. thiếu số dư) ⇒ hiện câu lỗi tại chỗ, giữ nguyên đã nhập, không đóng", async () => {
    m.mutateAsync.mockRejectedValue({ message: "Số dư phép chỉ còn đủ 2 ngày, đơn này cần 3 ngày — bớt ngày rồi gửi lại", hint: "leave_quota_exceeded" });
    renderForm(2);
    pick("Từ ngày", "2026-11-20");
    pick("Đến ngày", "2026-11-23");
    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn 3 ngày" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("máy chủ: Số dư phép chỉ còn đủ 2 ngày, đơn này cần 3 ngày — bớt ngày rồi gửi lại");
    expect(field("Đến ngày").value).toBe("2026-11-23");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("ngày lễ của công ty trong khoảng: xem trước không tính, đọc lịch đúng khoảng đã chọn", () => {
    m.workdays = { data: KHONG_LE.filter((day) => day !== "2026-11-24"), isError: false };
    renderForm();
    pick("Từ ngày", "2026-11-23");
    pick("Đến ngày", "2026-11-25");
    expect(m.calendarArgs.at(-1)).toEqual(["2026-11-23", "2026-11-25"]);
    expect(screen.getByText("2 ngày: 23/11, 25/11")).toBeTruthy();
    expect(screen.getByText(/ngày lễ 24\/11\/2026 không tính/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gửi đơn 2 ngày" })).toBeTruthy();
  });

  it("toàn ngày lễ / Chủ nhật: báo không cần xin phép", () => {
    m.workdays = { data: KHONG_LE.filter((day) => day !== "2026-11-21"), isError: false };
    renderForm();
    pick("Từ ngày", "2026-11-21");
    pick("Đến ngày", "2026-11-22");
    expect(screen.getByText("Các ngày đã chọn đều là Chủ nhật hoặc ngày lễ của công ty — không cần xin phép.")).toBeTruthy();
  });

  it("lịch chưa đọc xong: xem trước chỉ bỏ Chủ nhật, nút không nêu số ngày; đọc lỗi thì báo ngày lễ vẫn không tính", () => {
    m.workdays = { data: undefined, isError: false };
    const { rerender } = renderForm();
    pick("Từ ngày", "2026-11-20");
    pick("Đến ngày", "2026-11-23");
    expect(screen.getByText("3 ngày: 20/11 → 23/11")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gửi đơn" })).toBeTruthy();
    m.workdays = { data: undefined, isError: true };
    rerender(<LeaveRequestForm today={TODAY} left={5} onDone={onDone} />);
    expect(screen.getByText(/Chưa đọc được lịch nghỉ lễ của công ty/)).toBeTruthy();
  });

  it("máy chủ bỏ ngày lễ ⇒ báo rõ ngày lễ không tính", async () => {
    m.mutateAsync.mockResolvedValue({ from: "2026-11-23", to: "2026-11-25", requested: ["2026-11-23", "2026-11-25"], existing: [], holidays: ["2026-11-24"], batch: "b" });
    renderForm();
    pick("Từ ngày", "2026-11-23");
    pick("Đến ngày", "2026-11-25");
    fireEvent.click(screen.getByRole("button", { name: "Gửi đơn 3 ngày" }));
    await waitFor(() => expect(m.success).toHaveBeenCalledWith(
      "Đã gửi đơn nghỉ 2 ngày: 23/11, 25/11. Đơn đang chờ duyệt, ngày công chưa được xác nhận. Ngày lễ 24/11/2026 không tính.",
    ));
  });

  it("đang gửi ⇒ khoá nút", () => {
    m.isPending = true;
    renderForm();
    expect((screen.getByRole("button", { name: "Đang gửi…" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
