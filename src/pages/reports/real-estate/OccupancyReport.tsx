// Báo cáo Lấp đầy v2 (Phase 8) — dữ liệu 100% từ RPC server-side
// (useOccupancyDashboard). Snapshot 5 nhóm + trend 12 tháng + sắp trống 30/60
// + doanh thu bỏ lỡ. Định nghĩa metric: OCCUPANCY_METRIC_DEFINITIONS (đi kèm export).
import { useState } from "react";
import {
  Building2, Home, DoorOpen, Wrench, TrendingUp, BookmarkCheck, Ban, Percent,
  RefreshCw,
} from "lucide-react";
import { format } from "date-fns";
import MainLayout from "@/components/layout/MainLayout";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import BuildingFilterSelect from "@/components/buildings/BuildingFilterSelect";
import {
  useOccupancySnapshot, useUpcomingVacancy, useOccupancyTrend12m,
  OCCUPANCY_METRIC_DEFINITIONS,
} from "@/hooks/reports/useOccupancyDashboard";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { usePersistedState } from "@/hooks/usePersistedState";
import { formatVND } from "@/lib/utils";

const COLORS = { occupied: "#10B981", committed: "#6366F1", trend: "#3B82F6" };

const todayStr = () => format(new Date(), "yyyy-MM-dd");

