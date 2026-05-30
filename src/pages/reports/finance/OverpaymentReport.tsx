import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import { ChevronRight } from "lucide-react";
import { useOverpaymentReport } from "@/hooks/useReports";
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

export default function OverpaymentReport() {
  const [areaId, setAreaId] = useState<string>("all");
  const [buildingId, setBuildingId] = useState<string>("all");
  const [roomId, setRoomId] = useState<string>("all");
  const [bedId, setBedId] = useState<string>("all");
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);

  const { data: areas = [] } = useAreas();
  const { data: buildings = [] } = useBuildings();
  const { data: overpayments = [], isLoading } = useOverpaymentReport();

  const filtered = useMemo(() => {
    let arr = [...(overpayments as any[])];
    if (buildingId !== "all") {
      const b = (buildings || []).find((x) => x.id === buildingId);
      if (b) arr = arr.filter((o) => o.rooms?.buildings?.name === b.name);
    }
    return arr;
  }, [overpayments, buildingId, buildings]);

  const total = filtered.reduce((s, o: any) => s + (o.overpaid_amount || 0), 0);
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
          <span className="text-foreground font-medium">Tiền thừa</span>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <SearchableSelect
            value={areaId}
            onValueChange={setAreaId}
            className="w-[200px]"
            placeholder="Chọn khu vực"
            options={[
              { value: "all", label: "Tất cả khu vực" },
              ...(areas as any[]).map((a) => ({ value: a.id, label: a.name })),
            ]}
          />

          <SearchableSelect
            value={buildingId}
            onValueChange={setBuildingId}
            className="w-[200px]"
            placeholder="Chọn tòa nhà"
            options={[
              { value: "all", label: "Tất cả tòa nhà" },
              ...buildings.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />

          <SearchableSelect
            value={roomId}
            onValueChange={setRoomId}
            className="w-[200px]"
            placeholder="Chọn phòng"
            options={[
              { value: "all", label: "Tất cả phòng" },
            ]}
          />

          <SearchableSelect
            value={bedId}
            onValueChange={setBedId}
            className="w-[200px]"
            placeholder="Chọn giường"
            options={[
              { value: "all", label: "Tất cả giường" },
            ]}
          />
        </div>

        <div className="text-base font-semibold">Tổng: {formatCurrency(total)}</div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mã</TableHead>
                <TableHead>Tòa nhà</TableHead>
                <TableHead>Căn hộ</TableHead>
                <TableHead>Giường</TableHead>
                <TableHead>Khách hàng</TableHead>
                <TableHead className="text-right">Số tiền thừa</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : pageRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    Không có dữ liệu nào để hiển thị
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((op: any) => (
                  <TableRow key={op.id}>
                    <TableCell>{op.invoice_number || op.id?.substring(0, 8) || "—"}</TableCell>
                    <TableCell>{op.rooms?.buildings?.name || "—"}</TableCell>
                    <TableCell>{op.rooms?.room_number || "—"}</TableCell>
                    <TableCell>—</TableCell>
                    <TableCell>{op.tenants?.full_name || "—"}</TableCell>
                    <TableCell className="text-right text-green-600 font-semibold">
                      {formatCurrency(op.overpaid_amount || 0)}
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
