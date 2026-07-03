// V5SalaryView — trang lương khi CHẾ ĐỘ = v5 (chuyên cần + chuỗi).
// Chủ (admin): bảng tất cả nhân viên (v5_lock_assert). Nhân viên: thẻ của mình (get_my_day_summary).
// Mọi số là TẠM TÍNH (gain-framing); tiền chỉ ghi vào lương khi CHỦ chốt ở /reports/coverage tab Đối soát.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Wallet, Sparkles, Flame, CalendarCheck, ArrowRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useMyDaySummary } from "@/hooks/useMyDay";

const rpc = supabase.rpc.bind(supabase) as (fn: string, args?: Record<string, unknown>) => any;
const fmt = (n: number) => Math.round(Number(n) || 0).toLocaleString("vi-VN") + "đ";
const thisMonth = () => new Date().toISOString().slice(0, 8) + "01";

function Banner() {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
      <Sparkles size={16} className="shrink-0" />
      <span>
        Đang ở <b>chế độ lương v5</b> — chuyên cần + chuỗi. Số dưới đây là <b>TẠM TÍNH</b> theo ngày công đã ghi;
        tiền chỉ vào lương khi chủ chốt ở{" "}
        <Link to="/reports/coverage" className="underline">Vận hành lương v5 → Đối soát tháng</Link>.
      </span>
    </div>
  );
}

// ---------- Admin: bảng tất cả nhân viên ----------
function AdminTable() {
  const q = useQuery({
    queryKey: ["v5-salary-assert", thisMonth()],
    queryFn: async () => {
      const { data, error } = await rpc("v5_lock_assert", { p_month: thisMonth() });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });
  return (
    <div className="sal-card rounded-2xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Wallet size={18} /> Lương v5 tháng này (TẠM TÍNH)
      </div>
      {q.isLoading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Đang tải…</p>
      ) : (q.data ?? []).length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Chưa có nhân viên nào trong diện tính lương v5 (cần được phân toà ở Cài đặt nhân sự).
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2">Nhân viên</th>
                <th>Ngày công</th>
                <th>Chuyên cần</th>
                <th>Chuỗi</th>
                <th>Tổng v5 (tạm tính)</th>
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((r: any) => (
                <tr key={r.staff_id} className="border-b">
                  <td className="py-2 font-medium">{r.staff_name}</td>
                  <td>{r.ticked_days}/{r.n_chuan}</td>
                  <td>{fmt(r.attend_amount)}</td>
                  <td>{fmt(r.streak_amount)}</td>
                  <td className="font-semibold">{fmt(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Link to="/reports/coverage" className="inline-flex items-center gap-1 underline">
          Mở bảng đối soát &amp; chốt tiền v5 <ArrowRight size={13} />
        </Link>
      </div>
    </div>
  );
}

// ---------- Nhân viên: thẻ của mình ----------
function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-emerald-500" style={{ width: pct + "%" }} />
    </div>
  );
}

function SelfCard() {
  const { data: s, isLoading } = useMyDaySummary();
  if (isLoading || !s) {
    return <div className="sal-card rounded-2xl border bg-card p-6 text-sm text-muted-foreground">Đang tải lương v5…</div>;
  }
  const attend = s.attend;
  const streak = s.streak;
  const bankedTotal = (streak.banked ?? []).reduce((a, b) => a + (b.delta || 0), 0);
  const total = attend.tam_tinh + bankedTotal;
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-gradient-to-br from-emerald-600 to-emerald-800 p-5 text-white">
        <div className="flex items-center gap-1.5 text-xs opacity-90">
          <Sparkles size={14} /> Lương v5 tạm tính tháng này
        </div>
        <div className="mt-1 text-4xl font-extrabold tracking-tight">{fmt(total)}</div>
        <div className="mt-1 text-xs opacity-80">Chuyên cần {fmt(attend.tam_tinh)} · Chuỗi {fmt(bankedTotal)} · leo tiếp là tăng 🚀</div>
      </div>

      <div className="rounded-2xl border bg-card p-4">
        <div className="mb-2 flex items-center justify-between text-sm font-medium">
          <span className="flex items-center gap-1.5"><CalendarCheck size={16} /> Chuyên cần</span>
          <span className="text-muted-foreground">{attend.ticked_days}/{attend.n_chuan} ngày công</span>
        </div>
        <Bar value={attend.tam_tinh} max={attend.budget} />
        <div className="mt-1 flex justify-between text-xs text-muted-foreground">
          <span>Đã tích <b className="text-foreground">{fmt(attend.tam_tinh)}</b></span>
          <span>Trần {fmt(attend.budget)} · {fmt(attend.day_rate)}/ngày</span>
        </div>
      </div>

      <div className="rounded-2xl border bg-card p-4">
        <div className="mb-2 flex items-center justify-between text-sm font-medium">
          <span className="flex items-center gap-1.5"><Flame size={16} className="text-amber-500" /> Chuỗi ngày công</span>
          <span className="text-muted-foreground">Hiện {streak.current} · kỷ lục {streak.best}</span>
        </div>
        {streak.next ? (
          <p className="text-xs text-muted-foreground">
            Còn <b className="text-foreground">{streak.next.days_to_go} ngày</b> nữa đạt mốc {streak.next.milestone} → thưởng thêm <b className="text-emerald-600">+{fmt(streak.next.delta)}</b>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Đã đạt các mốc chuỗi tháng này 🎉</p>
        )}
        {(streak.banked ?? []).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {streak.banked.map((b, i) => (
              <span key={i} className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                🔒 Mốc {b.milestone === "full_month" ? "trọn tháng" : b.milestone} · +{fmt(b.delta)}
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="text-center text-[11px] text-muted-foreground">
        Số TẠM TÍNH — chốt vào lương cuối tháng. Mở <Link to="/my-day" className="underline">Hôm nay của tôi</Link> để tích thêm.
      </p>
    </div>
  );
}

export default function V5SalaryView({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="mx-auto max-w-3xl">
      <Banner />
      {isAdmin ? <AdminTable /> : <SelfCard />}
    </div>
  );
}