export default function OccupancyReport() {
  const [buildingIds, setBuildingIds] = usePersistedState<string[]>(
    "flt:rpt-occupancy:buildingIds", [],
  );
  const [asOfDate, setAsOfDate] = useState<string>(todayStr());
  const [vacancyWindow, setVacancyWindow] = useState<30 | 60>(30);

  const snapshot = useOccupancySnapshot(asOfDate, buildingIds);
  const vacancy = useUpcomingVacancy(asOfDate, vacancyWindow, buildingIds);
  const trend = useOccupancyTrend12m(buildingIds);

  const rows = snapshot.data ?? [];
  const sum = rows.reduce(
    (a, r) => ({
      total: a.total + r.total,
      occupied: a.occupied + r.occupied,
      reserved: a.reserved + r.reserved,
      maintenance: a.maintenance + r.maintenance,
      unavailable: a.unavailable + r.unavailable,
      available: a.available + r.available,
      missed: a.missed + Number(r.missed_revenue || 0),
    }),
    { total: 0, occupied: 0, reserved: 0, maintenance: 0, unavailable: 0, available: 0, missed: 0 },
  );
  const occPct = sum.total > 0 ? Number(((sum.occupied / sum.total) * 100).toFixed(1)) : 0;
  const comPct = sum.total > 0
    ? Number((((sum.occupied + sum.reserved) / sum.total) * 100).toFixed(1)) : 0;

  const stats = !snapshot.isLoading && !snapshot.isError && (
    <>
      <ReportCard title="Tổng phòng" value={sum.total} icon={Building2} description={`Snapshot ${asOfDate}`} />
      <ReportCard title="Đang thuê" value={sum.occupied} icon={Home} description={`Tỷ lệ lấp đầy ${occPct}%`} />
      <ReportCard title="Đã giữ chỗ" value={sum.reserved} icon={BookmarkCheck} description={`Tỷ lệ cam kết ${comPct}%`} />
      <ReportCard title="Trống" value={sum.available} icon={DoorOpen} description={`Bỏ lỡ ${formatVND(sum.missed)}/tháng`} />
      <ReportCard title="Bảo trì" value={sum.maintenance} icon={Wrench} />
      <ReportCard title="Không khai thác" value={sum.unavailable} icon={Ban} />
      <ReportCard title="Tỷ lệ lấp đầy" value={`${occPct}%`} icon={Percent} />
      <ReportCard title="Tỷ lệ cam kết" value={`${comPct}%`} icon={Percent} description="(Đang thuê + Giữ chỗ) / Tổng" />
    </>
  );

  // Export kèm ngày snapshot + bộ lọc + định nghĩa metric (yêu cầu Phase 8)
  const filterLabel = buildingIds.length === 0 ? "Tất cả toà nhà"
    : rows.filter(r => buildingIds.includes(r.building_id)).map(r => r.building_name).join(", ") || `${buildingIds.length} toà`;
  const exportData: Record<string, unknown>[] = [
    ...rows.map(r => ({
      "Toà nhà": r.building_name,
      "Tổng phòng": r.total,
      "Đang thuê": r.occupied,
      "Đã giữ chỗ": r.reserved,
      "Trống": r.available,
      "Bảo trì": r.maintenance,
      "Không khai thác": r.unavailable,
      "Tỷ lệ lấp đầy (%)": Number(r.occupancy_pct),
      "Tỷ lệ cam kết (%)": Number(r.committed_pct),
      "Doanh thu bỏ lỡ/tháng": Number(r.missed_revenue),
      "Ngày snapshot": asOfDate,
      "Bộ lọc toà": filterLabel,
    })),
    {},
    { "Toà nhà": "— ĐỊNH NGHĨA METRIC —" },
    ...OCCUPANCY_METRIC_DEFINITIONS.map(d => ({ "Toà nhà": d })),
  ];

  const filters = (
    <div className="flex flex-wrap gap-4 items-end">
      <div className="w-[220px]">
        <BuildingFilterSelect value={buildingIds} onChange={setBuildingIds} />
      </div>
      <div>
        <label className="text-xs text-muted-foreground block mb-1">Ngày snapshot</label>
        <Input
          type="date"
          value={asOfDate}
          max={todayStr()}
          onChange={(e) => setAsOfDate(e.target.value || todayStr())}
          className="w-[170px]"
        />
      </div>
    </div>
  );

  const errorBlock = (label: string, refetch: () => void) => (
    <Card>
      <CardContent className="py-8 text-center space-y-3">
        <p className="text-sm text-destructive">Không tải được {label}.</p>
        <Button variant="outline" size="sm" onClick={refetch}>
          <RefreshCw className="h-4 w-4 mr-2" /> Thử lại
        </Button>
      </CardContent>
    </Card>
  );

  return (
    <MainLayout>
      <ReportLayout
        title="Tỉ lệ lấp đầy"
        description="Snapshot theo toà (5 nhóm phòng), trend 12 tháng, phòng sắp trống 30/60 ngày và doanh thu bỏ lỡ — tính toàn bộ trên máy chủ"
        icon={<TrendingUp className="h-8 w-8" />}
        actions={<ExportButtons data={exportData} filename={`ty-le-lap-day-${asOfDate}`} />}
        stats={stats}
        filters={filters}
      >
        {snapshot.isError && errorBlock("snapshot lấp đầy", () => snapshot.refetch())}
        {snapshot.isLoading && (
          <div className="space-y-4">
            <Skeleton className="h-[340px] w-full" />
            <Skeleton className="h-[280px] w-full" />
          </div>
        )}

        {!snapshot.isLoading && !snapshot.isError && (
          <>
            {/* Trend 12 tháng */}
            {trend.isError ? errorBlock("trend 12 tháng", () => trend.refetch()) : (
              <Card>
                <CardHeader>
                  <CardTitle>Trend tỷ lệ lấp đầy 12 tháng</CardTitle>
                </CardHeader>
                <CardContent>
                  {trend.isLoading ? <Skeleton className="h-[300px] w-full" /> : (
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={trend.data ?? []}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="month" />
                        <YAxis domain={[0, 100]} unit="%" />
                        <Tooltip
                          formatter={(value: number, _n, item) => [
                            `${value}% (${item?.payload?.occupied}/${item?.payload?.total} phòng)`,
                            "Tỷ lệ lấp đầy",
                          ]}
                        />
                        <Legend />
                        <Line type="monotone" dataKey="rate" stroke={COLORS.trend}
                          strokeWidth={2} dot={{ r: 3 }} name="Tỷ lệ lấp đầy (%)" />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Bar theo toà: lấp đầy + cam kết */}
            {rows.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Tỷ lệ lấp đầy & cam kết theo toà</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={rows}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="building_name" />
                      <YAxis domain={[0, 100]} unit="%" />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="occupancy_pct" fill={COLORS.occupied} name="Lấp đầy (%)" />
                      <Bar dataKey="committed_pct" fill={COLORS.committed} name="Cam kết (%)" />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {/* Bảng chi tiết theo toà */}
            <Card>
              <CardHeader>
                <CardTitle>Chi tiết theo toà nhà</CardTitle>
              </CardHeader>
              <CardContent>
                {rows.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">Không có dữ liệu</div>
                ) : (
                  <div className="rounded-md border overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Toà nhà</TableHead>
                          <TableHead className="text-center">Tổng</TableHead>
                          <TableHead className="text-center">Đang thuê</TableHead>
                          <TableHead className="text-center">Giữ chỗ</TableHead>
                          <TableHead className="text-center">Trống</TableHead>
                          <TableHead className="text-center">Bảo trì</TableHead>
                          <TableHead className="text-center">Không KT</TableHead>
                          <TableHead className="text-center">Lấp đầy</TableHead>
                          <TableHead className="text-center">Cam kết</TableHead>
                          <TableHead className="text-right">Bỏ lỡ/tháng</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((r) => (
                          <TableRow key={r.building_id}>
                            <TableCell className="font-medium">{r.building_name}</TableCell>
                            <TableCell className="text-center">{r.total}</TableCell>
                            <TableCell className="text-center text-green-600 font-semibold">{r.occupied}</TableCell>
                            <TableCell className="text-center text-indigo-600">{r.reserved}</TableCell>
                            <TableCell className="text-center text-red-600">{r.available}</TableCell>
                            <TableCell className="text-center text-yellow-600">{r.maintenance}</TableCell>
                            <TableCell className="text-center text-muted-foreground">{r.unavailable}</TableCell>
                            <TableCell className="text-center">
                              <span className={`font-semibold ${Number(r.occupancy_pct) >= 90 ? "text-green-600" : Number(r.occupancy_pct) >= 70 ? "text-yellow-600" : "text-red-600"}`}>
                                {Number(r.occupancy_pct)}%
                              </span>
                            </TableCell>
                            <TableCell className="text-center">{Number(r.committed_pct)}%</TableCell>
                            <TableCell className="text-right">
                              {Number(r.missed_revenue) > 0 ? formatVND(Number(r.missed_revenue)) : "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Sắp trống 30/60 ngày */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle>Phòng sắp trống (HĐ hết hiệu lực, đã tính gia hạn)</CardTitle>
                <Tabs value={String(vacancyWindow)} onValueChange={(v) => setVacancyWindow(v === "60" ? 60 : 30)}>
                  <TabsList>
                    <TabsTrigger value="30">30 ngày</TabsTrigger>
                    <TabsTrigger value="60">60 ngày</TabsTrigger>
                  </TabsList>
                </Tabs>
              </CardHeader>
              <CardContent>
                {vacancy.isError ? errorBlock("danh sách sắp trống", () => vacancy.refetch())
                  : vacancy.isLoading ? <Skeleton className="h-[200px] w-full" />
                  : (vacancy.data ?? []).length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      Không có phòng nào hết hạn trong {vacancyWindow} ngày tới 🎉
                    </div>
                  ) : (
                    <div className="rounded-md border overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Toà</TableHead>
                            <TableHead>Phòng</TableHead>
                            <TableHead>Số HĐ</TableHead>
                            <TableHead className="text-center">Hết hiệu lực</TableHead>
                            <TableHead className="text-center">Còn lại</TableHead>
                            <TableHead className="text-right">Giá thuê</TableHead>
                            <TableHead className="text-center">Gia hạn</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(vacancy.data ?? []).map((v) => (
                            <TableRow key={v.room_id}>
                              <TableCell>{v.building_name}</TableCell>
                              <TableCell className="font-medium">{v.room_name}</TableCell>
                              <TableCell className="text-muted-foreground">{v.contract_number}</TableCell>
                              <TableCell className="text-center">{v.effective_end_date}</TableCell>
                              <TableCell className="text-center">
                                <span className={`font-semibold ${v.days_remaining <= 7 ? "text-red-600" : v.days_remaining <= 30 ? "text-yellow-600" : ""}`}>
                                  {v.days_remaining} ngày
                                </span>
                              </TableCell>
                              <TableCell className="text-right">{formatVND(Number(v.rent_price))}</TableCell>
                              <TableCell className="text-center">
                                {v.extension_applied
                                  ? <Badge variant="secondary">Đã gia hạn</Badge>
                                  : <Badge variant="outline">Chưa</Badge>}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
              </CardContent>
            </Card>
          </>
        )}
      </ReportLayout>
    </MainLayout>
  );
}
