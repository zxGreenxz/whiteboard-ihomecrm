// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({ count: 0 }));
vi.mock("../PendingValveDialog", () => {
  loaded.count += 1;
  return { PendingValveDialog: () => <div role="alertdialog">hộp cảnh báo</div> };
});

import { PendingValveHost } from "../PendingValveHost";
import { raisePendingValveSignal } from "@/lib/pendingValveSignal";

afterEach(cleanup);

describe("PendingValveHost", () => {
  it("không nạp hộp cảnh báo khi chưa có lần ghi nào bị chặn; có tín hiệu thì nạp và hiện", async () => {
    render(<PendingValveHost />);
    await act(async () => { await Promise.resolve(); });
    expect(loaded.count).toBe(0);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    act(() => { raisePendingValveSignal(); });
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(loaded.count).toBe(1);
  });

  it("tín hiệu bật trước khi gốc ứng dụng dựng xong vẫn được báo khi chỗ gắn đăng ký", async () => {
    cleanup();
    raisePendingValveSignal();
    render(<PendingValveHost />);
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
  });
});
