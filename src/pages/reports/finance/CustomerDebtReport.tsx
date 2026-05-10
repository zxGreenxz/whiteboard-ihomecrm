import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import { ChevronRight } from "lucide-react";
import { useCustomerDebtReport } from "@/hooks/useReports";
import { useAreas } from "@/hooks/useAreas";
import { useBuildings } from "@/hooks/useBuildings";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

const formatCurrency = (n: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n);

export default function CustomerDebtReport() {
  const [areaId, setAreaId] = useState<string>("all");
  const [buildingId, setBuildingId] = useState<string>("all");
  const [roomId, setRoomId] = useState<string>("all");
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);

  const { data: areas = [] } = useAreas();
  const { data: buildings = [] } = useBuildings();
  const { data: customerDebts = [], isLoading } = useCustomerDebtReport();

  const filtered = useMemo(() => {
    let rows = [...(customerDebts as any[])];
    if (buildingId !== "all") {
      rows = rows.filter((d) => {
        const bName = d.room?.buildings?.name;
        const b = (buildings || []).find((x) => x.id === buildingId);
        return bName && b && bName === b.name;
      });
    }
    return rows.sort((a: any, b: any) => b.totalDebt - a.totalDebt);
  }, [customerDebts, buildingId, buildings]);

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
          <span className="text-foreground font-medium">Khách nợ tiền</span>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Select value={areaId} onValueChange={setAreaId}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Chọn khu vực" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả khu vực</SelectItem>
              {(areas as any[]).map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={buildingId} onValueChange={setBuildingId}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Chọn tòa nhà" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả tòa nhà</SelectItem>
              {buildings.map((b) => (
                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={roomId} onValueChange={setRoomId}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Chọn phòng" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả phòng</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Khu vực</TableHead>
                <TableHead>Tòa nhà</TableHead>
                <TableHead>Căn hộ</TableHead>
                <TableHead>Giường</TableHead>
                <TableHead>Khách hàng</TableHead>
                <TableHead className="text-right">Tổng nợ tháng này</TableHead>
                <TableHead className="text-right">Đã TT</TableHead>
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
                pageRows.map((d: any, idx: number) => (
                  <TableRow key={d.tenant?.id || idx}>
                    <TableCell>{d.room?.buildings?.area?.name || "—"}</TableCell>
                    <TableCell>{d.room?.buildings?.name || "—"}</TableCell>
                    <TableCell>{d.room?.room_number || "—"}</TableCell>
                    <TableCell>—</TableCell>
                    <TableCell>{d.tenant?.full_name || "—"}</TableCell>
                    <TableCell className="text-right text-red-600 font-semibold">
                      {formatCurrency(d.totalDebt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(
                        (d.invoices || []).reduce(
                          (s: number, inv: any) => s + (inv.amount_paid || 0),
                          0
                        )
                      )}
                    </TableCell>
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
