import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Plan I3 (rà soát 15/09/2026): trigger BEFORE INSERT của 33 bảng chuyển sang
 * app_private.autofill_org_strict — fail-closed với người thuộc hai tổ chức.
 * Mỗi hook ghi thẳng bảng phải gửi `organization_id` = tổ chức ĐANG CHỌN.
 *
 * Cách đo: mock `supabase.from(...).insert` ghi lại tham số theo bảng; mock
 * `useOrganization` trả tổ chức đang chọn; gọi thẳng `mutationFn` của hook.
 * Mock supabase luôn trả `{ data, error }` (supabase.rpc/from không bao giờ
 * ném — mockRejectedValue ở đây là xanh giả).
 */
const io = vi.hoisted(() => ({
  ORG: "dddd0000-0000-4000-8000-000000000001" as string,
  org: "dddd0000-0000-4000-8000-000000000001" as string | null,
  inserts: [] as Array<{ table: string; payload: unknown }>,
  /** Dữ liệu trả về cho truy vấn DANH SÁCH theo bảng (await builder / maybeSingle). */
  rows: {} as Record<string, unknown[]>,
  /** Dữ liệu trả về cho `.single()` theo bảng. */
  single: {} as Record<string, unknown>,
  rpc: vi.fn(),
}));

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of [
    "select", "eq", "neq", "is", "in", "not", "or", "ilike", "gte", "lte", "gt", "lt",
    "order", "limit", "range", "delete", "update", "filter", "match", "contains", "returns",
  ]) {
    b[m] = () => b;
  }
  b.insert = (payload: unknown) => {
    io.inserts.push({ table, payload });
    return b;
  };
  b.upsert = b.insert;
  b.single = async () => ({ data: io.single[table] ?? { id: `${table}-id` }, error: null });
  b.maybeSingle = async () => ({ data: (io.rows[table] ?? [])[0] ?? null, error: null });
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: io.rows[table] ?? [], error: null, count: (io.rows[table] ?? []).length })
      .then(res, rej);
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => builder(table),
    rpc: (...args: unknown[]) => io.rpc(...args),
    storage: {
      from: () => ({
        upload: async () => ({ data: { path: "p" }, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "https://cdn.invalid/x" } }),
      }),
    },
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (o: { mutationFn: (...a: unknown[]) => unknown }) => ({
    ...o, mutateAsync: o.mutationFn, mutate: o.mutationFn, isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(), setQueryData: vi.fn(), getQueryData: vi.fn(),
    removeQueries: vi.fn(), cancelQueries: vi.fn(), getQueriesData: vi.fn(() => []),
  }),
  useQuery: () => ({ data: undefined, isLoading: false }),
  keepPreviousData: (x: unknown) => x,
}));
vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: io.org }),
}));
vi.mock("@/lib/authSession", () => ({
  getSessionUser: async () => ({ id: "user-1", email: "u@example.invalid", user_metadata: { full_name: "Tester" } }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }), toast: vi.fn() }));
vi.mock("@/hooks/useRealtimeDataSync", () => ({ markLocalWrite: vi.fn() }));
vi.mock("@/lib/invoiceUtils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invoiceUtils")>()),
  generateInvoiceNumber: async () => "HD-TEST",
}));
vi.mock("@/hooks/income-expenses/accountingClass", () => ({
  loadIncomeExpenseAccountingClassResolver: async () => () => "PNL",
}));

import { useBulkCreateContracts, useSyncContractCustomers, useSyncContractServices } from "../useContracts";
import { useCreateCustomer, useUpdateCustomer } from "../useCustomers";
import { useCreateDeposit } from "../useDeposits";
import { useCreateDocumentTemplate } from "../useDocumentTemplates";
import { useCreateFloor } from "../useFloors";
import {
  useBulkCreateMeterReadings as useBulkCreateMeterReadingsLegacy,
  useCreateInvoice,
  useRecordMeterReading,
  useUpdateInvoice,
} from "../useInvoices";
import { useCreateJob } from "../useJobs";
import { useCreateLead } from "../useLeads";
import { useBulkCreateMeterReadings, useCreateMeterReading } from "../useMeterReadings";
import { useCreateMeter } from "../useMeters";
import { useCreatePayment } from "../usePayments";
import { useBulkCreateRooms, useCreateRoom } from "../useRooms";
import { useCreateService, useUpdateService } from "../useServices";
import { useCreateTenant } from "../useTenants";
import { useCreateVehicle } from "../useVehicles";
import { useCreateIncomeExpenseBatch } from "../income-expenses/batch";
import { useSubmitExcelInvoices } from "../invoices/useExcelInvoiceData";

