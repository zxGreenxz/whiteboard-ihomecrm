// @vitest-environment jsdom
// Tab "Chốt LN tháng" giữ sống sau lần mở đầu (chủ báo 14/11: chuyển tab là mất nháp), nhưng
// KPI của nó không được đổ lên hero khi đang ở tab khác.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import ProfitHubShell, { ProfitHubSlot, ProfitHubTabPanel } from "../ProfitHubShell";

function Draft() {
  const [value, setValue] = useState("");
  return (
    <>
      <ProfitHubSlot name="kpis">
        <span>KPI chốt</span>
      </ProfitHubSlot>
      <input aria-label="nháp" value={value} onChange={(event) => setValue(event.target.value)} />
    </>
  );
}

function Page() {
  const [tab, setTab] = useState("report");
  return (
    <ProfitHubShell
      tabs={[
        { value: "report", label: "Báo cáo" },
        { value: "lock", label: "Chốt" },
      ]}
      value={tab}
      onValueChange={setTab}
    >
      <ProfitHubTabPanel value="report">
        <ProfitHubSlot name="kpis">
          <span>KPI báo cáo</span>
        </ProfitHubSlot>
        <p>Nội dung báo cáo</p>
      </ProfitHubTabPanel>
      <ProfitHubTabPanel value="lock" keepMounted>
        <Draft />
      </ProfitHubTabPanel>
    </ProfitHubShell>
  );
}

const openTab = (name: string) => {
  const trigger = screen.getByRole("tab", { name });
  fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
};

afterEach(cleanup);

describe("ProfitHubTabPanel keepMounted", () => {
  it("chưa mở lần nào thì chưa mount; mở rồi rời đi thì giữ nháp, ẩn tab và tắt KPI của nó", () => {
    render(<Page />);
    expect(screen.queryByLabelText("nháp")).toBeNull();
    expect(screen.getByText("KPI báo cáo")).toBeTruthy();

    openTab("Chốt");
    fireEvent.change(screen.getByLabelText("nháp"), { target: { value: "150000" } });
    expect(screen.getByText("KPI chốt")).toBeTruthy();
    expect(screen.queryByText("KPI báo cáo")).toBeNull();

    openTab("Báo cáo");
    const draft = screen.getByLabelText("nháp", { selector: "input" }) as HTMLInputElement;
    expect(draft.value).toBe("150000");
    expect(draft.closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(true);
    expect(screen.queryByText("KPI chốt")).toBeNull();
    expect(screen.getByText("KPI báo cáo")).toBeTruthy();

    openTab("Chốt");
    expect((screen.getByLabelText("nháp") as HTMLInputElement).value).toBe("150000");
    expect(screen.getByLabelText("nháp").closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(false);
    expect(screen.getByText("KPI chốt")).toBeTruthy();
  });
});
