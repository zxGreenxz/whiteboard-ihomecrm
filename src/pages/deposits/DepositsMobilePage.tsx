import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Plus } from "lucide-react";
import "@/styles/mobileApp.css";
import "./depositsMobile.css";
import { useQueryClient } from "@tanstack/react-query";
import { usePersistedState } from "@/hooks/usePersistedState";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { useApproveVoucher } from "@/hooks/income-expenses/statusMutations";
import {
  useHeldDeposits,
  useHeldDepositSummary,
  useRefundForfeitSummary,
} from "@/hooks/useDepositDashboard";
import { useReservationDeposits } from "@/hooks/useDeposits";
import { useReservationHoldDeadlines } from "@/hooks/useReservationHoldDeadlines";
import { CreateDepositDialog } from "@/components/deposits/CreateDepositDialog";
import {
  HoldDeadlineDialog,
  type HoldDeadlineTarget,
} from "@/components/deposits/HoldDeadlineDialog";
import {
  ContractFormDialog,
  type ContractPrefill,
} from "@/components/contracts/ContractFormDialog";
import { formatCurrency } from "@/lib/utils";
import { formatISODateVN, formatISODayMonth, vnTodayISO } from "@/lib/vnDate";
import {
  buildDepositWorkQueue,
  countTasks,
  formatMoneyShort,
  type DepositTask,
  type DepositTaskTone,
} from "@/lib/depositWorkQueue";

/**
 * Quản lý Cọc — màn hình app full-screen trên điện thoại (bản 2b của handoff
 * Claude Design). Nối dữ liệu THẬT, dùng chung lõi hàng đợi với desktop
 * (`buildDepositWorkQueue`) nên hai màn không thể nói hai chuyện khác nhau về
 * việc nào đang gấp.
 *
 * Không có thanh tab dưới: điều hướng bằng hai pill "Cần xử lý" / "Sổ cọc",
 * đúng bản vẽ. Chạm một thẻ mở bảng thao tác trượt lên.
 *
 * Nút + mở CHÍNH `CreateDepositDialog` của desktop thay vì dựng lại form trong
 * màn — form đó là nơi duy nhất biết luật tạo phiếu cọc (khoá giữ phòng, sổ quỹ
 * bắt buộc, thưởng Sale). Dựng bản thứ hai cho mobile là tạo ra hai luật.
 */

type MobileView = "work" | "ledger";
type LedgerFilter = "ALL" | "SHORT" | "HOLD";

const TONE_CLASS: Record<DepositTaskTone, string> = {
  danger: "danger",
  warn: "warn",
  ok: "ok",
  pending: "pending",
};

function headline(task: DepositTask): string {
  switch (task.kind) {
    case "HOLD_OVERDUE":
      return `⚠ QUÁ HẠN LÀM HĐ · ${task.buildingName}`;
    case "TOPUP_OVERDUE":
      return `⚠ THIẾU CỌC · ${task.buildingName}`;
    case "TOPUP_DUE_SOON":
      return `THIẾU CỌC · ${task.buildingName}`;
    case "RESV_TOPUP_OVERDUE":
      return `⚠ THIẾU CỌC GIỮ CHỖ · ${task.buildingName}`;
    case "RESV_TOPUP_DUE_SOON":
      return `THIẾU CỌC GIỮ CHỖ · ${task.buildingName}`;
    default:
      return `GIỮ CHỖ · ${task.buildingName}`;
  }
}

function subline(task: DepositTask): string {
  if (task.paidAmount !== null && task.expectedAmount !== null) {
    return `${task.personName} · đã thu ${formatMoneyShort(task.paidAmount)} / ${formatMoneyShort(
      task.expectedAmount,
    )}`;
  }
  const bits = [task.personName];
  if (task.code) bits.push(task.code);
  return bits.join(" · ");
}