type Mut = { mutationFn: (input: never) => Promise<unknown> };
const run = (hook: () => unknown, input: unknown) =>
  (hook() as Mut).mutationFn(input as never);

const ORG = io.ORG;
const insertsOf = (table: string) => io.inserts.filter((i) => i.table === table);
/** Mọi dòng của một lần insert (object đơn hay mảng) phải mang org đang chọn. */
const expectOrg = (table: string) => {
  const found = insertsOf(table);
  expect(found.length, `không có insert nào vào ${table}`).toBeGreaterThan(0);
  for (const { payload } of found) {
    const rows = Array.isArray(payload) ? payload : [payload];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toEqual(expect.objectContaining({ organization_id: ORG }));
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  io.org = ORG;
  io.inserts = [];
  io.rows = {};
  io.single = {};
  io.rpc.mockResolvedValue({ data: { id: "rpc-id" }, error: null });
});

describe("useContracts", () => {
  it("useSyncContractCustomers gửi organization_id cho từng dòng contract_customers", async () => {
    await run(useSyncContractCustomers, {
      contractId: "c1",
      customers: [{ customer_id: "k1", is_representative: true }, { customer_id: "k2", is_representative: false }],
    });
    expectOrg("contract_customers");
    expect((insertsOf("contract_customers")[0]?.payload as unknown[]).length).toBe(2);
  });

  it("useSyncContractServices gửi organization_id cho từng dòng contract_services", async () => {
    await run(useSyncContractServices, { contractId: "c1", services: [{ service_id: "s1", unit_price: 3500 }] });
    expectOrg("contract_services");
  });

  it("useBulkCreateContracts gửi organization_id cho tenants, contracts, contract_tenants", async () => {
    io.rows.rooms = [{ id: "r1", name: "P101", code: "P101" }];
    io.rows.tenants = [];
    const result = (await run(useBulkCreateContracts, {
      building_id: "b1",
      contracts: [{
        room_name: "P101", tenant_name: "Khách A", tenant_phone: "0900000001",
        signed_date: "2026-09-01", start_date: "2026-09-01", end_date: "2027-08-31", rent_price: 3000000,
      }],
    })) as { success: number; failed: number; errors: unknown[] };
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(1);
    expectOrg("tenants");
    expectOrg("contracts");
    expectOrg("contract_tenants");
  });
});

describe("useCustomers", () => {
  const form = {
    full_name: "Khách A", phone: "0900000001",
    vehicles: [{ vehicle_type: "MOTORBIKE", vehicle_name: "Wave", license_plate: "59A1-00001" }],
  };

  it("useCreateCustomer gửi organization_id cho customers và vehicles kèm theo", async () => {
    await run(useCreateCustomer, form);
    expectOrg("customers");
    expectOrg("vehicles");
    expect(insertsOf("vehicles")[0]?.payload).toEqual([
      expect.objectContaining({ customer_id: "customers-id", organization_id: ORG }),
    ]);
  });

  it("useUpdateCustomer gửi organization_id cho xe thêm mới qua syncCustomerVehicles", async () => {
    io.rows.vehicles = [];
    await run(useUpdateCustomer, { id: "k1", data: form });
    expectOrg("vehicles");
  });

  it("chưa chọn công ty ⇒ ném 'Chưa chọn công ty' và KHÔNG insert gì", async () => {
    io.org = null;
    await expect(run(useCreateCustomer, form)).rejects.toThrow("Chưa chọn công ty");
    expect(io.inserts).toEqual([]);
  });

  it("chưa chọn công ty ⇒ đường mảng cũng ném trước khi insert", async () => {
    io.org = null;
    await expect(
      run(useSyncContractCustomers, { contractId: "c1", customers: [{ customer_id: "k1", is_representative: true }] }),
    ).rejects.toThrow("Chưa chọn công ty");
    expect(insertsOf("contract_customers")).toEqual([]);
  });
});

