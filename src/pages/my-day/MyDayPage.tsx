// "NGÀY HÔM NAY CỦA TÔI" (/my-day) — màn trung tâm vòng lặp v5 phía nhân viên (Ch.7 spec).
// Mobile-first 1 cột (desktop bó 480px giữa). GAIN-FRAMING tuyệt đối:
// không màu đỏ phía nhân viên, không chữ "−/mất/trừ"; mọi số tiền realtime = "TẠM TÍNH".
// Khối: A trạng thái ngày → D nhắc treo check-sau-thu → B tuyến gợi ý → C việc đến hạn
//        → F tiến trình tiền/chuỗi → phép 1-chạm.
import { lazy, Suspense, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft, Banknote, Building2, CalendarClock, CheckCircle2, ChevronRight,
  ClipboardList, Flame, Shield, Sun,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useJobs } from "@/hooks/useJobs";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { v5Copy } from "@/lib/v5Copy";
import { useSetUiPreference, useUiPrefBool } from "@/hooks/useUiPreferences";
import {
  useMyDaySummary, useMyMissions, useMyOpenInspections, useRequestLeave, type Mission,
} from "@/hooks/useMyDay";

const InspectionRunner = lazy(() => import("@/components/inspections/InspectionRunner"));

const fmtVnd = (n: number) => Math.round(n).toLocaleString("vi-VN") + "đ";

const SOURCE_LABEL: Record<string, string> = {
  JOB: "hoàn thành việc",
  FULL: "kiểm tra nhà",
  PAYMENT: "thu tiền + check nhà",
  MANUAL_DEVICE_ISSUE: "duyệt tay (sự cố thiết bị)",
};

function useBuildingCoords(ids: string[]) {
  return useQuery({
    queryKey: ["v5-building-coords", ids.slice().sort().join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("buildings")
        .select("id, name, latitude, longitude")
        .in("id", ids);
      const map: Record<string, { name: string; latitude: number | null; longitude: number | null }> = {};
      for (const b of data ?? []) map[(b as any).id] = b as any;
      return map;
    },
  });
}

