// OwnerDashboardV5 (/reports/coverage) — TRUNG TÂM v5 của CHỦ, 5 tab:
// Coverage map · Nghi án · Đối soát tháng (3 ASSERT + nút chốt tiền) · Shadow/Gates · Cài đặt v5.
// LƯU Ý VỊ TRÍ (lệch nhỏ so US-5.1, ghi log): settings v5 đặt TẠI ĐÂY thay vì GeneralSettingsPage
// để chủ có đúng 1 nơi vận hành v5; chức năng đầy đủ theo catalog.
import { useMemo, useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useSignedUrl } from "@/hooks/useSignedUrl";
// Data layer tách riêng (Phase 9A) — UI chỉ nhận data/loading và gọi mutation.
import {
  useV5Coverage, useV5Flagged, useV5InspectionLog, useV5SessionPhotos,
  useV5LockAssert, useV5ShadowReport, useV5AdminConfig, useV5CronRuns,
  useV5SetConfig, useV5Verdict, useV5ApplyLock, useV5RunJob,
  type InspectionSessionRow, type InspectionPhotoRow,
} from "@/hooks/salary-v5/useSalaryV5Admin";

const fmt = (n: number) => Math.round(Number(n) || 0).toLocaleString("vi-VN") + "đ";
// Đọc theo giờ LOCAL, không qua toISOString(): toISOString đổi sang UTC nên trước
// 7h sáng giờ VN nó trả ngày hôm trước — và với `thisMonth` thì vào ngày 1 nó trả
// hẳn THÁNG trước, tức bảng điều khiển mở ra ở sai kỳ.
// `ymd` còn nhận Date được cộng/trừ bằng setDate() (API local), nên đọc bằng UTC
// là trộn hai hệ quy chiếu ngay trong một biểu thức.
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const thisMonth = () => ymd(new Date()).slice(0, 8) + "01";
const hhmm = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : "—";
const fmtDwell = (sec: number | null) => {
  const s = Math.max(0, Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const STATUS_META: Record<string, { label: string; cls: string }> = {
  passed: { label: "Đạt", cls: "bg-emerald-100 text-emerald-700" },
  quick_done: { label: "Nhanh xong", cls: "bg-sky-100 text-sky-700" },
  expired: { label: "Hết giờ", cls: "bg-red-100 text-red-700" },
  open: { label: "Đang mở", cls: "bg-amber-100 text-amber-700" },
  presence: { label: "Có mặt", cls: "bg-amber-100 text-amber-700" },
};

function InspPhoto({ p }: { p: InspectionPhotoRow }) {
  const url = useSignedUrl(p.storage_path);
  const geo = p.geofence_status as string | null;
  const geoColor =
    geo === "inside" ? "text-emerald-600" : geo === "outside" ? "text-red-600" : "text-muted-foreground";
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block">
      <div className="aspect-square overflow-hidden rounded-lg border bg-slate-100">
        {url ? (
          <img src={url} alt={p.slot} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">
            đang tải…
          </div>
        )}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
        {p.slot}
        {p.distance_m != null ? ` · ${p.distance_m}m` : ""} · <span className={geoColor}>{geo ?? "—"}</span>
      </div>
    </a>
  );
}

function InspSessionCard({ s }: { s: InspectionSessionRow }) {
  const [open, setOpen] = useState(false);
  const photos = useV5SessionPhotos(s.id, open);
  const stat = STATUS_META[s.status] ?? { label: s.status, cls: "bg-slate-100 text-slate-600" };
  // Buộc vào const: `Array.isArray(s.fail_reasons)` thu hẹp được ngay tại chỗ, nhưng
  // kết quả cất vào biến boolean thì TS không mang thu hẹp đó xuống chỗ gọi .join().
  const failReasons = Array.isArray(s.fail_reasons) ? s.fail_reasons : [];
  const hasFails = failReasons.length > 0;
  return (
    <div className="rounded-xl border p-3">
      <button className="flex w-full items-start justify-between gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-semibold">{s.building_name}</span>
            <span className="text-muted-foreground">·</span>
            <span>{s.manager_name}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                s.type === "FULL" ? "bg-indigo-100 text-indigo-700" : "bg-sky-100 text-sky-700"
              }`}
            >
              {s.type}
            </span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${stat.cls}`}>{stat.label}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {hhmm(s.started_at)}
            {s.ended_at ? `–${hhmm(s.ended_at)}` : ""} · ở {fmtDwell(s.dwell_seconds)} · {s.photos_count} ảnh
          </div>
          {s.condition_note && s.condition_note !== "OK" && (
            <div className="mt-1 text-xs">
              <span className="text-muted-foreground">Ghi chú:</span> {s.condition_note}
            </div>
          )}
          {hasFails && <div className="mt-1 text-xs text-red-600">Lỗi: {failReasons.join(", ")}</div>}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-3 border-t pt-3">
          {photos.isLoading ? (
            <div className="text-xs text-muted-foreground">Đang tải ảnh…</div>
          ) : (photos.data ?? []).length === 0 ? (
            <div className="text-xs text-muted-foreground">Phiên này không có ảnh.</div>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {(photos.data ?? []).map((p) => (
                <InspPhoto key={p.id} p={p} />
              ))}
            </div>
          )}
          <div className="mt-2 text-[11px] text-muted-foreground">
            Tình trạng ghi nhận: {s.condition_note || "—"}
            {hasFails ? ` · Lỗi: ${failReasons.join(", ")}` : ""}
          </div>
        </div>
      )}
    </div>
  );
}

