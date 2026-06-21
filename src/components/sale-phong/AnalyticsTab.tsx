/**
 * Tab "Thống kê" trong /sale-phong — đo đếm hiệu quả trang công khai /r/:token.
 * Lọc: khoảng ngày + link chia sẻ + toà nhà + loại trừ lượt xem nội bộ.
 * 5 mục: Tổng quan · Phòng được xem nhiều · Theo thời gian · Theo link · Lỗi.
 */
import { useMemo, useState } from "react";
import { format, subDays, parseISO } from "date-fns";
import type { DateRange } from "react-day-picker";
import {
  Eye, Clock, DoorOpen, Layers, Phone, AlertTriangle, Users, Activity,
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DateRangePicker } from "@/components/reports/DateRangePicker";
import { ExportButtons } from "@/components/reports/ExportButtons";
import BuildingMultiSelect from "@/components/buildings/BuildingMultiSelect";
import { KpiCard } from "@/components/finance-analysis/KpiCard";
import { ChartCard } from "@/components/finance-analysis/ChartCard";
import { usePublicRoomTokens } from "@/hooks/usePublicRoomTokens";
import { fmtDuration } from "./analyticsUtils";
import {
  usePraSummary, usePraTimeseries, usePraTopRooms, usePraFunnel,
  usePraByToken, usePraErrors,
  type PraFilters, type PraTopRoomRow, type PraTimeseriesRow,
} from "@/hooks/usePublicRoomsAnalytics";

/* ===== helpers ===== */
const COLORS = { views: "#3b82f6", opens: "#f59e0b", impr: "#8b5cf6", contact: "#10b981" };

const fmtDay = (iso: string) => {
  try { return format(parseISO(iso), "dd/MM"); } catch { return iso; }
};
const roomLabel = (r: { room_code: string | null; room_name: string | null }) =>
  r.room_code || r.room_name || "(phòng đã xoá)";

/* ===== Shell ===== */
export default function AnalyticsTab() {
  const [range, setRange] = useState<DateRange | undefined>({
    from: subDays(new Date(), 29),
    to: new Date(),
  });
  const [token, setToken] = useState("");
  const [buildingIds, setBuildingIds] = useState<string[]>([]);
  const [excludeStaff, setExcludeStaff] = useState(false);

  const { data: tokens = [] } = usePublicRoomTokens();
  const tokenOptions = useMemo(
    () => [
      { value: "", label: "Tất cả link chia sẻ" },
      ...tokens.map((t) => ({
        value: t.token,
        label: (t.label || `(${t.token})`) + (t.revoked ? " — đã thu hồi" : ""),
      })),
    ],
    [tokens],
  );

  const filters: PraFilters = {
    start: range?.from ? format(range.from, "yyyy-MM-dd") : undefined,
    end: range?.to ? format(range.to, "yyyy-MM-dd") : range?.from ? format(range.from, "yyyy-MM-dd") : undefined,
    token,
    buildingIds,
    excludeStaff,
  };

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/30 p-3">
        <div className="grid gap-1">
          <span className="text-xs font-medium text-muted-foreground">Khoảng thời gian</span>
          <DateRangePicker value={range} onChange={setRange} />
        </div>
        <div className="grid gap-1">
          <span className="text-xs font-medium text-muted-foreground">Link chia sẻ</span>
          <SearchableSelect
            value={token}
            onValueChange={setToken}
            options={tokenOptions}
            className="w-[240px]"
            placeholder="Tất cả link chia sẻ"
          />
        </div>
        <div className="grid gap-1">
          <span className="text-xs font-medium text-muted-foreground">Toà nhà</span>
          <BuildingMultiSelect value={buildingIds} onChange={setBuildingIds} className="w-[240px]" />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="excl-staff" checked={excludeStaff} onCheckedChange={setExcludeStaff} />
          <Label htmlFor="excl-staff" className="text-sm">Loại trừ lượt xem nội bộ</Label>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="overview" className="gap-1.5"><Activity className="h-4 w-4" />Tổng quan</TabsTrigger>
          <TabsTrigger value="rooms" className="gap-1.5"><DoorOpen className="h-4 w-4" />Phòng được xem nhiều</TabsTrigger>
          <TabsTrigger value="traffic" className="gap-1.5"><Clock className="h-4 w-4" />Theo thời gian</TabsTrigger>
          <TabsTrigger value="tokens" className="gap-1.5"><Users className="h-4 w-4" />Theo link</TabsTrigger>
          <TabsTrigger value="errors" className="gap-1.5"><AlertTriangle className="h-4 w-4" />Lỗi</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4"><OverviewSection f={filters} /></TabsContent>
        <TabsContent value="rooms" className="mt-4"><TopRoomsSection f={filters} /></TabsContent>
        <TabsContent value="traffic" className="mt-4"><TrafficSection f={filters} /></TabsContent>
        <TabsContent value="tokens" className="mt-4"><ByTokenSection f={filters} /></TabsContent>
        <TabsContent value="errors" className="mt-4"><ErrorsSection f={filters} /></TabsContent>
      </Tabs>
    </div>
  );
}

