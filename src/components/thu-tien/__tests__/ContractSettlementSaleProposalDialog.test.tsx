// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ formProps: null as Record<string, unknown> | null }));

vi.mock("../ContractSettlementSaleProposalSelector", () => ({
  ContractSettlementSaleProposalSelector: ({ onSelectSource }: { onSelectSource: (source: unknown) => void }) => (
    <button onClick={() => onSelectSource({ kind: "sale_contract", organizationId: "org", contractId: "contract" })}>
      Chọn HD-01
    </button>
  ),
}));
vi.mock("../ContractSettlementCreateForm", () => ({
  ContractSettlementCreateForm: (props: Record<string, unknown>) => {
    state.formProps = props;
    return <button onClick={() => (props.onCreated as (result: unknown) => void)({ outcome: "created", voucherId: "voucher" })}>Lập xong</button>;
  },
}));

import { ContractSettlementSaleProposalDialog } from "../ContractSettlementSaleProposalDialog";

afterEach(() => { cleanup(); state.formProps = null; });

it("selects an explicit sale source and opens the exact created voucher", () => {
  const onSelect = vi.fn();
  render(<ContractSettlementSaleProposalDialog organizationId="org" disabled={false} refreshRequired={vi.fn()} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "Đề xuất thưởng sale" }));
  fireEvent.click(screen.getByRole("button", { name: "Chọn HD-01" }));
  expect(state.formProps?.sourceRef).toEqual({ kind: "sale_contract", organizationId: "org", contractId: "contract" });
  fireEvent.click(screen.getByRole("button", { name: "Lập xong" }));
  expect(onSelect).toHaveBeenCalledWith({ kind: "voucher", voucherId: "voucher" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("does not expose proposal selection while settlement data is incomplete", () => {
  render(<ContractSettlementSaleProposalDialog organizationId="org" disabled refreshRequired={vi.fn()} onSelect={vi.fn()} />);
  expect((screen.getByRole("button", { name: "Đề xuất thưởng sale" }) as HTMLButtonElement).disabled).toBe(true);
});