export default function MyDayPage() {
  const { data: authUser } = useAuth();
  const summaryQ = useMyDaySummary();
  const missionsQ = useMyMissions();
  const requestLeave = useRequestLeave();

  const [runner, setRunner] = useState<{
    buildingId: string; buildingName: string; type: "FULL" | "QUICK";
  } | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveDate, setLeaveDate] = useState("");
  // Chủ nhật: mở lại tuyến gợi ý nếu muốn làm tự nguyện
  const [showRouteOnRest, setShowRouteOnRest] = useState(false);

  const s = summaryQ.data;
  // Phiên kiểm tra ĐANG DỞ hôm nay — tắt app/mất mạng vẫn còn, bấm là làm tiếp
  const openSessQ = useMyOpenInspections(s?.today.date, authUser?.id);
  const openSessions = openSessQ.data ?? [];
  const missions = missionsQ.data ?? [];
  const suggested = useMemo(
    () => missions.filter((m) => m.color !== "green").slice(0, 3),
    [missions],
  );

  const jobsQ = useJobs({ assignee_id: authUser?.id ?? undefined, status: "IN_PROGRESS" } as any);
  const myJobs: any[] = Array.isArray(jobsQ.data) ? (jobsQ.data as any[]).slice(0, 5) : [];

  const coordIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of suggested) ids.add(m.building_id);
    for (const p of s?.pending_checks ?? []) ids.add(p.building_id);
    for (const o of openSessions) ids.add(o.building_id);
    return [...ids];
  }, [suggested, s?.pending_checks, openSessions]);
  const coordsQ = useBuildingCoords(coordIds);

  const ticked = s?.today.status === "ticked";
  const leaveToday = s?.today.status === "leave_approved" || s?.today.status === "pending_leave";
  // Chủ nhật = ngày nghỉ (dùng ngày VN từ summary, khớp "hôm nay" của hệ thống)
  const isRestDay = useMemo(() => {
    if (!s?.today.date) return false;
    const [y, m, d] = s.today.date.split("-").map(Number);
    return new Date(y, m - 1, d).getDay() === 0; // 0 = Chủ nhật
  }, [s?.today.date]);

  // Onboarding "Tôi đã hiểu" (US-6.5): bắt buộc trước khi bật tiền — hiện từ chặng shadow_money.
  const v5Acked = useUiPrefBool("v5_onboarding_ack", false);
  const setPref = useSetUiPreference();
  const needAck = !v5Acked && (s?.stage === "shadow_money" || s?.stage === "live");

  const openRunner = (m: { building_id: string; building_name: string | null }, type: "FULL" | "QUICK") =>
    setRunner({ buildingId: m.building_id, buildingName: m.building_name ?? "toà", type });

  const submitLeave = async () => {
    if (!leaveDate) return;
    try {
      await requestLeave.mutateAsync({ date: leaveDate });
      toast.success(v5Copy.leaveRequested(leaveDate));
      setLeaveOpen(false);
    } catch (e: any) {
      toast.info(e?.message ?? "Chưa gửi được — thử lại nhé");
    }
  };

  return (
    <div className="min-h-dvh bg-slate-50">
      <div className="mx-auto max-w-[480px] px-4 pb-24 pt-4">
        {/* Header */}
        <div className="mb-3 flex items-center gap-2">
          <Link to="/" className="rounded-full p-2 hover:bg-slate-200">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-lg font-semibold">Ngày hôm nay của tôi</h1>
          <button
            className="ml-auto rounded-full px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-200"
            onClick={() => { setLeaveOpen((v) => !v); }}
          >
            Xin phép {s ? `(còn ${s.leave.left})` : ""}
          </button>
        </div>

        {/* Onboarding "Tôi đã hiểu" — bắt buộc trước khi bật tiền (US-6.5) */}
        {needAck && (
          <div className="mb-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm shadow-sm">
            <div className="mb-1 font-semibold">Cách tính lương mới (v5) — 1 phút để hiểu</div>
            <ul className="mb-2 list-inside list-disc text-xs text-slate-600">
              <li>Mỗi ngày làm ≥1 việc thật (kiểm tra nhà / thu tiền + check / sửa chữa) = 1 ngày công.</li>
              <li>Đủ ngày công chuẩn của tháng = trọn phần chuyên cần; đi đều liền mạch = thêm thưởng chuỗi (mốc đã đạt là KHOÁ 🔒).</li>
              <li>Nghỉ phép có duyệt: chuỗi được bắc cầu, đơn giá ngày tự điều chỉnh — bạn không thiệt.</li>
              <li>Số hiển thị hằng ngày là TẠM TÍNH; tiền chốt khi khoá sổ cuối tháng.</li>
            </ul>
            <Button size="sm" onClick={() => { setPref.mutate({ key: "v5_onboarding_ack", value: true }); }}>
              Tôi đã hiểu
            </Button>
          </div>
        )}

        {/* Xin phép 1-chạm */}
        {leaveOpen && (
          <div className="mb-3 rounded-xl border bg-white p-3 shadow-sm">
            <div className="mb-2 text-sm font-medium">Xin phép có lương (1 chạm)</div>
            <div className="flex gap-2">
              <input
                type="date"
                className="flex-1 rounded-md border px-2 py-1.5 text-sm"
                value={leaveDate}
                min={s?.today.date}
                onChange={(e) => setLeaveDate(e.target.value)}
              />
              <Button size="sm" onClick={submitLeave} disabled={requestLeave.isPending || !leaveDate}>
                Gửi
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500">
              Ngày phép là ngày trung tính: chuỗi được bắc cầu, đơn giá ngày tự điều chỉnh — bạn không thiệt.
            </p>
          </div>
        )}

        {/* KHỐI A0 — phiên kiểm tra ĐANG DỞ (resume): tắt app vẫn còn tới 23:59 */}
        {openSessions.length > 0 && (
          <div className="mb-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
            <div className="mb-2 text-sm font-semibold text-emerald-800">
              Đang kiểm tra dở — bấm để làm tiếp (lưu tới 23:59)
            </div>
            {openSessions.map((o) => (
              <button
                key={o.id}
                className="mb-1.5 flex w-full items-center justify-between rounded-lg bg-white px-3 py-2 text-sm shadow-sm"
                onClick={() => openRunner({ building_id: o.building_id, building_name: o.building_name }, o.type)}
              >
                <span>
                  <span className="font-medium">{o.building_name ?? "Toà"}</span>
                  <span className="ml-2 text-xs text-slate-500">
                    {o.type === "FULL" ? "kiểm tra nhà" : "check nhanh"} · đã chụp {o.photos_count} ảnh
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 text-emerald-600" />
              </button>
            ))}
          </div>
        )}

        {/* KHỐI A — trạng thái ngày (xanh/xám, KHÔNG đỏ) */}
        <div className={`mb-3 rounded-2xl p-4 shadow-sm ${ticked ? "bg-emerald-600 text-white" : "bg-white"}`}>
          {summaryQ.isLoading ? (
            <div className="h-16 animate-pulse rounded-lg bg-slate-100" />
          ) : ticked ? (
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-9 w-9" />
              <div>
                <div className="font-semibold">
                  {v5Copy.dayTicked(SOURCE_LABEL[s?.today.tick_source ?? ""] ?? s?.today.tick_source ?? "")}
                </div>
                <div className="text-sm opacity-90">
                  +{fmtVnd(s?.attend.day_rate ?? 0)} TẠM TÍNH · chuỗi {s?.streak.current ?? 0} ngày 🔥
                </div>
                {isRestDay && (
                  <div className="mt-1.5 text-sm font-medium opacity-95">
                    {v5Copy.restDayThanksWorking}
                  </div>
                )}
              </div>
            </div>
          ) : isRestDay && !leaveToday ? (
            <div className="flex items-center gap-3">
              <Sun className="h-9 w-9 text-amber-500" />
              <div>
                <div className="font-semibold">{v5Copy.restDayTitle}</div>
                <div className="text-sm text-slate-500">{v5Copy.restDaySubtitle}</div>
              </div>
            </div>
          ) : leaveToday ? (
            <div className="flex items-center gap-3">
              <Sun className="h-9 w-9 text-amber-500" />
              <div>
                <div className="font-semibold">Hôm nay bạn nghỉ phép — nghỉ ngơi nhé 🌿</div>
                <div className="text-sm text-slate-500">Chuỗi được bắc cầu, không cần làm gì thêm.</div>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-3">
                <Sun className="h-9 w-9 text-amber-500" />
                <div className="font-semibold">{v5Copy.dayNotYet}</div>
              </div>
              {suggested[0] && (
                <button
                  className="mt-3 flex w-full items-center justify-between rounded-xl bg-emerald-50 px-3 py-2.5 text-left"
                  onClick={() => openRunner(suggested[0], "FULL")}
                >
                  <span className="text-sm">
                    <span className="font-medium">Kiểm tra {suggested[0].building_name}</span>
                    <span className="block text-xs text-slate-500">{suggested[0].reason}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-emerald-600" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* KHỐI D — nhắc treo: check nhà sau khi thu tiền */}
        {(s?.pending_checks?.length ?? 0) > 0 && (
          <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-800">
              <Banknote className="h-4 w-4" /> Check nhà sau khi thu tiền — để chốt ngày công
            </div>
            {(s?.pending_checks ?? []).map((p) => (
              <button
                key={p.building_id}
                className="mb-1.5 flex w-full items-center justify-between rounded-lg bg-white px-3 py-2 text-sm shadow-sm"
                onClick={() => openRunner(p, "QUICK")}
              >
                <span>{p.building_name ?? "Toà"} · check nhanh 3–5 phút</span>
                <ChevronRight className="h-4 w-4" />
              </button>
            ))}
          </div>
        )}

        {/* KHỐI B — tuyến gợi ý sáng nay */}
        <div className="mb-3 rounded-2xl bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Building2 className="h-4 w-4 text-sky-600" /> Hôm nay nên ghé
          </div>
          {missionsQ.isLoading ? (
            <div className="h-20 animate-pulse rounded-lg bg-slate-100" />
          ) : isRestDay && !showRouteOnRest ? (
            <div className="text-sm text-slate-500">
              <p>Hôm nay là ngày nghỉ — danh sách gợi ý tạm thu gọn để bạn thảnh thơi.</p>
              <button
                className="mt-2 rounded-lg border px-3 py-1.5 text-xs font-medium text-sky-600 hover:bg-sky-50"
                onClick={() => setShowRouteOnRest(true)}
              >
                {v5Copy.restDayShowRoute}
              </button>
            </div>
          ) : suggested.length === 0 ? (
            <p className="text-sm text-slate-500">Các toà của bạn đều mới được ghé gần đây — tuyệt vời! 🎉</p>
          ) : (
            suggested.map((m: Mission) => (
              <div key={m.building_id} className="mb-2 rounded-xl border p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{m.building_name}</span>
                    <span
                      className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        m.color === "red" ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700"
                      }`}
                    >
                      {m.days_since_touch == null ? "chưa có dấu chân" : `${m.days_since_touch} ngày`}
                    </span>
                  </div>
                  <Button size="sm" onClick={() => openRunner(m, "FULL")}>Bắt đầu</Button>
                </div>
                <p className="mt-1 text-xs text-slate-500">{m.reason}</p>
              </div>
            ))
          )}
        </div>

        {/* KHỐI C — việc đang mở của tôi */}
        <div className="mb-3 rounded-2xl bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ClipboardList className="h-4 w-4 text-violet-600" /> Việc của tôi
            </div>
            <Link to="/tasks" className="text-xs text-sky-600">Tất cả →</Link>
          </div>
          {Array.isArray(myJobs) && myJobs.length > 0 ? (
            myJobs.map((j: any) => (
              <Link
                key={j.id}
                to="/tasks"
                className="mb-1.5 flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
              >
                <span className="truncate pr-2">{j.title}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
              </Link>
            ))
          ) : (
            <p className="text-sm text-slate-500">Không có việc đang mở — kiểm tra nhà là việc-mặc-định hôm nay.</p>
          )}
        </div>

        {/* KHỐI F — tiến trình tiền + chuỗi (TẠM TÍNH) */}
        {s && (
          <div className="mb-3 rounded-2xl bg-white p-4 shadow-sm">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 font-semibold">
                <CalendarClock className="h-4 w-4 text-emerald-600" /> Chuyên cần tháng này
              </span>
              <span className="text-xs text-slate-500">
                {v5Copy.progressAttend(s.attend.ticked_days, s.attend.n_chuan)}
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all"
                style={{ width: `${Math.min(100, (s.attend.ticked_days / Math.max(1, s.attend.n_chuan)) * 100)}%` }}
              />
            </div>
            <div className="mt-1 text-right text-xs text-slate-500">
              Đã tích {fmtVnd(s.attend.tam_tinh)} / {fmtVnd(s.attend.budget)} — leo tiếp! 🚀
            </div>

            <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm">
                <Flame className="h-4 w-4 text-orange-500" />
                Chuỗi <b>{s.streak.current}</b> ngày
                {s.streak.next && (
                  <span className="text-xs text-slate-500">
                    · còn {s.streak.next.days_to_go} ngày tới mốc +{Math.round(s.streak.next.delta / 1000)}k
                  </span>
                )}
              </span>
              <span className="flex items-center gap-1 text-xs text-slate-500">
                <Shield className="h-3.5 w-3.5" />
                {s.streak.shields_free_left}+{s.streak.shields_reserve_left}
              </span>
            </div>
            {s.streak.banked.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {s.streak.banked.map((b) => (
                  <span key={String(b.milestone)} className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                    🔒 {b.milestone === "full_month" ? "Trọn tháng" : `Mốc ${b.milestone}`} +{Math.round(b.delta / 1000)}k
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <p className="text-center text-[11px] text-slate-400">
          Số tiền hiển thị là TẠM TÍNH — chốt khi khoá sổ cuối tháng.
        </p>
      </div>

      {runner && (
        <Suspense fallback={null}>
          <InspectionRunner
            open={!!runner}
            onOpenChange={(o) => { if (!o) { setRunner(null); openSessQ.refetch(); } }}
            buildingId={runner.buildingId}
            buildingName={runner.buildingName}
            buildingCoords={coordsQ.data?.[runner.buildingId] ?? null}
            type={runner.type}
            onDone={() => { summaryQ.refetch(); missionsQ.refetch(); openSessQ.refetch(); }}
          />
        </Suspense>
      )}
    </div>
  );
}
