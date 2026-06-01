import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import { ChevronRight } from "lucide-react";
import { useDepositsReport } from "@/hooks/useReports";
import { useAreas } from "@/hooks/useAreas";
import { useBuildings } from "@/hooks/useBuildings";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";

const formatCurrency = (n: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n);

const STATUS_MAP: Record<string, string> = {
  PENDING: "Chờ xác nhận",
  CONFIRMED: "Đã xác nhận",
  CONVERTED: "Đã chuyển HĐ",
  REFUNDED: "Đã hoàn",
  FORFEITED: "Mất cọc",
};

const HOLDING_STATUSES = new Set(["PENDING", "CONFIRMED"]);
const IN_INVOICE_STATUSES = new Set(["CONVERTED"]);

export default function DepositsReport() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [areaId, setAreaId] = useState<string>("all");
  const [buildingId, setBuildingId] = useState<string>("all");
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);

  const { data: areas = [] } = useAreas();
  const { data: buildings = [] } = useBuildings();
  const { data: deposits = [], isLoading } = useDepositsReport();

  const filtered = useMemo(() => {
    let arr = [...(deposits as any[])];
    if (statusFilter !== "all") arr = arr.filter((d) => d.status === statusFilter);
    if (buildingId !== "all") {
      const b = (buildings || []).find((x) => x.id === buildingId);
      if (b) arr = arr.filter((d) => d.rooms?.buildings?.name === b.name);
    }
    return arr;
  }, [deposits, statusFilter, buildingId, buildings]);

  const total = filtered.reduce((s, d: any) => s + (d.amount || 0), 0);
  const totalCount = filtered.length;
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/reports/finance" className="hover:text-primary">
            Báo cáo tài chính
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Danh sách tiền cọc</span>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <SearchableSelect
            value={statusFilter}
            onValueChange={setStatusFilter}
            className="w-[200px]"
            placeholder="Loại cọc"
            options={[
              { value: 'all', label: 'Tất cả loại cọc' },
              ...Object.entries(STATUS_MAP).map(([k, v]) => ({ value: k, label: v })),
            ]}
          />

          <SearchableSelect
            value={areaId}
            onValueChange={setAreaId}
            className="w-[200px]"
            placeholder="Chọn khu vực"
            options={[
              { value: 'all', label: 'Tất cả khu vực' },
              ...(areas as any[]).map((a) => ({ value: a.id, label: a.name })),
            ]}
          />

          <SearchableSelect
            value={buildingId}
            onValueChange={setBuildingId}
            className="w-[200px]"
            placeholder="Chọn tòa nhà"
            options={[
              { value: 'all', label: 'Tất cả tòa nhà' },
              ...buildings.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
        </div>

        <div className="text-base font-semibold">Tổng: {formatCurrency(total)}</div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tòa nhà</TableHead>
                <TableHead>Căn hộ</TableHead>
                <TableHead>Khách hàng</TableHead>
                <TableHead className="text-right">Số tiền cọc</TableHead>
                <TableHead className="text-right">Số tiền cọc (giữ chỗ)</TableHead>
                <TableHead className="text-right">Số tiền cọc (trong hóa đơn)</TableHead>
                <TableHead>Phân loại</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : pageRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    Không có dữ liệu nào để hiển thị
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((d: any) => (
                  <TableRow key={d.id}>
                    <TableCell>{d.rooms?.buildings?.name || "—"}</TableCell>
                    <TableCell>{d.rooms?.room_number || "—"}</TableCell>
                    <TableCell>{d.leads?.full_name || d.tenants?.full_name || "—"}</TableCell>
                    <TableCell className="text-right font-semibold">
                      {formatCurrency(d.amount || 0)}
                    </TableCell>
                    <TableCell className="text-right">
                      {HOLDING_STATUSES.has(d.status) ? formatCurrency(d.amount || 0) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {IN_INVOICE_STATUSES.has(d.status) ? formatCurrency(d.amount || 0) : "—"}
                    </TableCell>
                    <TableCell>{STATUS_MAP[d.status] || d.status}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>Số bản ghi</span>
            <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(parseInt(v, 10)); setPage(1); }}>
              <SelectTrigger className="w-[80px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 20, 50, 100].map((n) => (
                  <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            {totalCount === 0
              ? "1 - 0 trên tổng số 0 bản ghi"
              : `${(page - 1) * pageSize + 1} - ${Math.min(page * pageSize, totalCount)} trên tổng số ${totalCount} bản ghi`}
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
