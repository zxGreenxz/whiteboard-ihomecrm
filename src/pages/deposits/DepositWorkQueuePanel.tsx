import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { formatISODateVN, formatISODayMonth } from "@/lib/vnDate";
import {
  formatMoneyShort,
  type DepositTask,
  type DepositTaskGroup,
  type DepositTaskTone,
} from "@/lib/depositWorkQueue";

/**
 * Bàn xử lý cọc — cột trái của bản 2a (handoff Claude Design).
 *
 * Mỗi thẻ trả lời đúng ba câu theo thứ tự mắt đọc: phòng nào · việc gì · gấp
 * bao nhiêu, rồi mới tới nút. Thẻ ĐỎ (nền hồng) dành riêng cho việc đã TRỄ —
 * đỏ mà dùng cho cả việc chưa trễ thì sau một tuần không ai nhìn màu nữa.
 */

const TONE_TEXT: Record<DepositTaskTone, string> = {
  danger: "text-red-600",
  warn: "text-orange-600",
  ok: "text-emerald-700",
  pending: "text-amber-700",
};

const CHIP_TONE: Record<DepositTaskTone, string> = {
  danger: "bg-red-100 text-red-700",
  warn: "bg-muted text-muted-foreground",
  ok: "bg-emerald-50 text-emerald-700",
  pending: "bg-amber-50 text-amber-700",
};

/** Nhãn ngắn của việc, để dòng đầu thẻ nói ngay đang xử lý loại gì. */
function taskHeadline(task: DepositTask): string {
  switch (task.kind) {
    case "HOLD_OVERDUE":
      return `QUÁ HẠN LÀM HĐ · ${task.buildingName}`;
    case "TOPUP_OVERDUE":
    case "TOPUP_DUE_SOON":
      return `THIẾU CỌC · ${task.buildingName}`;
    default:
      return `GIỮ CHỖ · ${task.buildingName}`;
  }
}

/** Dòng phụ: ai, và bối cảnh tiền/thời gian riêng của từng loại. */
function taskSubline(task: DepositTask): string {
  if (task.paidAmount !== null && task.expectedAmount !== null) {
    return `${task.personName} · đã thu ${formatMoneyShort(task.paidAmount)} / ${formatMoneyShort(
      task.expectedAmount,
    )}`;
  }
  const bits = [task.personName];
  if (task.code) bits.push(task.code);
  if (task.heldDays !== null && task.heldDays > 0) bits.push(`giữ ${task.heldDays} ngày`);
  return bits.join(" · ");
}

/**
 * Dòng mốc thời gian. Cố ý nói CẢ ngày lẫn số ngày lệch: chỉ có "trễ 3 ngày"
 * thì người xem phải tự tính ngược ra ngày để đi tra lại phiếu.
 */
function taskDeadlineText(task: DepositTask): string {
  const { daysToDue: d, dueDate } = task;
  if (d === null || !dueDate) {
    return task.kind === "PENDING_APPROVAL" && task.heldDays !== null
      ? `chờ duyệt ${task.heldDays} ngày`
      : "chưa đặt hạn";
  }
  const day = formatISODayMonth(dueDate);
  const isHold = task.kind === "HOLD_OVERDUE" || task.kind === "HOLD_READY";
  const label = isHold ? "hạn làm HĐ" : "hẹn";
  if (d < 0) return `${label} ${day} · trễ ${-d} ngày`;
  if (d === 0) return `${label} ${day} · hôm nay`;
  return `${label} ${day} · còn ${d} ngày`;
}

export interface WorkQueueActions {
  /** Mở form hợp đồng prefill từ phiếu giữ chỗ. */
  onCreateContract: (task: DepositTask) => void;
  /** Duyệt phiếu giữ chỗ đang chờ. */
  onApprove: (task: DepositTask) => void;
  /** Mở hộp thoại đặt/gia hạn "hạn phải làm hợp đồng". */
  onEditDeadline: (task: DepositTask) => void;
  canCreateContract: boolean;
  canApprove: boolean;
  approvingId: string | null;
}

