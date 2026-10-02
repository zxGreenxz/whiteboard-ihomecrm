import { QueryRegion } from '@/components/errors/QueryRegion';
import { LoadingState } from '@/components/loading/LoadingState';
// Tab "Đơn xin nghỉ" — chủ duyệt/từ chối phép có lương của nhân viên.
import { toast } from "sonner";
import { leaveActionErrorMessage, usePendingLeaveRequests, useApproveLeave } from "@/hooks/useMyDay";
import { SAL_ICONS } from "./salaryIcons";

const I = SAL_ICONS;

function dmy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export default function SalaryLeaveRequests() {
  const query = usePendingLeaveRequests();
  const {data:rows=[],isLoading} = query;
  const approve = useApproveLeave();

  const onDecide = (userId: string, workDate: string, ok: boolean) => {
    approve.mutate(
      { user: userId, date: workDate, approve: ok },
      {
        onSuccess: () => toast.success(`Đã ${ok ? "duyệt" : "từ chối"} đơn nghỉ ngày ${dmy(workDate)} của ${rows.find(row=>row.user_id===userId)?.staff_name || "nhân viên"}.`),
        onError: (error: unknown) => toast.error(leaveActionErrorMessage(error, {date:workDate,approve:ok,employeeName:rows.find(row=>row.user_id===userId)?.staff_name})),
      }
    );
  };

  const head = (
    <div className="sal-cfg-head">
      <span className="ic" style={{ background: "hsl(var(--status-warning-bg))", color: "hsl(var(--status-warning-fg))" }}><I.Calendar size={18} /></span>
      <div style={{ flex: 1 }}><h3>Đơn xin nghỉ có lương</h3><p>Duyệt hoặc từ chối — nhân viên sẽ nhận thông báo kết quả</p></div>
    </div>
  );

  if (query.isError) return <QueryRegion label="đơn nghỉ chờ duyệt" queries={[query]} skeleton="none"><span /></QueryRegion>;
  if (isLoading) {
    // Khung thẻ hiện ngay, danh sách đơn là khối xám — không chữ "Đang tải…" (chủ chốt 02/10/2026).
    return (
      <div className="sal-card">
        {head}
        <div className="sal-cfg-body">
          <LoadingState label="đơn nghỉ chờ duyệt" variant="list" rows={3} onRetry={() => void query.refetch()} />
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="sal-card">
        <div className="sal-empty">
          <span className="ec"><I.CalendarCheck size={28} /></span>
          <h3>Không có đơn nào chờ duyệt</h3>
          <p>Khi nhân viên xin phép nghỉ có lương, đơn sẽ hiện ở đây để duyệt hoặc từ chối.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="sal-card">
      {head}
      <div className="sal-cfg-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
        {rows.map((r) => {
          const isThisPending =
            approve.isPending &&
            (approve.variables as any)?.user === r.user_id &&
            (approve.variables as any)?.date === r.work_date;
          return (
            <div className="sal-mgrrow" key={`${r.user_id}-${r.work_date}`}>
              <span className="sal-ava" style={{ background: "hsl(var(--primary))" }}>
                {(r.staff_name || "?").trim().split(/\s+/).pop()![0]}
              </span>
              <div className="sal-mgrinfo">
                <span className="nm">{r.staff_name}<span className="sal-alias">{dmy(r.work_date)}</span></span>
                <span className="meta">{r.reason ? r.reason : "Không ghi lý do"}</span>
              </div>
              <span style={{ display: "inline-flex", gap: 8, flexShrink: 0 }}>
                <button className="sal-btn sal-btn--outline sal-btn--sm" disabled={isThisPending}
                  onClick={() => onDecide(r.user_id, r.work_date, false)}>
                  <I.X size={14} />Từ chối
                </button>
                <button className="sal-btn sal-btn--primary sal-btn--sm" disabled={isThisPending}
                  onClick={() => onDecide(r.user_id, r.work_date, true)}>
                  <I.Check size={14} />Duyệt
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
