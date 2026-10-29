// "Lương của tôi" — hai phần phụ: bảng kê đầy đủ (cả dòng không được thưởng) và
// thành tích & hành trình các tháng. Desktop: khối thu gọn cuối trang; điện thoại: tab.
import { AlertTriangle, Check } from "lucide-react";
import { isUnqualifiedContractRow, zeroBonusReason, type SalLedgerRow, type SalManager } from "@/lib/managerSalary";
import { bigNum, salFmt } from "./salaryFormat";

const TYPE_LABEL: Record<string, string> = { JOB: "Việc", DAY_BONUS: "Ngày CN/Lễ", CONTRACT: "Hợp đồng", CASH: "Thu tiền" };

const fmtDM = (iso: string) => {
  const p = (iso || "").split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}` : iso || "—";
};

function Photo({ r }: { r: SalLedgerRow }) {
  if (r.has_photo === true) return <Check size={16} strokeWidth={2.6} aria-label="Có ảnh nghiệm thu" style={{ color: "hsl(var(--status-success-fg))" }} />;
  if (r.has_photo === false && r.item_type === "JOB" && (r.bonus_amount ?? 0) === 0) return <AlertTriangle size={16} aria-label="Thiếu ảnh nghiệm thu" style={{ color: "hsl(var(--status-warning-fg))" }} />;
  return <span className="text-muted-foreground">—</span>;
}

function Bonus({ r, requirePhoto }: { r: SalLedgerRow; requirePhoto?: boolean }) {
  if (r.bonus_amount == null) return <span className="text-muted-foreground">—</span>;
  if (r.bonus_amount === 0) {
    const note = zeroBonusReason(r, requirePhoto);
    return (
      <span className="flex flex-col items-end">
        <span className="font-bold text-muted-foreground">0</span>
        {note && <span className="text-[11px]" style={{ color: "hsl(var(--status-warning-fg))" }}>{note}</span>}
      </span>
    );
  }
  return <span className="font-bold" style={{ color: "hsl(var(--status-success-fg))" }}>+{bigNum(r.bonus_amount)}</span>;
}

export function SelfLedger({ m, requirePhoto, compact }: { m: SalManager; requirePhoto?: boolean; compact?: boolean }) {
  // Ẩn việc ký HĐ làm trong giờ — sai điều kiện từ đầu nên không bao giờ có thưởng.
  const rows = m.ledger.filter((r) => !isUnqualifiedContractRow(r));
  const total = rows.reduce((s, r) => s + (r.bonus_amount || 0), 0);
  if (!rows.length) return <p className="m-0 px-4 py-6 text-center text-[13px] text-muted-foreground">Chưa có việc nào trong kỳ này.</p>;
  return (
    <div>
      {compact ? (
        <ul className="m-0 list-none p-0">
          {rows.map((r, i) => (
            <li key={(r.source_id || "") + i} className="flex gap-3 border-t px-4 py-2.5 text-[12.5px] first:border-t-0">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold">{r.content || "—"}</span>
                <span className="text-muted-foreground">{fmtDM(r.occurred_date)}{r.day_label ? ` · ${r.day_label}` : ""} · {TYPE_LABEL[r.item_type] || r.item_type} · {r.place || "—"}</span>
                {r.item_type !== "CASH" && r.reason && <span className="block text-muted-foreground">{r.reason}</span>}
              </span>
              <span className="flex shrink-0 items-start gap-2"><Photo r={r} /><Bonus r={r} requirePhoto={requirePhoto} /></span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-muted/60 text-left text-[11.5px] uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-bold">Ngày</th>
                <th scope="col" className="px-3 py-2 font-bold">Loại</th>
                <th scope="col" className="px-3 py-2 font-bold">Nội dung</th>
                <th scope="col" className="px-3 py-2 font-bold">Toà · phòng</th>
                <th scope="col" className="px-3 py-2 font-bold">Lý do</th>
                <th scope="col" className="px-3 py-2 text-center font-bold">Ảnh</th>
                <th scope="col" className="px-3 py-2 text-right font-bold">Thưởng</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={(r.source_id || "") + i} className="border-t">
                  <td className="whitespace-nowrap px-3 py-2">{fmtDM(r.occurred_date)}{r.day_label ? <span className="ml-1.5 text-[11px] font-bold text-muted-foreground">{r.day_label}</span> : null}</td>
                  <td className="whitespace-nowrap px-3 py-2">{TYPE_LABEL[r.item_type] || r.item_type}</td>
                  <td className="px-3 py-2">{r.content || "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.place || "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.item_type === "CASH" ? "Không tính thưởng" : r.reason || "—"}</td>
                  <td className="px-3 py-2 text-center"><Photo r={r} /></td>
                  <td className="px-3 py-2 text-right"><Bonus r={r} requirePhoto={requirePhoto} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex justify-between border-t-2 bg-muted/60 px-4 py-2.5 text-[13px] font-extrabold">
        <span>Tổng thưởng theo bảng kê · {rows.length} dòng</span>
        <span style={{ color: "hsl(var(--status-success-fg))" }}>+{bigNum(total)}</span>
      </div>
    </div>
  );
}

export function SelfJourney({ m }: { m: SalManager }) {
  const gross = m.calc?.gross ?? 0;
  const goal = m.incomeGoal || 0;
  const pct = goal > 0 ? Math.round(Math.min(gross / goal, 1) * 100) : 0;
  const trend = m.trend || [];
  const maxV = Math.max(1, ...trend.map((d) => d.gross));
  return (
    <div className="flex flex-col gap-4 p-4">
      {goal > 0 && (
        <div>
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="font-bold">Mục tiêu thu nhập tháng</span>
            <span className="font-extrabold" style={{ color: "hsl(var(--status-success-fg))" }}>{pct}%</span>
          </div>
          <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`Đạt ${pct}% mục tiêu ${salFmt(goal)}`}>
            <span className="block h-full rounded-full" style={{ width: pct + "%", background: "hsl(var(--status-success-fg))" }} />
          </div>
          <p className="m-0 mt-1.5 text-[12.5px] text-muted-foreground">
            {gross >= goal ? `Đã vượt mục tiêu ${salFmt(goal)}.` : `Còn ${salFmt(goal - gross)} để đạt mục tiêu ${salFmt(goal)}.`}
          </p>
        </div>
      )}
      <div>
        <div className="mb-2 text-[13px] font-bold">Hành trình các tháng</div>
        {trend.length === 0 ? (
          <p className="m-0 text-[13px] text-muted-foreground">Chưa có dữ liệu các tháng trước.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {trend.map((d, i) => (
              <li key={i} className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-3 text-[12.5px]">
                <span className={d.current ? "font-extrabold" : "text-muted-foreground"}>T{d.label.replace(/^0/, "")}{d.current ? " •" : ""}</span>
                <span className="relative h-3 overflow-hidden rounded bg-muted" aria-hidden="true">
                  <span className="absolute inset-y-0 left-0 rounded" style={{ width: (d.gross / maxV) * 100 + "%", background: "hsl(var(--status-success-bg))" }} />
                  <span className="absolute inset-y-0 left-0 rounded" style={{ width: (Math.max(0, d.takehome) / maxV) * 100 + "%", background: "hsl(var(--status-success-fg))" }} />
                </span>
                <span className="whitespace-nowrap text-right">
                  <b>{bigNum(d.gross)}</b>
                  <span className="text-muted-foreground"> · nhận {bigNum(d.takehome)}{d.current ? " (tạm tính)" : d.paidOn ? ` · ${d.paidOn}` : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {trend.length > 0 && (
          <p className="m-0 mt-2 flex flex-wrap gap-x-4 text-[11.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "hsl(var(--status-success-bg))" }} />Tổng thu nhập</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "hsl(var(--status-success-fg))" }} />Thực nhận</span>
          </p>
        )}
      </div>
    </div>
  );
}