function deadlineText(task: DepositTask): string {
  const { daysToDue: d, dueDate } = task;
  if (d === null || !dueDate) {
    return task.kind === "PENDING_APPROVAL" && task.heldDays !== null
      ? `chờ ${task.heldDays} ngày`
      : "chưa đặt hạn";
  }
  const day = formatISODayMonth(dueDate);
  const label =
    task.kind === "HOLD_OVERDUE" || task.kind === "HOLD_READY"
      ? "hạn HĐ"
      : task.kind === "RESV_TOPUP_OVERDUE" || task.kind === "RESV_TOPUP_DUE_SOON"
        ? "bổ sung"
        : "hẹn";
  if (d < 0) return `${label} ${day} · trễ ${-d}n`;
  if (d === 0) return `${label} ${day} · hôm nay`;
  return `${label} ${day} · còn ${d}n`;
}

export default function DepositsMobilePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: perms } = useMyPermissions();
  const canCreate = canUse(perms, "deposits", "create");
  const canConvert = canUse(perms, "deposits", "convert");
  const canApprove = canUse(perms, "deposits", "edit");

  const [view, setView] = usePersistedState<MobileView>("flt:deposits:mview", "work");
  const [ledgerFilter, setLedgerFilter] = usePersistedState<LedgerFilter>(
    "flt:deposits:mfilter",
    "ALL",
  );
  const [openTaskKey, setOpenTaskKey] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [contractOpen, setContractOpen] = useState(false);
  const [prefill, setPrefill] = useState<ContractPrefill | null>(null);
  const [deadlineTarget, setDeadlineTarget] = useState<HoldDeadlineTarget | null>(null);

  const approveVoucher = useApproveVoucher();
  const { data: held = [], isLoading: heldLoading } = useHeldDeposits();
  const { data: reservations = [], isLoading: resvLoading } = useReservationDeposits();
  const { data: heldAgg = [] } = useHeldDepositSummary();
  const { data: rfSummary } = useRefundForfeitSummary();
  const { data: holdTerms = {} } = useReservationHoldDeadlines();

  const kpi = useMemo(() => {
    const heldTotal = heldAgg.reduce((s, r) => s + r.held, 0);
    const expected = heldAgg.reduce((s, r) => s + r.expected, 0);
    const shortfall = heldAgg.reduce((s, r) => s + r.shortfallShort, 0);
    const shortCount = heldAgg.reduce((s, r) => s + r.shortCount, 0);
    return { heldTotal, expected, shortfall, shortCount };
  }, [heldAgg]);

  const holdRows = useMemo(
    () => reservations.filter((r) => r.approval_status !== "CANCELLED"),
    [reservations],
  );
  const holdTotal = useMemo(
    () => holdRows.reduce((s, r) => s + r.total_amount, 0),
    [holdRows],
  );

  const groups = useMemo(
    () => buildDepositWorkQueue({ today: vnTodayISO(), held, reservations, holdTerms }),
    [held, reservations, holdTerms],
  );
  const todoCount = countTasks(groups);

  const openTask = useMemo(() => {
    if (!openTaskKey) return null;
    for (const g of groups) {
      const found = g.tasks.find((t) => t.key === openTaskKey);
      if (found) return found;
    }
    return null;
  }, [groups, openTaskKey]);

  // ── Sổ cọc: gộp hợp đồng thiếu cọc + phiếu giữ chỗ thành một danh sách ──
  const ledgerRows = useMemo(() => {
    const shortRows = held
      .filter((r) => r.state !== "FULL")
      .map((r) => ({
        id: `c:${r.contract_id}`,
        kind: "SHORT" as const,
        dot: "#e8730c",
        head: `P.${r.room_name} · ${r.building_name}`,
        sub: `${r.customer_name} · đã thu ${formatMoneyShort(r.deposit_paid)} / ${formatMoneyShort(r.total_deposit)}`,
        amount: Math.max(0, r.deposit_remaining),
        meta: r.deposit_topup_due_date
          ? `hẹn ${formatISODayMonth(r.deposit_topup_due_date)}`
          : "chưa hẹn",
        to: `/contracts/${r.contract_id}`,
      }));
    const resvRows = reservations.map((r) => ({
      id: `v:${r.id}`,
      kind: "HOLD" as const,
      dot:
        r.approval_status === "APPROVED"
          ? "#159a57"
          : r.approval_status === "UNAPPROVED"
            ? "#d9a514"
            : "#b9beba",
      head: `P.${r.room_name ?? "—"} · ${r.building_name}`,
      sub: `${r.payer_name ?? "—"}${r.code ? ` · ${r.code}` : ""}`,
      amount: r.total_amount,
      meta: formatISODayMonth(r.voucher_date),
      to: null as string | null,
    }));
    const all = [...shortRows, ...resvRows];
    if (ledgerFilter === "ALL") return all;
    return all.filter((r) => r.kind === ledgerFilter);
  }, [held, reservations, ledgerFilter]);

  const closeSheet = () => setOpenTaskKey(null);

  const handleCreateContract = (task: DepositTask) => {
    if (!task.roomId) return;
    setPrefill({ buildingId: task.buildingId, roomId: task.roomId });
    setContractOpen(true);
    closeSheet();
  };

  const handleApprove = (task: DepositTask) => {
    if (!task.voucherId) return;
    approveVoucher.mutate(task.voucherId, {
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey: ["reservation-deposits"] });
        closeSheet();
      },
    });
  };

  const loading = heldLoading || resvLoading;

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate("/")} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>{view === "work" ? "Quản lý Cọc" : "Sổ cọc"}</h1>
              <p>
                {formatMoneyShort(kpi.heldTotal)} đang giữ · {holdRows.length} phiếu giữ chỗ
              </p>
            </div>
            {/* Nút tạo nằm ở THANH TRÊN, không phải nút nổi góc dưới phải —
                chỗ đó đã có nút Copilot (`fixed … z-[9997]`, 56×56) đè lên mọi
                thứ nằm trong `.cm-stage` (stacking context z-index 0). Đã đo:
                nút "+" đặt ở đó bị che HOÀN TOÀN. Các trang app mobile khác
                (Hợp đồng, Toà nhà) cũng đặt nút tạo ở thanh trên vì lý do này. */}
            {canCreate && (
              <div className="mtop-act">
                <button className="mtop-btn" onClick={() => setCreateOpen(true)}>
                  <Plus />
                  Tạo
                </button>
              </div>
            )}
          </div>

          <div className="mbody dp-body" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {/* Dải KPI — số viết tắt để lọt một dòng trên máy hẹp; số chính xác
                nằm ở bảng thao tác và ở desktop. */}
            <div className="dp-kpi">
              <div className="dp-kpi-row">
                <div className="dp-kpi-cell">
                  <div className="lb">
                    <i className="bd" style={{ background: "#159a57" }} />
                    <span>ĐANG GIỮ</span>
                  </div>
                  <div className="val" style={{ color: "#159a57" }} title={formatCurrency(kpi.heldTotal)}>
                    {formatMoneyShort(kpi.heldTotal)}
                  </div>
                </div>
                <div className="dp-kpi-cell">
                  <div className="lb">
                    <i className="bd" style={{ background: "#e8730c" }} />
                    <span>CÒN THIẾU</span>
                  </div>
                  <div className="val" style={{ color: "#e8730c" }} title={formatCurrency(kpi.shortfall)}>
                    {formatMoneyShort(kpi.shortfall)}
                  </div>
                </div>
                <div className="dp-kpi-cell">
                  <div className="lb">
                    <i className="bd" style={{ background: "#2f6fb3" }} />
                    <span>GIỮ CHỖ</span>
                  </div>
                  <div className="val" style={{ color: "#2f6fb3" }} title={formatCurrency(holdTotal)}>
                    {formatMoneyShort(holdTotal)}
                  </div>
                </div>
              </div>
              <div className="dp-kpi-foot">
                <span>
                  Cần thu theo HĐ <strong>{formatMoneyShort(kpi.expected)}</strong>
                </span>
                <span className="r">
                  {kpi.shortCount} HĐ thiếu · {holdRows.length} phiếu giữ chỗ
                </span>
              </div>
              {rfSummary && rfSummary.orphanCount > 0 && (
                <div className="dp-kpi-warn">
                  ⚠ {rfSummary.orphanCount} phiếu hoàn ({formatMoneyShort(rfSummary.orphanTotal)})
                  chưa nối hồ sơ — rà tay
                </div>
              )}
            </div>

            <div className="dp-seg">
              <button
                type="button"
                className={view === "work" ? "on" : ""}
                onClick={() => setView("work")}
              >
                Cần xử lý · {todoCount}
              </button>
              <button
                type="button"
                className={view === "ledger" ? "on" : ""}
                onClick={() => setView("ledger")}
              >
                Sổ cọc · {held.filter((r) => r.state !== "FULL").length + reservations.length}
              </button>
            </div>

            {view === "work" && (
              <>
                {loading && (
                  <div className="stub">
                    <p>Đang tải hàng đợi…</p>
                  </div>
                )}
                {!loading && groups.length === 0 && (
                  <div className="dp-clear">
                    <b>Hết việc cần xử lý hôm nay</b>
                    <span>Mở sổ cọc để xem toàn bộ bản ghi</span>
                  </div>
                )}
                {groups.map((g) => (
                  <div key={g.kind} style={{ display: "contents" }}>
                    <div className={`dp-sec ${TONE_CLASS[g.tone]}`}>
                      <span>
                        {g.label} · {g.tasks.length}
                      </span>
                      <i />
                    </div>
                    {g.tasks.map((task) => (
                      <button
                        key={task.key}
                        type="button"
                        className={`dp-card ${TONE_CLASS[g.tone]}`}
                        onClick={() => setOpenTaskKey(task.key)}
                      >
                        <span className="dp-room">P.{task.roomName}</span>
                        <span className="dp-mid">
                          <b>{headline(task)}</b>
                          <span>{subline(task)}</span>
                        </span>
                        <span className="dp-right">
                          <b>{formatMoneyShort(task.amount)}</b>
                          <span>{deadlineText(task)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </>
            )}

            {view === "ledger" && (
              <>
                <div className="dp-chips">
                  {(
                    [
                      { id: "ALL" as const, label: "Tất cả" },
                      { id: "SHORT" as const, label: "Thiếu cọc" },
                      { id: "HOLD" as const, label: "Phiếu giữ chỗ" },
                    ]
                  ).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={ledgerFilter === c.id ? "on" : ""}
                      onClick={() => setLedgerFilter(c.id)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <div className="dp-filterline">
                  <b>
                    {ledgerFilter === "ALL"
                      ? "Thiếu cọc + giữ chỗ"
                      : ledgerFilter === "SHORT"
                        ? "Hợp đồng thiếu cọc"
                        : "Phiếu giữ chỗ"}
                  </b>
                  <i>· {ledgerRows.length} bản ghi</i>
                  {ledgerFilter !== "ALL" && (
                    <button
                      type="button"
                      onClick={() => setLedgerFilter("ALL")}
                      style={{
                        marginLeft: "auto",
                        border: 0,
                        background: "transparent",
                        color: "#cf3b30",
                        fontFamily: "inherit",
                        fontSize: 11.5,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      Bỏ lọc ✕
                    </button>
                  )}
                </div>
                {ledgerRows.length === 0 ? (
                  <div className="stub">
                    <p>Không có bản ghi nào khớp bộ lọc.</p>
                  </div>
                ) : (
                  <div className="dp-ledger">
                    {ledgerRows.map((r) => {
                      const body = (
                        <>
                          <span className="dot" style={{ background: r.dot }} />
                          <span className="tx">
                            <b>{r.head}</b>
                            <span>{r.sub}</span>
                          </span>
                          <span className="rt">
                            <b title={formatCurrency(r.amount)}>{formatMoneyShort(r.amount)}</b>
                            <span>{r.meta}</span>
                          </span>
                        </>
                      );
                      return r.to ? (
                        <Link key={r.id} to={r.to} className="dp-lrow" style={{ color: "inherit" }}>
                          {body}
                        </Link>
                      ) : (
                        <div key={r.id} className="dp-lrow">
                          {body}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Bảng thao tác — chạm thẻ để mở */}
          {openTask && (
            <div
              className="dp-sheet-mask"
              role="button"
              tabIndex={-1}
              onClick={closeSheet}
              aria-label="Đóng bảng thao tác"
            >
              <div
                className="dp-sheet"
                role="dialog"
                aria-modal="true"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="dp-sheet-grip" />
                <div className="dp-sheet-head">
                  <span className="dp-room">P.{openTask.roomName}</span>
                  <span className="t">
                    <b>{headline(openTask)}</b>
                    <span>{subline(openTask)}</span>
                  </span>
                  <span className="a">
                    <b>{formatCurrency(openTask.amount)}</b>
                    <span>{deadlineText(openTask)}</span>
                  </span>
                </div>
                <div className="dp-sheet-facts">
                  {openTask.expectedAmount !== null && (
                    <div>
                      <span>Cọc theo hợp đồng</span>
                      <b>{formatCurrency(openTask.expectedAmount)}</b>
                    </div>
                  )}
                  {openTask.paidAmount !== null && (
                    <div>
                      <span>Đã thu</span>
                      <b>{formatCurrency(openTask.paidAmount)}</b>
                    </div>
                  )}
                  <div>
                    <span>
                      {openTask.kind === "HOLD_OVERDUE" || openTask.kind === "HOLD_READY"
                        ? "Hạn phải làm hợp đồng"
                        : "Ngày hẹn"}
                    </span>
                    <b>{openTask.dueDate ? formatISODateVN(openTask.dueDate) : "chưa đặt"}</b>
                  </div>
                  {openTask.heldDays !== null && (
                    <div>
                      <span>Đã giữ</span>
                      <b>{openTask.heldDays} ngày</b>
                    </div>
                  )}
                </div>
                <div className="dp-sheet-acts">
                  {openTask.voucherId && openTask.kind !== "PENDING_APPROVAL" ? (
                    <button
                      type="button"
                      onClick={() => {
                        setDeadlineTarget({
                          voucherId: openTask.voucherId!,
                          label: `P.${openTask.roomName} · ${openTask.buildingName}`,
                          holdUntil: holdTerms[openTask.voucherId!]?.holdUntil ?? null,
                          topupDueDate: holdTerms[openTask.voucherId!]?.topupDueDate ?? null,
                          depositTarget: holdTerms[openTask.voucherId!]?.depositTarget ?? null,
                          paidAmount: openTask.paidAmount ?? openTask.amount,
                        });
                        closeSheet();
                      }}
                    >
                      {openTask.dueDate ? "Sửa kỳ hạn" : "Đặt kỳ hạn"}
                    </button>
                  ) : (
                    <button type="button" onClick={closeSheet}>
                      Đóng
                    </button>
                  )}
                  {openTask.contractId && (
                    <Link className="primary" to={`/contracts/${openTask.contractId}`}>
                      Mở hợp đồng
                    </Link>
                  )}
                  {openTask.kind === "PENDING_APPROVAL" && canApprove && openTask.voucherId && (
                    <button
                      type="button"
                      className="primary"
                      disabled={approveVoucher.isPending}
                      onClick={() => handleApprove(openTask)}
                    >
                      {approveVoucher.isPending ? "Đang duyệt…" : "Duyệt"}
                    </button>
                  )}
                  {(openTask.kind === "HOLD_READY" || openTask.kind === "HOLD_OVERDUE") &&
                    canConvert &&
                    openTask.roomId && (
                      <button
                        type="button"
                        className="primary"
                        onClick={() => handleCreateContract(openTask)}
                      >
                        Tạo hợp đồng
                      </button>
                    )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <CreateDepositDialog open={createOpen} onOpenChange={setCreateOpen} />
      <HoldDeadlineDialog
        target={deadlineTarget}
        onOpenChange={(open) => !open && setDeadlineTarget(null)}
      />
      {prefill && (
        <ContractFormDialog
          open={contractOpen}
          onOpenChange={setContractOpen}
          prefill={prefill}
          onCreated={() =>
            queryClient.invalidateQueries({ queryKey: ["reservation-deposits"] })
          }
        />
      )}
    </div>
  );
}