describe("hook tạo một dòng", () => {
  it("useCreateDeposit → deposits", async () => {
    await run(useCreateDeposit, { room_id: "r1", tenant_id: "t1", amount: 1000000, deposit_date: "2026-09-01" });
    expectOrg("deposits");
  });

  it("useCreateDocumentTemplate → document_templates", async () => {
    io.rows.document_templates = [];
    await run(useCreateDocumentTemplate, {
      name: "Mẫu HĐ", category: "CONTRACT", is_default: false,
      file: new File(["x"], "mau.docx", { type: "application/octet-stream" }),
    });
    expectOrg("document_templates");
  });

  it("useCreateFloor → floors", async () => {
    await run(useCreateFloor, { building_id: "b1", name: "Tầng 1", floor_number: 1 });
    expectOrg("floors");
  });

  it("useCreateJob → jobs (kể cả khi building_id null — không có cha để suy)", async () => {
    await run(useCreateJob, { title: "Sửa vòi nước", building_id: null });
    expectOrg("jobs");
  });

  it("useCreateLead → leads", async () => {
    await run(useCreateLead, { full_name: "Khách hẹn", phone: "0900000002" });
    expectOrg("leads");
  });

  it("useCreateMeter → meters", async () => {
    io.rows.services = [{ id: "svc-dien" }];
    await run(useCreateMeter, { room_id: "r1", meter_type: "ELECTRICITY", code: "CT-001" });
    expectOrg("meters");
    expect(insertsOf("meters")[0]?.payload).toEqual(expect.objectContaining({ service_id: "svc-dien" }));
  });

  it("useCreateMeterReading → meter_readings", async () => {
    await run(useCreateMeterReading, { meter_id: "m1", reading_date: "2026-09-01", current_reading: 120 });
    expectOrg("meter_readings");
  });

  it("useBulkCreateMeterReadings (useMeterReadings) → meter_readings từng dòng", async () => {
    await run(useBulkCreateMeterReadings, [
      { meter_id: "m1", reading_date: "2026-09-01", current_reading: 120 },
      { meter_id: "m2", reading_date: "2026-09-01", current_reading: 80 },
    ]);
    expectOrg("meter_readings");
    expect((insertsOf("meter_readings")[0]?.payload as unknown[]).length).toBe(2);
  });

  it("useCreatePayment (không hoá đơn — không có cha để suy) → payments", async () => {
    await run(useCreatePayment, { amount: 500000, payment_date: "2026-09-01", payment_method: "CASH" });
    expectOrg("payments");
  });

  it("useCreateRoom → rooms", async () => {
    await run(useCreateRoom, { building_id: "b1", name: "P101", code: "P101" });
    expectOrg("rooms");
  });

  it("useBulkCreateRooms → rooms từng dòng", async () => {
    await run(useBulkCreateRooms, [{ building_id: "b1", name: "P101", code: "P101" }, { building_id: "b1", name: "P102", code: "P102" }]);
    expectOrg("rooms");
  });

  it("useCreateService → services và building_services", async () => {
    await run(useCreateService, { name: "Điện", code: "DIEN", building_ids: ["b1", "b2"] });
    expectOrg("services");
    expectOrg("building_services");
    expect((insertsOf("building_services")[0]?.payload as unknown[]).length).toBe(2);
  });

  it("useUpdateService → building_services cho toà mới gán", async () => {
    io.rows.building_services = [];
    await run(useUpdateService, { id: "s1", updates: { name: "Điện" }, building_ids: ["b9"] });
    expectOrg("building_services");
  });

  it("useCreateTenant → tenants", async () => {
    await run(useCreateTenant, { full_name: "Khách B", phone: "0900000003" });
    expectOrg("tenants");
  });

  it("useCreateVehicle → vehicles", async () => {
    await run(useCreateVehicle, { vehicle_type: "MOTORBIKE", license_plate: "59A1-00002" });
    expectOrg("vehicles");
  });
});

