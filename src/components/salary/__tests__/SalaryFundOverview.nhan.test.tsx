// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import SalaryFundOverview from "../SalaryFundOverview";

afterEach(cleanup);

// K11-61 (C-11): desktop "Tổng lương vận hành" (trước khấu trừ) và "Tổng quỹ thực chi" (sau
// khấu trừ ứng/tiền phòng, tab Tháng + điện thoại) là hai số khác nhau — nhãn phải nói rõ.
it("ô Tổng lương vận hành ghi rõ là số TRƯỚC khấu trừ ứng/tiền phòng", () => {
  render(<SalaryFundOverview periods={[{ periodMonth: "2026-09-01", locked: false, managers: [], fee: 0, loading: false }]}
    feeBuildings={0} feeUnpublished={0} pending={[]} onOpenFund={() => {}} onOpenPerson={() => {}} />);
  expect(screen.getByText("Tổng lương vận hành")).toBeTruthy();
  expect(document.body.textContent).toContain("trước khấu trừ ứng/tiền phòng");
});
