// OwnerDashboardV5 (/reports/coverage) — TRUNG TÂM v5 của CHỦ, 5 tab:
// Coverage map · Nghi án · Đối soát tháng (3 ASSERT + nút chốt tiền) · Shadow/Gates · Cài đặt v5.
// LƯU Ý VỊ TRÍ (lệch nhỏ so US-5.1, ghi log): settings v5 đặt TẠI ĐÂY thay vì GeneralSettingsPage
// để chủ có đúng 1 nơi vận hành v5; chức năng đầy đủ theo catalog.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import MainLayout from "@/components/layout/MainLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const rpc = supabase.rpc.bind(supabase) as (fn: string, args?: Record<string, unknown>) => any;
const fmt = (n: number) => Math.round(Number(n) || 0).toLocaleString("vi-VN") + "đ";
const thisMonth = () => new Date().toISOString().slice(0, 8) + "01";

function useCoverage() {
  return useQuery({
    queryKey: ["v5-coverage-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("building_coverage" as any)
        .select("*")
        .gt("rooms_total", 0)
        .order("days_since_touch", { ascending: false, nullsFirst: true });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });
}

function useFlagged() {
  return useQuery({
    queryKey: ["v5-flagged"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("salary_attendance_day" as any)
        .select("id, user_id, work_date, status, evidence, audit, tick_source")
        .eq("status", "flagged")
        .order("work_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });
}

export default function OwnerDashboardV5() {
  const qc = useQueryClient();
  const coverage = useCoverage();
  const flagged = useFlagged();
  const [month] = useState(thisMonth());

  const assertQ = useQuery({
    queryKey: ["v5-lock-assert", month],
    queryFn: async () => {
      const { data, error } = await rpc("v5_lock_assert", { p_month: month });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });
  const shadowQ = useQuery({
    queryKey: ["v5-shadow", month],
    queryFn: async () => {
      const { data, error } = await rpc("v5_shadow_report", { p_month: month });
      if (error) throw error;
      return data as any;
    },
  });
  const cfgQ = useQuery({
    queryKey: ["v5-config-admin"],
    queryFn: async () => {
      const { data, error } = await rpc("get_salary_v5_config");
      if (error) throw error;
      return data as any;
    },
  });
  const cronQ = useQuery({
    queryKey: ["v5-cron-runs"],
    queryFn: async () => {
      const { data } = await supabase
        .from("cron_runs" as any)
        .select("*")
        .order("started_at", { ascending: false })
        .limit(20);
      return (data ?? []) as any[];
    },
  });

  const setCfg = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const { data, error } = await rpc("set_salary_v5_config", { p_patch: patch });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["v5-config-admin"] });
      toast.success("Đã lưu cấu hình");
    },
    onError: (e: any) => toast.error(e?.message ?? "Lỗi lưu cấu hình"),
  });

  const verdict = useMutation({
    mutationFn: async (args: { user: string; date: string; confirm: boolean }) => {
      const { data, error } = await rpc("v5_verdict", {
        p_user: args.user, p_date: args.date, p_confirm: args.confirm, p_note: null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["v5-flagged"] });
      qc.invalidateQueries({ queryKey: ["v5-lock-assert"] });
      toast.success("Đã kết luận");
    },
  });

  const applyLock = useMutation({
    mutationFn: async () => {
      const { data, error } = await rpc("v5_apply_lock_adjustments", { p_month: month });
      if (error) throw error;
      return data;
    },
    onSuccess: (d: any) => toast.success(`Đã ghi tiền v5 cho ${d?.staff_applied ?? 0} nhân viên vào bảng lương`),
    onError: (e: any) => toast.error(e?.message ?? "Không chốt được"),
  });

  const runJob = useMutation({
    mutationFn: async (job: string) => {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const res = await fetch(
        `https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/salary-v5-jobs?job=${job}`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["v5-cron-runs"] });
      toast.success("Job đã chạy");
    },
    onError: () => toast.error("Job lỗi — xem cron_runs"),
  });

  const flags = cfgQ.data?.system_v5?.feature_flags ?? {};
  const dColor = (d: number | null) =>
    d == null ? "bg-red-500" : d > 6 ? "bg-red-500" : d > 4 ? "bg-red-400" : d > 3 ? "bg-amber-400" : "bg-emerald-500";

  return (
    <MainLayout title="Vận hành lương v5" >
      <Tabs defaultValue="coverage" className="w-full">
        <TabsList className="flex-wrap">
          <TabsTrigger value="coverage">Coverage</TabsTrigger>
          <TabsTrigger value="fraud">Nghi án {flagged.data?.length ? `(${flagged.data.length})` : ""}</TabsTrigger>
          <TabsTrigger value="recon">Đối soát tháng</TabsTrigger>
          <TabsTrigger value="shadow">Shadow / Gates</TabsTrigger>
          <TabsTrigger value="settings">Cài đặt v5</TabsTrigger>
        </TabsList>

        {/* TAB 1 — Coverage map (grid màu theo D) */}
        <TabsContent value="coverage">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {(coverage.data ?? []).map((b: any) => (
              <div key={b.building_id} className="rounded-xl border p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{b.building_name}</span>
                  <span className={`h-3 w-3 rounded-full ${dColor(b.days_since_touch)}`} />
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Chạm: {b.days_since_touch == null ? "chưa từng" : `${b.days_since_touch} ngày trước`}
                  <br />FULL: {b.days_since_full == null ? "chưa từng" : `${b.days_since_full} ngày trước`}
                  <br />{b.rooms_total} phòng · {b.vacant_rooms} trống · {b.jobs_30d} việc/30d
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        {/* TAB 2 — Nghi án (máy flag, chủ kết án, due process C2) */}
        <TabsContent value="fraud">
          {(flagged.data ?? []).length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Không có nghi án nào đang mở.</p>
          ) : (
            (flagged.data ?? []).map((f: any) => (
              <div key={f.id} className="mb-2 rounded-xl border p-3">
                <div className="text-sm font-medium">Ngày {f.work_date} · nguồn {f.tick_source ?? "—"}</div>
                <pre className="mt-1 max-h-32 overflow-auto rounded bg-slate-50 p-2 text-[11px]">
                  {JSON.stringify({ evidence: f.evidence, audit: f.audit }, null, 1)}
                </pre>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="destructive"
                    onClick={() => verdict.mutate({ user: f.user_id, date: f.work_date, confirm: true })}>
                    Xác nhận gian lận (huỷ công + tước mốc tháng)
                  </Button>
                  <Button size="sm" variant="outline"
                    onClick={() => verdict.mutate({ user: f.user_id, date: f.work_date, confirm: false })}>
                    Hợp lệ — trả lại công
                  </Button>
                </div>
              </div>
            ))
          )}
        </TabsContent>

        {/* TAB 3 — Đối soát tháng: 3 ASSERT + nút chốt tiền v5 */}
        <TabsContent value="recon">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2">Nhân viên</th><th>Ngày công</th><th>Chuyên cần</th><th>Chuỗi</th><th>Tổng v5</th><th>ASSERT</th>
              </tr></thead>
              <tbody>
                {(assertQ.data ?? []).map((r: any) => (
                  <tr key={r.staff_id} className="border-b">
                    <td className="py-2 font-medium">{r.staff_name}</td>
                    <td>{r.ticked_days}/{r.n_chuan}</td>
                    <td>{fmt(r.attend_amount)}</td>
                    <td>{fmt(r.streak_amount)}</td>
                    <td className="font-semibold">{fmt(r.total)}</td>
                    <td>{r.all_ok ? "✅" : `⛔ ${!r.a1_caps_ok ? "trần " : ""}${!r.a2_no_open_flags ? "nghi-án " : ""}${!r.a3_payment_join_ok ? "phiếu-thu" : ""}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button
              disabled={applyLock.isPending || (assertQ.data ?? []).some((r: any) => !r.all_ok) || !flags.v5_money}
              onClick={() => applyLock.mutate()}
            >
              Ghi tiền v5 vào bảng lương tháng này
            </Button>
            {!flags.v5_money && (
              <span className="text-xs text-muted-foreground">
                Đang SHADOW (v5_money tắt) — số chỉ hiển thị, chưa ghi vào lương.
              </span>
            )}
          </div>
        </TabsContent>

        {/* TAB 4 — Shadow report + gates */}
        <TabsContent value="shadow">
          <div className="mb-2 text-sm text-muted-foreground">
            Stage hiện tại: <b>{cfgQ.data?.system_v5?.stage ?? "off"}</b> · Gate thoát xem V5-HE-THONG Ch.11.
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2">Nhân viên</th><th>Ngày công</th><th>Best streak</th><th>Đứt-không-phép</th><th>Nếu áp v5 (TẠM TÍNH)</th>
              </tr></thead>
              <tbody>
                {((shadowQ.data?.rows ?? []) as any[]).map((r: any) => (
                  <tr key={r.staff_id} className="border-b">
                    <td className="py-2 font-medium">{r.staff_name}</td>
                    <td>{r.ticked_days}/{r.n_chuan}</td>
                    <td>{r.best_streak}</td>
                    <td>{r.breaks_no_leave}</td>
                    <td className="font-semibold">{fmt(r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* TAB 5 — Cài đặt v5: flags/stage/jobs/cron_runs */}
        <TabsContent value="settings">
          <div className="max-w-xl space-y-4">
            <div className="rounded-xl border p-4">
              <div className="mb-2 text-sm font-semibold">Feature flags (kill-switch)</div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-sm">Tiền v5 (<code>v5_money</code>) — TẮT = lương giữ nguyên cơ chế cũ</span>
                <Switch checked={!!flags.v5_money}
                  onCheckedChange={(v) => setCfg.mutate({ system_v5: { feature_flags: { ...flags, v5_money: v } } })} />
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-sm">Coverage v5 (<code>v5_coverage</code>) — nhắc 3 nấc/push đỏ</span>
                <Switch checked={!!flags.v5_coverage}
                  onCheckedChange={(v) => setCfg.mutate({ system_v5: { feature_flags: { ...flags, v5_coverage: v } } })} />
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm">Chặng:</span>
                {["off", "grace", "shadow_coverage", "shadow_money", "live"].map((s) => (
                  <Button key={s} size="sm"
                    variant={cfgQ.data?.system_v5?.stage === s ? "default" : "outline"}
                    onClick={() => setCfg.mutate({ system_v5: { stage: s } })}>
                    {s}
                  </Button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Key 💰 (attendance_v5/streak_v5) đổi qua RPC sẽ hiệu lực từ đầu tháng kế + có audit. Flags/stage áp NGAY.
              </p>
            </div>

            <div className="rounded-xl border p-4">
              <div className="mb-2 text-sm font-semibold">Jobs (chạy lại thủ công — idempotent)</div>
              <div className="flex flex-wrap gap-2">
                {["nightly", "digest", "tier", "score", "close_period"].map((j) => (
                  <Button key={j} size="sm" variant="outline" disabled={runJob.isPending}
                    onClick={() => runJob.mutate(j)}>{j}</Button>
                ))}
              </div>
              <div className="mt-3 max-h-56 overflow-auto rounded bg-slate-50 p-2 text-[11px]">
                {(cronQ.data ?? []).map((c: any) => (
                  <div key={c.id} className="border-b py-1">
                    <b>{c.job}</b> · {c.idem_key} · {c.finished_at ? "✅" : "…"} {c.error ? `⛔ ${c.error}` : ""}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </MainLayout>
  );
}
