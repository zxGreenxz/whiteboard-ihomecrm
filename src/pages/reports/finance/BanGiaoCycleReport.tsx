// =============================================
// Báo cáo "Chu kỳ Thu → Bàn giao" theo tòa quản lý.
//  - Thẻ tổng: đã thu (kỳ) · đã bàn giao (kỳ) · CHƯA THU (hiện tại) · tổng đã lên HĐ.
//  - Timeline: mỗi mốc bàn giao → đã thu trong đoạn · net · CHƯA THU tại mốc (point-in-time);
//    dòng cuối "Hiện tại".
//  - Bảng theo tòa: tổng HĐ · đã thu · chưa thu · số HĐ chưa xong.
// Chủ chọn quản lý; quản lý tự xem (managerId rỗng = self). Dữ liệu: RPC
// manager_collection_cycle_report (useCollectionCycleReport).
// =============================================

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Repeat } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { DateRangePicker } from '@/components/reports/DateRangePicker';
import { format, startOfMonth, subMonths } from 'date-fns';
import { useCollectionCycleReport } from '@/hooks/useCollectionCycleReport';
import { usePersistedState, usePersistedDateRange } from '@/hooks/usePersistedState';
import { useStaffUsers } from '@/hooks/useStaffUsers';
import { useAuth } from '@/hooks/useAuth';

const fmt = (n: number | null | undefined) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n || 0);
const toDate = (d: Date) => format(d, 'yyyy-MM-dd');
const fmtDT = (d?: string | null) => {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear()} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
};

export default function BanGiaoCycleReport() {
  const { data: currentUser } = useAuth();
  const { data: staff = [] } = useStaffUsers();

  const [managerId, setManagerId] = usePersistedState('flt:rpt-ban-giao-cycle:managerId', ''); // '' = self (chính mình)
  const [dateRange, setDateRange] = usePersistedDateRange('flt:rpt-ban-giao-cycle:dateRange', {
    from: startOfMonth(subMonths(new Date(), 2)),
    to: new Date(),
  });
  const from = dateRange?.from ? toDate(dateRange.from) : '';
  const to = dateRange?.to ? toDate(dateRange.to) : '';

  const { data, isLoading } = useCollectionCycleReport(managerId, from, to);

  const managerOptions = useMemo(
    () => [
      { value: '', label: 'Tôi (chính mình)' },
      ...staff
        .filter((u: any) => u.id !== currentUser?.id)
        .map((u: any) => ({ value: u.id, label: u.full_name || u.email })),
    ],
    [staff, currentUser],
  );

  const s = data?.summary;
  const buildings = data?.buildings ?? [];
  const timeline = data?.timeline ?? [];

  const stat = (label: string, value: number | undefined, tone?: string) => (
    <Card>
      <CardContent className="pt-5">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className={`mt-1 text-xl font-bold tabular-nums ${tone ?? ''}`}>{fmt(value)}</div>
      </CardContent>
    </Card>
  );

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/reports/finance" className="hover:text-primary">Báo cáo tài chính</Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Chu kỳ Thu — Bàn giao</span>
        </div>

        <div className="flex items-center gap-2">
          <Repeat className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Chu kỳ Thu — Bàn giao</h1>
            <p className="text-sm text-muted-foreground">
              Theo tòa quản lý phụ trách: đã thu · đã bàn giao · và CHƯA THU chốt lại ở mỗi mốc bàn giao.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-[240px]">
            <div className="text-xs text-muted-foreground mb-1">Quản lý</div>
            <SearchableSelect
              value={managerId}
              onValueChange={setManagerId}
              placeholder="Chọn quản lý"
              options={managerOptions}
            />
          </div>
          <DateRangePicker value={dateRange} onChange={setDateRange} />
          {data && (
            <div className="text-xs text-muted-foreground pb-2">
              {data.manager?.name || '—'} · {data.building_count} tòa
            </div>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {stat('Đã thu (kỳ)', s?.collected_period, 'text-emerald-700')}
          {stat('Đã bàn giao (kỳ)', s?.handed_over_period, 'text-blue-700')}
          {stat('Chưa thu (hiện tại)', s?.outstanding_current, 'text-red-700')}
          {stat('Tổng đã lên HĐ', s?.total_billed_current)}
        </div>

        {/* Timeline theo mốc bàn giao */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Chu kỳ theo mốc bàn giao</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="border-r font-semibold">Mốc</TableHead>
                  <TableHead className="border-r font-semibold">Thời gian</TableHead>
                  <TableHead className="border-r text-right font-semibold">Đã thu trong đoạn</TableHead>
                  <TableHead className="border-r text-right font-semibold">Bàn giao</TableHead>
                  <TableHead className="text-right font-semibold">Chưa thu tại mốc</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <TableRow key={i}><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ))
                ) : timeline.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">Không có dữ liệu.</TableCell></TableRow>
                ) : (
                  timeline.map((r, idx) => {
                    const isCurrent = r.type === 'CURRENT';
                    return (
                      <TableRow key={idx} className={isCurrent ? 'bg-amber-50/60' : idx % 2 === 1 ? 'bg-muted/20' : ''}>
                        <TableCell className="border-r">
                          {isCurrent ? (
                            <Badge variant="outline" className="text-amber-700 border-amber-300">Hiện tại — chưa bàn giao</Badge>
                          ) : (
                            <span className="font-mono text-xs">{r.code}
                              {r.from_account ? <span className="text-muted-foreground"> · {r.from_account}</span> : ''}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="border-r text-sm text-muted-foreground">{isCurrent ? '—' : fmtDT(r.confirmed_at)}</TableCell>
                        <TableCell className="border-r text-right tabular-nums text-emerald-700">{fmt(r.collected_in_segment)}</TableCell>
                        <TableCell className="border-r text-right tabular-nums text-blue-700">{isCurrent ? '—' : fmt(r.net)}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold text-red-700">{fmt(r.outstanding_as_of)}</TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
            <p className="mt-2 text-[11px] text-muted-foreground">
              "Đã thu" = tổng thu cho các tòa quản lý (mọi người thu, cả tiền mặt + chuyển khoản) — khác cơ sở với "Bàn giao" (tiền mặt ròng quản lý đem nộp). "Chưa thu tại mốc" chốt theo ngày bàn giao.
            </p>
          </CardContent>
        </Card>

        {/* Theo từng tòa */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Công nợ theo tòa ({buildings.length})</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="border-r font-semibold">Tòa</TableHead>
                  <TableHead className="border-r text-right font-semibold">Tổng đã lên HĐ</TableHead>
                  <TableHead className="border-r text-right font-semibold">Đã thu</TableHead>
                  <TableHead className="border-r text-right font-semibold">Chưa thu</TableHead>
                  <TableHead className="text-right font-semibold">HĐ chưa xong</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ))
                ) : buildings.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">Không có tòa nào trong phạm vi.</TableCell></TableRow>
                ) : (
                  buildings.map((b, idx) => (
                    <TableRow key={b.building_id} className={idx % 2 === 1 ? 'bg-muted/20' : ''}>
                      <TableCell className="border-r font-medium">{b.name ?? '—'}</TableCell>
                      <TableCell className="border-r text-right tabular-nums">{fmt(b.total_billed)}</TableCell>
                      <TableCell className="border-r text-right tabular-nums text-emerald-700">{fmt(b.collected)}</TableCell>
                      <TableCell className="border-r text-right tabular-nums font-semibold text-red-700">{fmt(b.outstanding)}</TableCell>
                      <TableCell className="text-right tabular-nums">{b.unpaid_count || 0}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
}
