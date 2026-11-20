// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TimelineRow } from "@/lib/staffDay";
import { JourneyTimeline } from "../JourneyTimeline";

vi.mock("@/hooks/useSignedUrl", () => ({
  useSignedUrl: (path: string | null) => path,
  useSignedUrlQuery: (path: string) => ({ data: path }),
}));

afterEach(cleanup);

function photoRow(key: string, count: number): TimelineRow {
  return {
    key, at: "2026-11-20T02:24:00Z", time: "09:24", title: key,
    strong: false, sub: null, tone: "inspect", badge: null,
    photos: Array.from({ length: count }, (_, i) => ({
      path: `/${key}-${i + 1}.jpg`, label: `${key} ${i + 1}`,
    })),
  };
}

function currentImage() {
  return within(screen.getByRole("dialog")).getByRole("img");
}

it("mở đúng ảnh đã chọn và chuyển trước/sau giữa các ảnh cùng sự kiện", () => {
  render(<JourneyTimeline rows={[photoRow("full", 6), photoRow("quick", 1)]} />);
  fireEvent.click(screen.getByRole("img", { name: "full 2" }));
  expect(currentImage().getAttribute("src")).toBe("/full-2.jpg");
  expect(within(screen.getByRole("dialog")).getByText("2 / 6")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /Ảnh sau/ }));
  expect(currentImage().getAttribute("src")).toBe("/full-3.jpg");
  fireEvent.click(screen.getByRole("button", { name: /Ảnh trước/ }));
  expect(currentImage().getAttribute("src")).toBe("/full-2.jpg");

  fireEvent.click(screen.getByRole("button", { name: /Đóng/ }));
  fireEvent.click(screen.getByRole("img", { name: "quick 1" }));
  expect(currentImage().getAttribute("src")).toBe("/quick-1.jpg");
  expect(screen.queryByRole("button", { name: /Ảnh sau/ })).toBeNull();
});

it("mở ảnh thứ tư từ ô +3 và vuốt hai chiều tới các ảnh bị ẩn", () => {
  render(<JourneyTimeline rows={[photoRow("full", 6)]} />);
  fireEvent.click(screen.getByText("+3"));
  expect(currentImage().getAttribute("src")).toBe("/full-4.jpg");

  function swipe(fromX: number, toX: number) {
    const img = currentImage();
    fireEvent.touchStart(img, { touches: [{ clientX: fromX, clientY: 120 }] });
    fireEvent.touchEnd(img, { touches: [], changedTouches: [{ clientX: toX, clientY: 125 }] });
  }

  swipe(240, 65);
  expect(currentImage().getAttribute("src")).toBe("/full-5.jpg");
  swipe(240, 65);
  expect(currentImage().getAttribute("src")).toBe("/full-6.jpg");
  swipe(65, 240);
  expect(currentImage().getAttribute("src")).toBe("/full-5.jpg");
});
