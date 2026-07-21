import { describe, expect, it, vi } from "vitest";

import type { ContractFormData } from "@/lib/contractValidation";
import { useContractSubmit } from "./useContractSubmit";
import type { ContractFormState } from "./useContractFormState";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

describe("useContractSubmit", () => {
  it("rejects an empty end billing date after normalization", () => {
    const setError = vi.fn();
    const createContract = { mutate: vi.fn() };
    const state = {
      isEditMode: false,
      form: { setError },
      selectedCustomers: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          is_representative: true,
          notes: null,
        },
      ],
      selectedServices: [],
      useCustomServices: false,
      createContract,
      updateContract: { mutate: vi.fn() },
      syncCustomers: { mutateAsync: vi.fn() },
      syncServices: { mutateAsync: vi.fn() },
      typedDepositTotal: 0,
      approvedOrphanTotal: 0,
      orphanDepositVouchers: [],
      invoiceItems: [],
      firstInvoiceDiscount: { amount: 0, notes: null },
      depositRows: [],
      setCommissionContractId: vi.fn(),
    } as unknown as ContractFormState;
    const data: ContractFormData = {
      room_id: "11111111-1111-4111-8111-111111111111",
      signed_date: "2026-07-21",
      start_date: "2026-07-22",
      end_date: "2027-07-21",
      rent_price: 4_000_000,
      total_deposit: 0,
      deposit_paid: 0,
      deposit_account_id: null,
      payment_cycle: "MONTHLY",
      start_billing_date: "",
      end_billing_date: "",
      contract_template_id: null,
      invoice_template_id: null,
      notes: "",
      discount_months: 0,
      discount_amount_per_month: 0,
      deposit_debt_acknowledged: false,
      deposit_debt_reason: "",
      deposit_topup_due_date: "",
    };

    const submit = useContractSubmit({
      state,
      onOpenChange: vi.fn(),
    });
    submit(data);

    expect(setError).toHaveBeenCalledWith("end_billing_date", {
      type: "manual",
      message: expect.any(String),
    });
    expect(createContract.mutate).not.toHaveBeenCalled();
  });
});
