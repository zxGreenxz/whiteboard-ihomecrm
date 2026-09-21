import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useOrganization } from "@/contexts/OrganizationContext";
import type { SettlementSourceRef } from "@/lib/contractSettlement";
import {
  createContractSettlementVoucher,
  verifySettlementExistingVoucher,
  settlementCreateSourceId,
  SettlementCreateError,
  type SettlementCreateDraft,
  type SettlementCreateResult,
  type SettlementCreateSource,
} from "@/lib/contractSettlementCreate";
import { settlementCreateRepository } from "@/lib/contractSettlementCreateRepository";
const refreshRoots = [
  "contract-settlement",
  "contract-settlement-events",
  "settlement-financial-context",
  "room-cash-lifecycle",
  "income-expenses",
  "income-expense-stats",
  "income-expense-action-snapshots",
  "termination-refund-preview",
  "sale-bonus-status",
  "existing-commission-vouchers",
  "deposits",
];
export function useContractSettlementCreate(args: {
  sourceRef: SettlementSourceRef;
  onCreated: (result: SettlementCreateResult) => void;
  refreshRequired: () => Promise<void>;
  onBusyChange?: (blocked: boolean) => void;
}) {
  const { data: actor } = useAuth(),
    { selectedOrganizationId: org } = useOrganization(),
    client = useQueryClient();
  const actorId = actor?.id ?? "",
    organizationId = org ?? "",
    identity = JSON.stringify([actorId, organizationId, args.sourceRef]);
  const repository = useMemo(
    () => settlementCreateRepository(actorId, organizationId),
    [actorId, organizationId],
  );
  const current = useRef(identity);
  current.current = identity;
  const running = useRef(false),
    locked = useRef(false),
    operationIdentity = useRef<string | null>(null),
    busyCallback = useRef(args.onBusyChange);
  busyCallback.current = args.onBusyChange;
  const [reviewed, setReviewed] = useState<SettlementCreateSource | null>(null),
    [phase, setPhase] = useState<
      "idle" | "writing" | "refreshing" | "unknown" | "refresh-failed"
    >("idle"),
    [message, setMessage] = useState<string | null>(null),
    pendingResult = useRef<SettlementCreateResult | null>(null);
  const enabled =
    !!actorId &&
    organizationId === args.sourceRef.organizationId &&
    args.sourceRef.kind !== "reservation_refund";
  const query = useQuery({
    queryKey: [
      "contract-settlement-create-source",
      actorId,
      organizationId,
      args.sourceRef,
    ],
    enabled,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always",
    refetchInterval: 30000,
    queryFn: () => {
      if (args.sourceRef.kind === "reservation_refund")
        throw new Error("Luồng hoàn giữ chỗ chưa sẵn sàng.");
      return repository.readSource(args.sourceRef);
    },
  });
  useEffect(() => {
    if (!running.current && !locked.current) {
      setReviewed(null);
      setMessage(null);
      setPhase("idle");
      pendingResult.current = null;
      operationIdentity.current = null;
    }
  }, [identity]);
  useEffect(() => {
    if (query.data && !reviewed && enabled && !locked.current)
      setReviewed(query.data);
  }, [query.data, reviewed, enabled]);
  const blocked = phase !== "idle";
  useEffect(() => {
    busyCallback.current?.(blocked);
  }, [blocked]);
  useEffect(() => () => busyCallback.current?.(false), []);
  const assertIdentity = (start: string) => {
    if (current.current !== start)
      throw new SettlementCreateError(
        "unconfirmed",
        "Phạm vi đã thay đổi trong lúc xử lý. Trở lại đúng tổ chức và nguồn để đối chiếu kết quả.",
      );
  };
  async function refresh(result: SettlementCreateResult, start: string) {
    assertIdentity(start);
    setPhase("refreshing");
    await client.invalidateQueries(
      { predicate: (q) => refreshRoots.includes(String(q.queryKey[0])) },
      { throwOnError: true },
    );
    assertIdentity(start);
    const r = await query.refetch();
    if (r.error || !r.data) throw new Error("Chưa tải lại được nguồn.");
    assertIdentity(start);
    await args.refreshRequired();
    assertIdentity(start);
    args.onCreated(result);
    pendingResult.current = null;
    locked.current = false;
    operationIdentity.current = null;
    setPhase("idle");
  }
  async function createFromSource(draft: SettlementCreateDraft) {
    if (running.current || locked.current)
      throw new SettlementCreateError(
        "blocked",
        "Đang đối chiếu yêu cầu trước.",
      );
    if (!enabled || !reviewed)
      throw new SettlementCreateError(
        "blocked",
        "Chưa đọc đủ nguồn trong tổ chức hiện tại.",
      );
    const start = identity;
    running.current = true;
    operationIdentity.current = start;
    busyCallback.current?.(true);
    setPhase("writing");
    setMessage(null);
    try {
      const guard =
        <A extends unknown[], R>(fn: (...input: A) => Promise<R>) =>
        async (...input: A) => {
          assertIdentity(start);
          const result = await fn(...input);
          assertIdentity(start);
          return result;
        };
      const guarded = {
        readSource: guard(repository.readSource),
        readVoucher: guard(repository.readVoucher),
        createCommission: guard(repository.createCommission),
        createDeposit: guard(repository.createDeposit),
        previewRefund: guard(repository.previewRefund),
        recordObligation: guard(repository.recordObligation),
        readObligation: guard(repository.readObligation),
        createRefund: guard(repository.createRefund),
      };
      const result = await createContractSettlementVoucher(
        {
          actorId,
          sourceRef: args.sourceRef,
          expectedRevision: reviewed.revision,
          draft,
        },
        guarded,
      );
      pendingResult.current = result;
      locked.current = true;
      await refresh(result, start);
    } catch (error) {
      if (pendingResult.current) {
        locked.current = true;
        setPhase("refresh-failed");
        setMessage(
          "Đã nhận phiếu, chưa tải lại được. Tải lại để đối chiếu trước khi thao tác tiếp.",
        );
      } else if (
        error instanceof SettlementCreateError &&
        error.kind === "unconfirmed"
      ) {
        locked.current = true;
        setPhase("unknown");
        setMessage(error.message);
      } else {
        setPhase("idle");
        setMessage(
          error instanceof Error ? error.message : "Không thể lập phiếu.",
        );
      }
      throw error;
    } finally {
      running.current = false;
    }
  }
  async function reconcile() {
    if (running.current || !enabled) return;
    running.current = true;
    busyCallback.current?.(true);
    const wasLocked = locked.current,
      start = operationIdentity.current ?? identity;
    try {
      assertIdentity(start);
      if (pendingResult.current) {
        await refresh(pendingResult.current, start);
        return;
      }
      const r = await query.refetch();
      if (r.error || !r.data) throw new Error("Chưa tải lại được nguồn.");
      assertIdentity(start);
      if (r.data.existingVoucherId) {
        const result = await verifySettlementExistingVoucher(
          r.data,
          repository,
        );
        assertIdentity(start);
        pendingResult.current = result;
        locked.current = true;
        operationIdentity.current = start;
        await refresh(pendingResult.current, start);
      } else if (wasLocked) {
        setMessage(
          "Chưa tìm thấy phiếu của yêu cầu trước. Cần đối chiếu kết quả; không gửi lại tự động.",
        );
        setPhase("unknown");
      } else {
        setReviewed(r.data);
        setMessage(null);
        setPhase("idle");
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Chưa đối chiếu được.",
      );
      setPhase(
        pendingResult.current
          ? "refresh-failed"
          : wasLocked
            ? "unknown"
            : "idle",
      );
    } finally {
      running.current = false;
      busyCallback.current?.(locked.current);
    }
  }
  const reviewedInScope =
    args.sourceRef.kind !== "reservation_refund" &&
    reviewed?.actorId === actorId &&
    reviewed?.organizationId === organizationId &&
    reviewed?.kind === args.sourceRef.kind &&
    reviewed?.sourceId === settlementCreateSourceId(args.sourceRef);
  return {
    source: enabled && reviewedInScope ? reviewed : null,
    loading: enabled && query.isLoading,
    error: !enabled
      ? "Nguồn chưa sẵn sàng trong tổ chức hiện tại."
      : operationIdentity.current && operationIdentity.current !== identity
        ? "Trở lại nguồn trước để đối chiếu yêu cầu đang xử lý."
        : (query.error?.message ?? null),
    phase,
    blocked,
    message,
    createFromSource,
    reconcile,
  };
}