/* ===== 1. Tổng quan ===== */
function OverviewSection({ f }: { f: PraFilters }) {
  const summary = usePraSummary(f);
  const ts = usePraTimeseries(f, "day");
  const funnel = usePraFunnel(f);
  const s = summary.data;
  const loading = summary.isLoading;

  const tsData = (ts.data || []).map((r) => ({ ...r, label: fmtDay(r.bucket) }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard label="Lượt xem trang" value={String(s?.total_sessions ?? 0)} icon={Eye} accent="blue" loading={loading} />
        <KpiCard label="Thời gian xem TB" value={fmtDuration(s?.avg_session_ms ?? 0)} icon={Clock} accent="emerald" loading={loading} sub="phút:giây / phiên" />
        <KpiCard label="Lượt mở chi tiết phòng" value={String(s?.room_opens ?? 0)} icon={DoorOpen} accent="amber" loading={loading} />
        <KpiCard label="Lượt hiển thị phòng" value={String(s?.impressions ?? 0)} icon={Layers} accent="violet" loading={loading} sub="phòng lướt qua màn hình" />
        <KpiCard label="Lượt bấm liên hệ" value={String(s?.contact_clicks ?? 0)} icon={Phone} accent="emerald" loading={loading} sub="gọi / Zalo" />
        <KpiCard label="Phòng quan tâm (lưu)" value={String(s?.favorites ?? 0)} icon={Activity} accent="slate" loading={loading} />
        <KpiCard label="Số phòng được xem" value={String(s?.unique_rooms_seen ?? 0)} icon={DoorOpen} accent="slate" loading={loading} />
        <KpiCard label="Số lỗi phát sinh" value={String(s?.errors ?? 0)} icon={AlertTriangle} accent="red" loading={loading} />
      </div>

      <ChartCard title="Lưu lượng theo ngày" loading={ts.isLoading} empty={!tsData.length} height={320}>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={tsData} margin={{ top: 8, right: 16, bottom: 8, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" fontSize={12} />
            <YAxis allowDecimals={false} fontSize={12} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="sessions" name="Lượt xem trang" stroke={COLORS.views} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="room_opens" name="Mở phòng" stroke={COLORS.opens} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="contact_clicks" name="Liên hệ" stroke={COLORS.contact} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Phễu tương tác" loading={funnel.isLoading} empty={!funnel.data || funnel.data.sessions === 0} height={220}>
        <FunnelBars
          stages={[
            { label: "Xem trang", value: funnel.data?.sessions ?? 0 },
            { label: "Hiển thị phòng", value: funnel.data?.sessions_impression ?? 0 },
            { label: "Mở chi tiết phòng", value: funnel.data?.sessions_opened_room ?? 0 },
            { label: "Bấm liên hệ", value: funnel.data?.sessions_contacted ?? 0 },
          ]}
        />
      </ChartCard>
    </div>
  );
}

function FunnelBars({ stages }: { stages: { label: string; value: number }[] }) {
  const top = stages[0]?.value || 0;
  const colors = [COLORS.views, COLORS.impr, COLORS.opens, COLORS.contact];
  return (
    <div className="space-y-3 py-2">
      {stages.map((st, i) => {
        const pct = top ? Math.round((st.value / top) * 100) : 0;
        return (
          <div key={st.label} className="flex items-center gap-3">
            <span className="w-40 shrink-0 text-sm text-muted-foreground">{st.label}</span>
            <div className="relative h-7 flex-1 overflow-hidden rounded bg-muted">
              <div className="h-full rounded transition-all" style={{ width: `${pct}%`, background: colors[i % colors.length] }} />
              <span className="absolute inset-y-0 left-2 flex items-center text-xs font-medium text-foreground">
                {st.value.toLocaleString("vi-VN")} ({pct}%)
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ===== 2. Phòng được xem nhiều ===== */
type SortKey = "open_count" | "impression_count" | "total_dwell_ms";
function TopRoomsSection({ f }: { f: PraFilters }) {
  const { data = [], isLoading } = usePraTopRooms(f, 100);
  const [sortBy, setSortBy] = useState<SortKey>("open_count");

  const rows = useMemo(
    () => [...data].sort((a, b) => (b[sortBy] as number) - (a[sortBy] as number)),
    [data, sortBy],
  );
  const chartData = rows.slice(0, 10).map((r) => ({
    name: roomLabel(r),
    value: r[sortBy] as number,
  }));
  const exportRows = rows.map((r) => ({
    "Phòng": roomLabel(r),
    "Toà nhà": r.building_name ?? "",
    "Lượt mở chi tiết": r.open_count,
    "Lượt hiển thị": r.impression_count,
    "Tổng thời gian xem": fmtDuration(r.total_dwell_ms),
    "TB thời gian/lượt": fmtDuration(r.avg_dwell_ms),
    "Bấm liên hệ": r.contact_clicks,
  }));

  const metricLabel: Record<SortKey, string> = {
    open_count: "lượt mở chi tiết",
    impression_count: "lượt hiển thị",
    total_dwell_ms: "tổng thời gian xem",
  };

  return (
    <div className="space-y-4">
      <ChartCard
        title={`Top 10 phòng theo ${metricLabel[sortBy]}`}
        loading={isLoading}
        empty={!rows.length}
        height={360}
        action={
          <div className="w-[200px]">
            <SearchableSelect
              value={sortBy}
              onValueChange={(v) => setSortBy(v as SortKey)}
              searchable={false}
              options={[
                { value: "open_count", label: "Theo lượt mở chi tiết" },
                { value: "impression_count", label: "Theo lượt hiển thị" },
                { value: "total_dwell_ms", label: "Theo thời gian xem" },
              ]}
            />
          </div>
        }
      >
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 24 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis
              type="number"
              allowDecimals={false}
              fontSize={12}
              tickFormatter={(v) => (sortBy === "total_dwell_ms" ? fmtDuration(Number(v)) : String(v))}
            />
            <YAxis type="category" dataKey="name" width={90} fontSize={12} />
            <Tooltip formatter={(v) => (sortBy === "total_dwell_ms" ? fmtDuration(Number(v)) : v)} />
            <Bar dataKey="value" name={metricLabel[sortBy]} radius={[0, 4, 4, 0]}>
              {chartData.map((_, i) => <Cell key={i} fill={COLORS.opens} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Chi tiết theo phòng"
        loading={isLoading}
        empty={!rows.length}
        height={360}
        action={<ExportButtons data={exportRows} filename={`top-phong-${f.start}_${f.end}`} />}
      >
        <RoomsTable rows={rows} />
      </ChartCard>
    </div>
  );
}

function RoomsTable({ rows }: { rows: PraTopRoomRow[] }) {
  return (
    <div className="max-h-[420px] overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Phòng</TableHead>
            <TableHead>Toà nhà</TableHead>
            <TableHead className="text-right">Mở chi tiết</TableHead>
            <TableHead className="text-right">Hiển thị</TableHead>
            <TableHead className="text-right">TG xem</TableHead>
            <TableHead className="text-right">TB/lượt</TableHead>
            <TableHead className="text-right">Liên hệ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.room_id ?? roomLabel(r)}>
              <TableCell className="font-medium">{roomLabel(r)}</TableCell>
              <TableCell className="text-muted-foreground">{r.building_name ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{r.open_count}</TableCell>
              <TableCell className="text-right tabular-nums">{r.impression_count}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtDuration(r.total_dwell_ms)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtDuration(r.avg_dwell_ms)}</TableCell>
              <TableCell className="text-right tabular-nums">{r.contact_clicks}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/* ===== 3. Theo thời gian ===== */
function TrafficSection({ f }: { f: PraFilters }) {
  const day = usePraTimeseries(f, "day");
  const hour = usePraTimeseries(f, "hour");

  const dayData = (day.data || []).map((r) => ({ ...r, label: fmtDay(r.bucket) }));

  // Phân bố theo GIỜ trong ngày (0–23): gộp các bucket giờ theo phần giờ của chuỗi.
  const byHour = useMemo(() => {
    const acc = new Array(24).fill(0);
    for (const r of hour.data || ([] as PraTimeseriesRow[])) {
      const m = /T(\d{2})/.exec(r.bucket);
      if (m) acc[Number(m[1])] += r.sessions;
    }
    return acc.map((v, h) => ({ hour: `${String(h).padStart(2, "0")}h`, sessions: v }));
  }, [hour.data]);

  return (
    <div className="space-y-4">
      <ChartCard title="Lưu lượng theo ngày" loading={day.isLoading} empty={!dayData.length} height={320}>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={dayData} margin={{ top: 8, right: 16, bottom: 8, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" fontSize={12} />
            <YAxis allowDecimals={false} fontSize={12} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="sessions" name="Lượt xem trang" stroke={COLORS.views} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="room_opens" name="Mở phòng" stroke={COLORS.opens} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Phân bố theo giờ trong ngày" loading={hour.isLoading} empty={!dayData.length} height={300}>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={byHour} margin={{ top: 8, right: 16, bottom: 8, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="hour" fontSize={11} interval={1} />
            <YAxis allowDecimals={false} fontSize={12} />
            <Tooltip />
            <Bar dataKey="sessions" name="Lượt xem trang" fill={COLORS.views} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

/* ===== 4. Theo link chia sẻ ===== */
function ByTokenSection({ f }: { f: PraFilters }) {
  const { data = [], isLoading } = usePraByToken(f);
  const rows = data;
  const chartData = rows.slice(0, 12).map((r) => ({
    name: r.label || `(${r.token})`,
    sessions: r.sessions,
  }));
  const exportRows = rows.map((r) => ({
    "Link chia sẻ": r.label || r.token,
    "Token": r.token,
    "Trạng thái": r.revoked ? "Đã thu hồi" : "Đang dùng",
    "Lượt xem": r.sessions,
    "Mở phòng": r.room_opens,
    "Bấm liên hệ": r.contact_clicks,
    "TG xem TB": fmtDuration(r.avg_session_ms),
    "Số lỗi": r.errors,
  }));

  return (
    <div className="space-y-4">
      <ChartCard title="Lượt xem theo link chia sẻ" loading={isLoading} empty={!rows.length} height={320}>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" fontSize={11} interval={0} angle={-15} textAnchor="end" height={60} />
            <YAxis allowDecimals={false} fontSize={12} />
            <Tooltip />
            <Bar dataKey="sessions" name="Lượt xem" fill={COLORS.impr} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Chi tiết theo link"
        loading={isLoading}
        empty={!rows.length}
        height={300}
        action={<ExportButtons data={exportRows} filename={`thong-ke-link-${f.start}_${f.end}`} />}
      >
        <div className="max-h-[420px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Link chia sẻ</TableHead>
                <TableHead className="text-right">Lượt xem</TableHead>
                <TableHead className="text-right">Mở phòng</TableHead>
                <TableHead className="text-right">Liên hệ</TableHead>
                <TableHead className="text-right">TG xem TB</TableHead>
                <TableHead className="text-right">Lỗi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.token}>
                  <TableCell className="font-medium">
                    {r.label || `(${r.token})`}
                    {r.revoked && <Badge variant="outline" className="ml-2 text-xs">đã thu hồi</Badge>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.sessions}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.room_opens}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.contact_clicks}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtDuration(r.avg_session_ms)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.errors}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </ChartCard>
    </div>
  );
}

/* ===== 5. Lỗi ===== */
function ErrorsSection({ f }: { f: PraFilters }) {
  const { data = [], isLoading } = usePraErrors(f, 300);
  const exportRows = data.map((r) => ({
    "Thời điểm": r.created_at,
    "Loại": r.kind ?? "",
    "Thông điệp": r.message ?? "",
    "Vị trí": r.context ?? "",
    "Link": r.token,
    "Trình duyệt": r.user_agent ?? "",
  }));
  const fmtTs = (iso: string) => {
    try { return format(parseISO(iso), "dd/MM HH:mm"); } catch { return iso; }
  };

  return (
    <ChartCard
      title={`Nhật ký lỗi (${data.length})`}
      loading={isLoading}
      empty={!data.length}
      height={200}
      action={data.length ? <ExportButtons data={exportRows} filename={`nhat-ky-loi-${f.start}_${f.end}`} /> : undefined}
    >
      {!data.length ? (
        <div className="grid h-[180px] place-items-center text-sm text-muted-foreground">
          Chưa có lỗi nào trong kỳ — tốt!
        </div>
      ) : (
        <div className="max-h-[460px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Thời điểm</TableHead>
                <TableHead>Loại</TableHead>
                <TableHead>Thông điệp</TableHead>
                <TableHead>Vị trí</TableHead>
                <TableHead>Link</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r, i) => (
                <TableRow key={i}>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">{fmtTs(r.created_at)}</TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{r.kind ?? "—"}</Badge></TableCell>
                  <TableCell className="max-w-[360px] truncate text-xs" title={r.message ?? ""}>{r.message ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.context ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.token}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </ChartCard>
  );
}
