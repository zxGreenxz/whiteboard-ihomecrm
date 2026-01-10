import { DollarSign, TrendingUp, TrendingDown, Activity } from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { usePriceHistoryReport } from "@/hooks/useReports";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { vi } from "date-fns/locale";

export default function PriceHistoryReport() {
  const { data: priceHistory, isLoading } = usePriceHistoryReport();

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const roomsWithChanges = priceHistory?.filter(p => p.priceChanges > 0).length || 0;
  const totalPriceChanges = priceHistory?.reduce((sum, p) => sum + p.priceChanges, 0) || 0;
  const avgCurrentPrice = priceHistory && priceHistory.length > 0
    ? priceHistory.reduce((sum, p) => sum + (p.currentPrice || 0), 0) / priceHistory.length
    : 0;

  const stats = priceHistory && (
    <>
      <ReportCard
        title="Tổng số phòng"
        value={priceHistory.length}
        icon={DollarSign}
        description="Có lịch sử giá"
      />
      <ReportCard
        title="Đã thay đổi giá"
        value={roomsWithChanges}
        icon={Activity}
        description="Phòng có thay đổi"
      />
      <ReportCard
        title="Tổng thay đổi"
        value={totalPriceChanges}
        icon={TrendingUp}
        description="Số lần điều chỉnh"
      />
      <ReportCard
        title="Giá TB hiện tại"
        value={formatCurrency(avgCurrentPrice)}
        icon={DollarSign}
        description="Trung bình"
      />
    </>
  );

  const exportData = priceHistory?.flatMap(room =>
    room.history.map((h: any) => ({
      "Phòng": room.room,
      "Ngày bắt đầu": format(new Date(h.start_date), "dd/MM/yyyy", { locale: vi }),
      "Ngày kết thúc": format(new Date(h.end_date), "dd/MM/yyyy", { locale: vi }),
      "Giá thuê": h.rent,
      "Trạng thái": h.status,
    }))
  ) || [];

  return (
    <MainLayout>
    <ReportLayout
      title="Báo cáo Lịch sử giá"
      description="Lịch sử thay đổi giá thuê theo thời gian"
      icon={<Activity className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-lich-su-gia"
        />
      }
      stats={stats}
    >
      <Card>
        <CardHeader>
          <CardTitle>Lịch sử giá theo phòng</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : priceHistory && priceHistory.length > 0 ? (
            <div className="space-y-4">
              {priceHistory.map((room, index) => (
                <Card key={index}>
                  <CardHeader className="pb-3">
                    <div className="flex justify-between items-center">
                      <CardTitle className="text-base">{room.room}</CardTitle>
                      <div className="flex gap-2 items-center">
                        <span className="text-sm text-muted-foreground">
                          Giá hiện tại:
                        </span>
                        <span className="font-semibold text-lg">
                          {formatCurrency(room.currentPrice || 0)}
                        </span>
                        {room.priceChanges > 0 && (
                          <Badge variant="outline">
                            {room.priceChanges} thay đổi
                          </Badge>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Từ ngày</TableHead>
                            <TableHead>Đến ngày</TableHead>
                            <TableHead>Giá thuê</TableHead>
                            <TableHead>Thay đổi</TableHead>
                            <TableHead>Trạng thái</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {room.history.map((h: any, hIndex: number) => {
                            const prevPrice = hIndex < room.history.length - 1
                              ? room.history[hIndex + 1].rent
                              : null;
                            const priceDiff = prevPrice ? h.rent - prevPrice : 0;
                            const percentChange = prevPrice
                              ? ((h.rent - prevPrice) / prevPrice * 100).toFixed(1)
                              : 0;

                            return (
                              <TableRow key={hIndex}>
                                <TableCell>
                                  {format(new Date(h.start_date), "dd/MM/yyyy", { locale: vi })}
                                </TableCell>
                                <TableCell>
                                  {format(new Date(h.end_date), "dd/MM/yyyy", { locale: vi })}
                                </TableCell>
                                <TableCell className="font-semibold">
                                  {formatCurrency(h.rent)}
                                </TableCell>
                                <TableCell>
                                  {priceDiff !== 0 ? (
                                    <div className={`flex items-center gap-1 ${
                                      priceDiff > 0 ? "text-red-600" : "text-green-600"
                                    }`}>
                                      {priceDiff > 0 ? (
                                        <TrendingUp className="h-4 w-4" />
                                      ) : (
                                        <TrendingDown className="h-4 w-4" />
                                      )}
                                      <span className="text-sm font-medium">
                                        {formatCurrency(Math.abs(priceDiff))} ({percentChange}%)
                                      </span>
                                    </div>
                                  ) : (
                                    <span className="text-muted-foreground text-sm">-</span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <Badge variant={h.status === "ACTIVE" ? "default" : "secondary"}>
                                    {h.status === "ACTIVE" ? "Hiện tại" : "Đã kết thúc"}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Không có dữ liệu lịch sử giá
            </div>
          )}
        </CardContent>
      </Card>
    </ReportLayout>
    </MainLayout>
  );
}
