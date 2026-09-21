// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ReservationRefundDraft,
  ReservationRefundSource,
} from "@/lib/reservationRefundWorkflow";
const m = vi.hoisted(() => ({
  org: "10000000-0000-4000-8000-000000000001",
  actor: "20000000-0000-4000-8000-000000000001",
  source: null as unknown,
  create: vi.fn(),
  read: vi.fn(),
  voucher: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ data: { id: m.actor } }),
}));
vi.mock("@/contexts/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: m.org }),
}));
vi.mock("@/lib/reservationRefundRepository", () => ({
  reservationRefundRepository: () => ({
    readSource: m.read,
    readVoucher: m.voucher,
  }),
}));
vi.mock("@/lib/reservationRefundWorkflow", async (load) => ({
  ...(await load<typeof import("@/lib/reservationRefundWorkflow")>()),
  createReservationRefundPending: m.create,
}));
import { SettlementCreateError } from "@/lib/contractSettlementCreate";
import { useReservationRefundCreate } from "../useReservationRefundCreate";
const sourceId = "30000000-0000-4000-8000-000000000001",
  voucherId = "40000000-0000-4000-8000-000000000001";
const draft = {
  recipientName: "Nguoi nhan",
  bank: "",
  accountNumber: "",
} as ReservationRefundDraft;
const clients: QueryClient[] = [];
beforeEach(() => {
  m.org = "10000000-0000-4000-8000-000000000001";
  m.actor = "20000000-0000-4000-8000-000000000001";
  m.source = {
    actorId: m.actor,
    organizationId: m.org,
    sourceVoucherId: sourceId,
    settlementId: sourceId,
    sourceCode: "GC",
    payerName: "Nguoi nhan",
    sourceDate: "2026-09-21",
    settlementDate: "2026-09-21",
    today: "2026-09-21",
    basisFingerprint: "basis",
    basisValid: true,
    depositAmount: 100,
    retainedAmount: 0,
    refundAmount: 100,
    paid: 0,
    remaining: 100,
    canCreate: true,
    hiddenExisting: false,
    blockedReason: null,
    revision: "reviewed",
    existingVoucherId: null,
  } as ReservationRefundSource;
  m.read.mockImplementation(async () => m.source);
  m.voucher.mockResolvedValue({ id: voucherId });
  m.create.mockResolvedValue({ outcome: "created", voucherId });
});
afterEach(() => {
  cleanup();
  for (const c of clients) c.clear();
  vi.resetAllMocks();
});
async function setup(refreshRequired = vi.fn().mockResolvedValue(undefined)) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  const props = {
    sourceRef: {
      kind: "reservation_refund" as const,
      organizationId: m.org,
      sourceVoucherId: sourceId,
      settlementId: sourceId,
      refundVoucherId: null,
    },
    onCreated: vi.fn(),
    refreshRequired,
    onBusyChange: vi.fn(),
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useReservationRefundCreate(props), {
    wrapper,
  });
  await waitFor(() => expect(hook.result.current.source).toBeTruthy());
  return { hook, props };
}
it("locks synchronously against double submit and opens only after mandatory refresh", async () => {
  let resolve!: (v: unknown) => void;
  m.create.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const { hook, props } = await setup();
  let first!: Promise<void>;
  act(() => {
    first = hook.result.current.createFromSource(draft);
  });
  expect(props.onBusyChange).toHaveBeenLastCalledWith(true);
  await act(async () => {
    await expect(
      hook.result.current.createFromSource(draft),
    ).rejects.toMatchObject({ kind: "blocked" });
  });
  expect(m.create).toHaveBeenCalledTimes(1);
  expect(props.onCreated).not.toHaveBeenCalled();
  await act(async () => {
    resolve({ outcome: "created", voucherId });
    await first;
  });
  expect(props.refreshRequired).toHaveBeenCalledTimes(1);
  expect(props.onCreated).toHaveBeenCalledExactlyOnceWith({
    outcome: "created",
    voucherId,
  });
});
it("keeps a confirmed result locked across failed refresh and reconciles without another write", async () => {
  const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValue(undefined),
    { hook, props } = await setup(refresh);
  await act(async () => {
    await expect(hook.result.current.createFromSource(draft)).rejects.toThrow(
      "refresh failed",
    );
  });
  expect(hook.result.current.phase).toBe("refresh-failed");
  expect(props.onCreated).not.toHaveBeenCalled();
  await act(async () => {
    await expect(
      hook.result.current.createFromSource(draft),
    ).rejects.toMatchObject({ kind: "blocked" });
    await hook.result.current.reconcile();
  });
  expect(m.create).toHaveBeenCalledTimes(1);
  expect(props.onCreated).toHaveBeenCalledTimes(1);
});
it("retains unknown outcome without a claim and never blindly retries", async () => {
  m.create.mockRejectedValue(
    new SettlementCreateError("unconfirmed", "Chưa xác nhận"),
  );
  const { hook, props } = await setup();
  await act(async () => {
    await expect(
      hook.result.current.createFromSource(draft),
    ).rejects.toMatchObject({ kind: "unconfirmed" });
    await hook.result.current.reconcile();
  });
  expect(hook.result.current.phase).toBe("unknown");
  expect(hook.result.current.blocked).toBe(true);
  expect(props.onCreated).not.toHaveBeenCalled();
  expect(m.create).toHaveBeenCalledTimes(1);
});
it("does not open an old result after organization changes during the write", async () => {
  let resolve!: (v: unknown) => void;
  m.create.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const { hook, props } = await setup();
  let first!: Promise<void>;
  act(() => {
    first = hook.result.current.createFromSource(draft);
  });
  m.org = "90000000-0000-4000-8000-000000000001";
  hook.rerender();
  await act(async () => {
    resolve({ outcome: "created", voucherId });
    await expect(first).rejects.toMatchObject({ kind: "unconfirmed" });
  });
  expect(props.onCreated).not.toHaveBeenCalled();
  expect(hook.result.current.source).toBeNull();
  expect(hook.result.current.blocked).toBe(true);
});