export default function OwnerDashboardV5() {
  const coverage = useV5Coverage();
  const flagged = useV5Flagged();
  const [month] = useState(thisMonth());

  // --- Nhật ký kiểm tra: filter theo ngày/toà/quản lý + nhóm linh hoạt ---
  const [logFrom, setLogFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 13);
    return ymd(d);
  });
  const [logTo, setLogTo] = useState(() => ymd(new Date()));
  const [fBuilding, setFBuilding] = useState("");
  const [fUser, setFUser] = useState("");
  const [groupBy, setGroupBy] = useState<"day" | "building" | "user">("day");
  const logQ = useV5InspectionLog(logFrom, logTo);
  const logRows: InspectionSessionRow[] = logQ.data ?? [];

  const buildingOpts = useMemo(() => {
    const m = new Map<string, string>();
    logRows.forEach((r) => m.set(r.building_id, r.building_name));
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }, [logRows]);
  const userOpts = useMemo(() => {
    const m = new Map<string, string>();
    logRows.forEach((r) => m.set(r.user_id, r.manager_name));
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }, [logRows]);
  const logFiltered = useMemo(
    () => logRows.filter((r) => (!fBuilding || r.building_id === fBuilding) && (!fUser || r.user_id === fUser)),
    [logRows, fBuilding, fUser],
  );
  const logGroups = useMemo(() => {
    const keyOf = (r: InspectionSessionRow) =>
      groupBy === "day"
        ? r.session_date
        : groupBy === "building"
          ? r.building_name
          : r.manager_name;
    const m = new Map<string, InspectionSessionRow[]>();
    logFiltered.forEach((r) => {
      const k = keyOf(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    });
    return Array.from(m, ([label, rows]) => ({ label, rows }));
  }, [logFiltered, groupBy]);
  const groupHeading = (label: string) =>
    groupBy === "day"
      ? new Date(label + "T00:00:00").toLocaleDateString("vi-VN", {
          weekday: "short",
          day: "2-digit",
          month: "2-digit",
        })
      : label;

  const assertQ = useV5LockAssert(month);
  const shadowQ = useV5ShadowReport(month);
  const cfgQ = useV5AdminConfig();
  const cronQ = useV5CronRuns();

  const setCfg = useV5SetConfig();
  const verdict = useV5Verdict();
  const applyLock = useV5ApplyLock(month);
  const runJob = useV5RunJob();

  const flags = cfgQ.data?.system_v5?.feature_flags ?? {};
  const dColor = (d: number | null) =>
    d == null ? "bg-red-500" : d > 6 ? "bg-red-500" : d > 4 ? "bg-red-400" : d > 3 ? "bg-amber-400" : "bg-emerald-500";

  return (
    <MainLayout title="Vận hành lương v5" >
      <Tabs defaultValue="coverage" className="w-full">
        <TabsList className="flex-wrap">
          <TabsTrigger value="coverage">Coverage</TabsTrigger>
          <TabsTrigger value="insplog">Nhật ký KT</TabsTrigger>
          <TabsTrigger value="fraud">Nghi án {flagged.data?.length ? `(${flagged.data.length})` : ""}</TabsTrigger>
          <TabsTrigger value="recon">Đối soát tháng</TabsTrigger>
          <TabsTrigger value="shadow">Shadow / Gates</TabsTrigger>
          <TabsTrigger value="settings">Cài đặt v5</TabsTrigger>
        </TabsList>

        {/* TAB 1 — Coverage map (grid màu theo D) */}
        <TabsContent value="coverage">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {(coverage.data ?? []).map((b) => (
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

        {/* TAB 1b — Nhật ký kiểm tra nhà: chi tiết từng phiên của quản lý */}
        <TabsContent value="insplog">
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="text-xs">
              <span className="mb-1 block text-muted-foreground">Từ ngày</span>
              <input
                type="date"
                value={logFrom}
                max={logTo}
                onChange={(e) => setLogFrom(e.target.value)}
                className="rounded-md border px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-muted-foreground">Đến ngày</span>
              <input
                type="date"
                value={logTo}
                min={logFrom}
                onChange={(e) => setLogTo(e.target.value)}
                className="rounded-md border px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-muted-foreground">Toà nhà</span>
              <select
                value={fBuilding}
                onChange={(e) => setFBuilding(e.target.value)}
                className="rounded-md border px-2 py-1 text-sm"
              >
                <option value="">Tất cả</option>
                {buildingOpts.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-muted-foreground">Quản lý</span>
              <select
                value={fUser}
                onChange={(e) => setFUser(e.target.value)}
                className="rounded-md border px-2 py-1 text-sm"
              >
                <option value="">Tất cả</option>
                {userOpts.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-xs">
              <span className="mb-1 block text-muted-foreground">Nhóm theo</span>
              <div className="flex gap-1">
                {([
                  { k: "day", label: "Ngày" },
                  { k: "building", label: "Toà" },
                  { k: "user", label: "Quản lý" },
                ] as const).map((o) => (
                  <Button
                    key={o.k}
                    size="sm"
                    variant={groupBy === o.k ? "default" : "outline"}
                    onClick={() => setGroupBy(o.k)}
                  >
                    {o.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <div className="mb-2 text-xs text-muted-foreground">
            {logQ.isLoading
              ? "Đang tải…"
              : `${logFiltered.length} phiên · ${logFiltered.filter((r) => r.status === "passed").length} đạt · ${logFiltered.filter((r) => r.status === "expired").length} hết giờ`}
          </div>

          {!logQ.isLoading && logFiltered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Không có phiên kiểm tra nào trong khoảng đã chọn.
            </p>
          ) : (
            <div className="space-y-4">
              {logGroups.map((g) => (
                <div key={g.label}>
                  <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
                    {groupHeading(g.label)}
                    <span className="text-xs font-normal text-muted-foreground">({g.rows.length})</span>
                  </div>
                  <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                    {g.rows.map((s) => (
                      <InspSessionCard key={s.id} s={s} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* TAB 2 — Nghi án (máy flag, chủ kết án, due process C2) */}
        <TabsContent value="fraud">
          {(flagged.data ?? []).length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Không có nghi án nào đang mở.</p>
          ) : (
            (flagged.data ?? []).map((f) => (
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
                {(assertQ.data ?? []).map((r) => (
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
              disabled={applyLock.isPending || (assertQ.data ?? []).some((r) => !r.all_ok) || !flags.v5_money}
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
                {(shadowQ.data?.rows ?? []).map((r) => (
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

        {/* TAB 5 — Cài đặt v5: chế độ lương/flags/stage/jobs/cron_runs */}
        <TabsContent value="settings">
          <div className="max-w-xl space-y-4">
            {/* Công tắc chọn CHẾ ĐỘ LƯƠNG đang áp dụng cho trang /finance/salary */}
            <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50/50 p-4">
              <div className="mb-1 text-sm font-semibold">Chế độ lương đang áp dụng</div>
              <p className="mb-2 text-[11px] text-muted-foreground">
                Cả hai cùng tính song song. Bật cái nào thì trang <b>Bảng lương</b> (/finance/salary) hiển thị &amp; chốt theo cái đó.
              </p>
              <div className="flex gap-2">
                {[
                  { key: "legacy", label: "Lương cũ (v4)" },
                  { key: "v5", label: "Lương v5 (chuyên cần + chuỗi)" },
                ].map((o) => {
                  const cur = cfgQ.data?.system_v5?.salary_engine === "v5" ? "v5" : "legacy";
                  return (
                    <Button key={o.key} size="sm"
                      variant={cur === o.key ? "default" : "outline"}
                      onClick={() => setCfg.mutate({ system_v5: { salary_engine: o.key } })}>
                      {o.label}
                    </Button>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Đổi tức thì. Lương v5 hiện <b>TẠM TÍNH</b>; ghi vào lương thật vẫn qua tab Đối soát (cần bật <code>v5_money</code>).
              </p>
            </div>

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
                {(cronQ.data ?? []).map((c) => (
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
