// @vitest-environment jsdom
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFormContext } from "react-hook-form";
import type { CCCDQrData } from "@/lib/cccdQrParser";
type ScanCallback = (data: CCCDQrData, taskId?: number) => void | Promise<void>;
interface ScannerProps {
  onParsed: ScanCallback;
  onTaskStart?: (taskId: number) => void;
}
interface AddressProps {
  provinceValue?: string;
  districtValue?: string;
  wardValue?: string;
  onProvinceChange: (value: string) => void;
  onDistrictChange: (value: string) => void;
  onWardChange: (value: string) => void;
}
const b = vi.hoisted(() => ({
  callbacks: [] as ScanCallback[],
  taskStarts: [] as Array<(taskId: number) => void>,
  imageZones: [] as Array<{ label: string; imagePolicy?: string }>,
  lookup: vi.fn(),
  writes: vi.fn(),
}));
vi.mock("../CCCDQrUpload", () => ({
  default: ({ onParsed, onTaskStart }: ScannerProps) => {
    b.callbacks.push(onParsed);
    if (onTaskStart) b.taskStarts.push(onTaskStart);
    return <i data-testid="scanner" />;
  },
}));
vi.mock("@/components/customers/CCCDQrUpload", () => ({
  default: ({ onParsed, onTaskStart }: ScannerProps) => {
    b.callbacks.push(onParsed);
    if (onTaskStart) b.taskStarts.push(onTaskStart);
    return <i data-testid="scanner" />;
  },
}));
vi.mock("@/lib/cccdAddressLookup", () => ({
  lookupAddressFromText: (text: string) => b.lookup(text),
}));
vi.mock("@/hooks/useCustomers", () => ({
  useCreateCustomer: () => ({ mutateAsync: b.writes, isPending: false }),
}));
vi.mock("../ImageUploadZone", () => ({
  default: (props: { label: string; imagePolicy?: string }) => {
    b.imageZones.push({ label: props.label, imagePolicy: props.imagePolicy });
    return null;
  },
}));
vi.mock("@/components/customers/ImageUploadZone", () => ({
  default: (props: { label: string; imagePolicy?: string }) => {
    b.imageZones.push({ label: props.label, imagePolicy: props.imagePolicy });
    return null;
  },
}));
vi.mock("../CustomerVehiclesSection", () => ({ default: () => null }));
vi.mock("@/components/customers/CustomerVehiclesSection", () => ({
  default: () => null,
}));
vi.mock("../CustomerOrganizationFields", () => ({ default: () => null }));
vi.mock("../CustomerIndividualFields", () => ({
  default: function MockCustomerIndividualFields() {
    const f = useFormContext();
    return (
      <>
        {["full_name", "date_of_birth", "id_issue_date", "id_issue_place"].map(
          (n) => (
            <input key={n} aria-label={n} {...f.register(n)} />
          ),
        )}
      </>
    );
  },
}));
vi.mock("../AddressCascadingDropdowns", () => ({
  default: (p: AddressProps) => (
    <>
      {["province", "district", "ward"].map((n) => (
        <input
          key={n}
          aria-label={n}
          value={
            n === "province"
              ? (p.provinceValue ?? "")
              : n === "district"
                ? (p.districtValue ?? "")
                : (p.wardValue ?? "")
          }
          onChange={(e) =>
            (n === "province"
              ? p.onProvinceChange
              : n === "district"
                ? p.onDistrictChange
                : p.onWardChange)(e.target.value)
          }
        />
      ))}
    </>
  ),
}));
import CustomerForm from "../CustomerForm";
import { CreateCustomerDialog } from "../CreateCustomerDialog";
const qr = {
  idNumber: "001234567890",
  fullName: "Nguyễn Minh An",
  dateOfBirth: "1994-03-02",
  gender: "Nữ",
  permanentAddress: "Địa chỉ QR",
  idIssueDate: "2022-05-06",
  idIssuePlace: "Cục Cảnh Sát",
};
const renderForm = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CustomerForm onSubmit={vi.fn()} isSubmitting={false} />
    </QueryClientProvider>,
  );
