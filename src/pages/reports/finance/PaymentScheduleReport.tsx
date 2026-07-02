import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import { ChevronRight } from "lucide-react";
import { usePaymentScheduleReport } from "@/hooks/useReports";
import { usePersistedState } from "@/hooks/usePersistedState";
import { BuildingFilterSelect } from "@/components/buildings/BuildingFilterSelect";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { format } from "date-fns";
import { vi } from "date-fns/locale";

export default function PaymentScheduleReport() {
  // Lọc 1 toà (BuildingFilterSelect, state giữ shape mảng 0/1 phần tử). [] = tất cả.
  // Lọc client-side theo buildings.id trên invoices đã fetch, TRƯỚC khi gộp phòng.
  const [buildingIds, setBuildingIds] = usePersistedState<string[]>("flt:rpt-payment-schedule:buildingIds", []);
  const [roomId, setRoomId] = usePersistedState<string>("flt:rpt-payment-schedule:roomId", "all");
  const [startDate, setStartDate] = usePersistedState<string>("flt:rpt-payment-schedule:startDate", "");
  const [endDate, setEndDate] = usePersistedState<string>("flt:rpt-payment-schedule:endDate", "");
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);

  const { data: invoices = [], isLoading } = usePaymentScheduleReport(365);

  // Group invoices by room → "đã lên hóa đơn đến ngày" = latest billing_period_end per room
  const rows = useMemo(() => {
    let list = invoices as any[];
    if (buildingIds.length > 0) {
      list = list.filter((inv) => buildingIds.includes(inv.rooms?.buildings?.id));
    }

    const byRoom = new Map<string, any>();
    list.forEach((inv) => {
      const roomKey = inv.rooms?.room_number ? `${inv.rooms?.buildings?.name || ""}|${inv.rooms?.room_number}` : inv.id;
      const billedThrough = inv.billing_period_end || inv.due_date;
      if (!byRoom.has(roomKey)) {
        byRoom.set(roomKey, {
          building: inv.rooms?.buildings?.name || "—",
          room: inv.rooms?.room_number || "—",
          tenant: inv.tenants?.full_name || "—",
          billedThrough,
        });
      } else {
        const r = byRoom.get(roomKey);
        if (new Date(billedThrough) > new Date(r.billedThrough)) {
          r.billedThrough = billedThrough;
        }
      }
    });

    let arr = Array.from(byRoom.values());

    if (startDate) arr = arr.filter((r) => new Date(r.billedThrough) >= new Date(startDate));
    if (endDate) arr = arr.filter((r) => new Date(r.billedThrough) <= new Date(endDate));

    return arr.sort((a, b) =>
      new Date(b.billedThrough).getTime() - new Date(a.billedThrough).getTime()
    );
  }, [invoices, buildingIds, startDate, endDate]);

  const totalCount = rows.length;
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/reports/finance" className="hover:text-primary">
            Báo cáo tài chính
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Lịch thanh toán</span>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <BuildingFilterSelect
            value={buildingIds}
            onChange={(ids) => {
              setBuildingIds(ids);
              setPage(1);
            }}
            className="w-[260px]"
            placeholder="Tất cả toà nhà"
          />

          <SearchableSelect
            value={roomId}
            onValueChange={setRoomId}
            className="w-[180px]"
            placeholder="Chọn phòng"
            options={[
              { value: "all", label: "Tất cả phòng" },
            ]}
          />

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Chọn ngày</span>
            <DateInput
              value={startDate}
              onChange={setStartDate}
              className="w-[180px]"
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Ngày kết thúc</span>
            <DateInput
              value={endDate}
              onChange={setEndDate}
              className="w-[180px]"
            />
          </div>
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tòa nhà</TableHead>
                <TableHead>Căn hộ</TableHead>
                <TableHead>Khách hàng</TableHead>
                <TableHead>Đã lên hóa đơn đến ngày</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={4}><Skeleton className="h-6 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : pageRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                    Không có dữ liệu nào để hiển thị
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((r, idx) => (
                  <TableRow key={idx}>
                    <TableCell>{r.building}</TableCell>
                    <TableCell>{r.room}</TableCell>
                    <TableCell>{r.tenant}</TableCell>
                    <TableCell>
                      {r.billedThrough
                        ? format(new Date(r.billedThrough), "dd/MM/yyyy", { locale: vi })
                        : "—"}
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