describe("useInvoices", () => {
  const form = {
    contract_id: "c1", building_id: "b1", room_id: "r1",
    billing_month: "2026-09", issue_date: "2026-09-01", due_date: "2026-09-05",
    discount_amount: 0, prepaid_amount: 0, previous_debt: 0,
    items: [
      { type: "RENT", accounting_class: "REVENUE", description: "Tiền phòng", unit_price: 3000000, quantity: 1, coefficient: 1, sort_order: 0 },
    ],
  };

  it("useCreateInvoice (đường legacy khi RPC chưa có) → invoices và invoice_items", async () => {
    io.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    io.single.invoices = { id: "inv-1", status: "DRAFT", paid_amount: 0 };
    await run(useCreateInvoice, form);
    expectOrg("invoices");
    expectOrg("invoice_items");
  });

  it("useUpdateInvoice (đường legacy) → invoice_items thay mới", async () => {
    io.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    io.single.invoices = { id: "inv-1", status: "DRAFT", paid_amount: 0 };
    await run(useUpdateInvoice, { id: "inv-1", formData: form });
    expectOrg("invoice_items");
  });

  it("useRecordMeterReading → meter_readings", async () => {
    await run(useRecordMeterReading, {
      contract_id: "c1", service_id: "s1", meter_type: "ELECTRIC", reading_date: "2026-09-01",
      current_reading: 120, previous_reading: 100,
    });
    expectOrg("meter_readings");
  });

  it("useBulkCreateMeterReadings (useInvoices) → meter_readings từng dòng", async () => {
    await run(useBulkCreateMeterReadingsLegacy, [{
      contract_id: "c1", service_id: "s1", meter_type: "ELECTRIC", reading_date: "2026-09-01",
      current_reading: 120, previous_reading: 100,
    }]);
    expectOrg("meter_readings");
  });
});

describe("income-expenses/batch", () => {
  it("useCreateIncomeExpenseBatch → income_expense_batches và income_expense_batch_items", async () => {
    io.rpc.mockResolvedValue({ data: { id: "phieu-con-1" }, error: null });
    await run(useCreateIncomeExpenseBatch, {
      type: "EXPENSE", shared_name: "Bảo trì tháng 9", account_id: "acc-1", voucher_date: "2026-09-01",
      attachments: [], business_result_accounting: null,
      items: [{ income_expense_type_id: "t1", building_id: "b1", quantity: 1, unit_price: 500000 }],
    });
    expectOrg("income_expense_batches");
    expectOrg("income_expense_batch_items");
    expect(insertsOf("income_expense_batch_items")[0]?.payload).toEqual([
      expect.objectContaining({ income_expense_id: "phieu-con-1", organization_id: ORG }),
    ]);
  });
});

describe("invoices/useExcelInvoiceData", () => {
  it("useSubmitExcelInvoices chốt chỉ số điện với organization_id", async () => {
    const { submit } = useSubmitExcelInvoices() as unknown as {
      submit: (rows: unknown[], ctx: unknown) => Promise<{ ok: number; fail: number; readingFails: string[] }>;
    };
    const row = {
      contract_id: "c1", room_id: "r1", room_name: "P101", rent_price: 3000000, occupants: 1,
      meter_id: "m1", prev_reading: 100, prev_reading_overridden: false, current_reading: 120,
      electric_amount: 70000, electric_overridden: false, water_amount: 0, water_overridden: false,
      pdv_amount: 0, pdv_overridden: false, elec_rate: 3500, elec_service_id: "svc-dien",
      water_rate: 0, water_service_id: null, water_applicable: false, pdv_rate: 0, pdv_service_id: null,
      pdv_applicable: false, services_raw: [], discount: 0, discount_notes: "", applied_credit: 0,
      credit_balance: 0, previous_debt: 0, previous_debt_sources: [], previous_debt_overridden: false,
      period_start_date: null, period_end_date: null, selected: true,
    };
    const ctx = {
      buildingId: "b1", billingMonth: "2026-09", issueDate: "2026-09-01", dueDate: "2026-09-05",
      periodStart: new Date("2026-09-01"), fromDate: "2026-09-01", toDate: "2026-09-30",
    };
    const result = await submit([row], ctx);
    expect(result.readingFails).toEqual([]);
    expect(result.ok).toBe(1);
    expectOrg("meter_readings");
  });
});