describe("actual CCCD component lifecycle", () => {
  beforeEach(() => {
    b.callbacks.length = 0;
    b.taskStarts.length = 0;
    b.imageZones.length = 0;
    b.lookup.mockReset();
    b.writes.mockReset();
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
      window.setTimeout(cb, 0);
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });
  afterEach(cleanup);
  it("opts only individual CCCD image fields into original-byte storage", () => {
    renderForm();
    expect(new Set(b.imageZones.filter((zone) => zone.imagePolicy === "identity-original").map((zone) => zone.label)))
      .toEqual(new Set(["CCCD mặt trước", "CCCD mặt sau"]));
    expect(b.imageZones.find((zone) => zone.label === "Hộ chiếu")?.imagePolicy).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Tổ chức" }));
    const businessRegistration = b.imageZones.filter((zone) => zone.label === "Đăng ký kinh doanh").at(-1);
    expect(businessRegistration?.imagePolicy).toBeUndefined();

    cleanup();
    b.imageZones.length = 0;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<CreateCustomerDialog open onOpenChange={vi.fn()} />, {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    expect(new Set(b.imageZones.filter((zone) => zone.imagePolicy === "identity-original").map((zone) => zone.label)))
      .toEqual(new Set(["CCCD mặt trước", "CCCD mặt sau"]));
    expect(b.imageZones.find((zone) => zone.label === "Ảnh đại diện")?.imagePolicy).toBeUndefined();
    expect(b.imageZones.find((zone) => zone.label === "Hộ chiếu")?.imagePolicy).toBeUndefined();
  });
  it("rejects retained CustomerForm callback after type roundtrip", async () => {
    renderForm();
    const stale = b.callbacks[0];
    fireEvent.click(screen.getByRole("button", { name: "Tổ chức" }));
    fireEvent.click(screen.getByRole("button", { name: "Cá nhân" }));
    fireEvent.change(screen.getByLabelText("full_name"), {
      target: { value: "Manual" },
    });
    await act(async () => {
      await stale(qr);
    });
    expect((screen.getByLabelText("full_name") as HTMLInputElement).value).toBe(
      "Manual",
    );
  });
  it("rejects retained dialog callback after close/reopen", async () => {
    const cb = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const v = render(<CreateCustomerDialog open onOpenChange={cb} />, {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    const stale = b.callbacks[0];
    v.rerender(<CreateCustomerDialog open={false} onOpenChange={cb} />);
    v.rerender(<CreateCustomerDialog open onOpenChange={cb} />);
    const name = screen
      .getByRole("dialog")
      .querySelector('input[name="full_name"]') as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Manual" } });
    await act(async () => {
      await stale(qr);
    });
    expect(name.value).toBe("Manual");
    expect(b.writes).not.toHaveBeenCalled();
  });
  it("preserves manual fields during lookup and incomplete OCR", async () => {
    let resolve!: (value: Record<string, string>) => void;
    b.lookup.mockReturnValue(new Promise((r) => (resolve = r)));
    renderForm();
    b.taskStarts[0](1);
    let pending: void | Promise<void>;
    act(() => {
      pending = b.callbacks[0](qr, 1);
    });
    fireEvent.change(screen.getByPlaceholderText("Nhập địa chỉ chi tiết"), {
      target: { value: "Manual detail" },
    });
    fireEvent.change(screen.getByPlaceholderText("Nhập địa chỉ thường trú"), {
      target: { value: "Manual permanent" },
    });
    for (const n of ["province", "district", "ward"])
      fireEvent.change(screen.getByLabelText(n), {
        target: { value: "manual-" + n },
      });
    resolve({
      detailedAddress: "lookup",
      provinceCode: "p",
      districtCode: "d",
      wardCode: "w",
    });
    await act(async () => await pending);
    expect(
      (screen.getByPlaceholderText("Nhập địa chỉ chi tiết") as HTMLInputElement)
        .value,
    ).toBe("Manual detail");
    expect(
      (
        screen.getByPlaceholderText(
          "Nhập địa chỉ thường trú",
        ) as HTMLInputElement
      ).value,
    ).toBe("Manual permanent");
    for (const n of ["province", "district", "ward"])
      expect((screen.getByLabelText(n) as HTMLInputElement).value).toBe(
        "manual-" + n,
      );
    fireEvent.change(screen.getByLabelText("date_of_birth"), {
      target: { value: "manual dob" },
    });
    fireEvent.change(screen.getByLabelText("id_issue_date"), {
      target: { value: "manual issue" },
    });
    await act(
      async () =>
        await b.callbacks.at(-1)({
          ...qr,
          source: "ocr",
          fullName: "",
          idNumber: "",
          dateOfBirth: "",
          idIssueDate: "",
          permanentAddress: "",
          idIssuePlace: "",
        }, 1),
    );
    expect(
      (screen.getByLabelText("date_of_birth") as HTMLInputElement).value,
    ).toBe("manual dob");
    expect(
      (screen.getByLabelText("id_issue_date") as HTMLInputElement).value,
    ).toBe("manual issue");
    expect(
      (screen.getByLabelText("id_issue_place") as HTMLInputElement).value,
    ).toBe("Cục Cảnh sát");
    const lookupCalls = b.lookup.mock.calls.length;
    await act(async () => {
      await b.callbacks.at(-1)!({
        ...qr,
        source: "ocr",
        permanentAddress: "Địa chỉ OCR nguyên bản",
        idIssuePlace: "",
      }, 1);
    });
    expect(
      (screen.getByPlaceholderText("Nhập địa chỉ chi tiết") as HTMLInputElement)
        .value,
    ).toBe("Địa chỉ OCR nguyên bản");
    expect(
      (
        screen.getByPlaceholderText(
          "Nhập địa chỉ thường trú",
        ) as HTMLInputElement
      ).value,
    ).toBe("Địa chỉ OCR nguyên bản");
    expect(b.lookup).toHaveBeenCalledTimes(lookupCalls);
  });

  it("does not let address lookup from task A write after task B starts", async () => {
    let resolveA!: (value: Record<string, string>) => void;
    b.lookup.mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve; }));
    renderForm();
    b.taskStarts[0](1);
    let pendingA: void | Promise<void>;
    act(() => {
      pendingA = b.callbacks[0](qr, 1);
    });

    b.taskStarts[0](2);
    await act(async () => {
      await b.callbacks[0]({ ...qr, fullName: "Khách B", permanentAddress: "" }, 2);
    });
    resolveA({
      detailedAddress: "lookup A",
      provinceCode: "province-a",
      districtCode: "district-a",
      wardCode: "ward-a",
    });
    await act(async () => { await pendingA; });

    expect((screen.getByLabelText("full_name") as HTMLInputElement).value).toBe("Khách B");
    expect((screen.getByLabelText("province") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("district") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("ward") as HTMLInputElement).value).toBe("");
  });
});