function TaskCard({ task, tone, actions }: {
  task: DepositTask;
  tone: DepositTaskTone;
  actions: WorkQueueActions;
}) {
  const overdue = tone === "danger";
  const isHold = task.kind === "HOLD_OVERDUE" || task.kind === "HOLD_READY";
  return (
    <div
      className={
        "flex items-center gap-4 rounded-xl border px-4 py-3 " +
        (overdue ? "border-red-200 bg-red-50" : "border-transparent bg-card shadow-sm")
      }
    >
      <span
        className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${CHIP_TONE[tone]}`}
      >
        P.{task.roomName}
      </span>

      <div className="w-[250px] min-w-0">
        <div className="truncate text-[13.5px] font-extrabold">
          {overdue ? "⚠ " : ""}
          {taskHeadline(task)}
        </div>
        <div
          className={`mt-0.5 truncate text-xs ${overdue ? "text-red-700/80" : "text-muted-foreground"}`}
          title={taskSubline(task)}
        >
          {taskSubline(task)}
        </div>
      </div>

      <div className="w-[170px] shrink-0">
        <div
          className={`text-[15px] font-extrabold ${tone === "ok" || tone === "pending" ? "" : TONE_TEXT[tone]}`}
          title={formatCurrency(task.amount)}
        >
          {formatMoneyShort(task.amount)}
        </div>
        <div
          className={`text-[11px] font-semibold ${overdue ? "text-red-600" : "text-muted-foreground"}`}
          title={task.dueDate ? formatISODateVN(task.dueDate) : undefined}
        >
          {taskDeadlineText(task)}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 gap-2">
        {task.contractId && (
          <Button asChild size="sm" variant="outline">
            <Link to={`/contracts/${task.contractId}`}>Mở hợp đồng</Link>
          </Button>
        )}
        {task.kind === "PENDING_APPROVAL" && actions.canApprove && task.voucherId && (
          <Button
            size="sm"
            onClick={() => actions.onApprove(task)}
            disabled={actions.approvingId === task.voucherId}
          >
            {actions.approvingId === task.voucherId ? "Đang duyệt..." : "Duyệt"}
          </Button>
        )}
        {isHold && (
          <Button size="sm" variant="outline" onClick={() => actions.onEditDeadline(task)}>
            {task.dueDate ? "Gia hạn giữ chỗ" : "Đặt hạn"}
          </Button>
        )}
        {isHold && actions.canCreateContract && task.roomId && (
          <Button size="sm" onClick={() => actions.onCreateContract(task)}>
            Tạo hợp đồng
          </Button>
        )}
      </div>
    </div>
  );
}

export function DepositWorkQueuePanel({
  groups,
  actions,
  isLoading,
  onOpenLedger,
  ledgerCount,
}: {
  groups: DepositTaskGroup[];
  actions: WorkQueueActions;
  isLoading: boolean;
  onOpenLedger: () => void;
  ledgerCount: number;
}) {
  if (isLoading) {
    return (
      <div className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground shadow-sm">
        Đang tải hàng đợi...
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-8 text-center">
        <p className="text-sm font-extrabold text-emerald-800">
          Hết việc cần xử lý hôm nay
        </p>
        <p className="mt-1 text-xs text-emerald-700">
          Không có phiếu nào trễ hẹn hay sắp đến hạn. Mở sổ cọc để xem toàn bộ bản ghi.
        </p>
        <Button variant="outline" size="sm" className="mt-3" onClick={onOpenLedger}>
          Mở sổ cọc đầy đủ ({ledgerCount})
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <div key={group.kind} className="flex flex-col gap-3">
          <div className="flex items-center gap-2 px-1 pt-1">
            <span
              className={`text-[11px] font-extrabold tracking-[0.08em] ${TONE_TEXT[group.tone]}`}
            >
              {group.label} · {group.tasks.length}
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
          {group.tasks.map((task) => (
            <TaskCard key={task.key} task={task} tone={group.tone} actions={actions} />
          ))}
        </div>
      ))}
      <div className="pt-1 text-center">
        <button
          type="button"
          onClick={onOpenLedger}
          className="text-[13px] font-bold text-primary hover:underline"
        >
          Mở sổ cọc đầy đủ ({ledgerCount} bản ghi) →
        </button>
      </div>
    </div>
  );
}
