import { useState } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { FileText, Clock, AlertTriangle, CheckCircle2 } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { useExpiringContractsReport } from "@/hooks/useReports";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { format } from "date-fns";
import { vi } from "date-fns/locale";

export default function ExpiringContractsReport() {
  const [daysFilter, setDaysFilter] = useState(30);
  const { data: contracts, isLoading } = useExpiringContractsReport(daysFilter);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const stats = contracts && (
    <>
      <ReportCard
        title="Tổng hợp đồng sắp hết hạn"
        value={contracts.length}
        icon={FileText}
        description={`Trong ${daysFilter} ngày tới`}
      />
      <ReportCard
        title="Hết hạn trong 7 ngày"
        value={contracts.filter(c => c.days_left <= 7).length}
        icon={AlertTriangle}
        description="Cần liên hệ khẩn cấp"
      />
      <ReportCard
        title="Hết hạn 8-15 ngày"
        value={contracts.filter(c => c.days_left > 7 && c.days_left <= 15).length}
        icon={Clock}
        description="Cần chuẩn bị gia hạn"
      />
      <ReportCard
        title="Hết hạn 16-30 ngày"
        value={contracts.filter(c => c.days_left > 15 && c.days_left <= 30).length}
        icon={CheckCircle2}
        description="Thời gian đàm phán"
      />
    </>
  );

  const exportData = contracts?.map(contract => ({
    "Mã HĐ": contract.contract_number,
    "Khách hàng": contract.tenants?.full_name || "N/A",
    "Điện thoại": contract.tenants?.phone || "N/A",
    "Phòng": `${contract.rooms?.buildings?.name} - ${contract.rooms?.room_number}`,
    "Ngày hết hạn": format(new Date(contract.end_date), "dd/MM/yyyy", { locale: vi }),
    "Còn lại (ngày)": contract.days_left,
    "Giá thuê": contract.monthly_rent,
    "Trạng thái": contract.status,
  })) || [];

  const getUrgencyBadge = (daysLeft: number) => {
    if (daysLeft <= 7) {
      return <Badge variant="destructive">Khẩn cấp</Badge>;
    } else if (daysLeft <= 15) {
      return <Badge variant="default">Quan trọng</Badge>;
    } else {
      return <Badge variant="secondary">Bình thường</Badge>;
    }
  };

  return (
    <MainLayout>
    <ReportLayout
      title="Báo cáo Hợp đồng sắp hết hạn"
      description="Danh sách hợp đồng sẽ hết hạn trong thời gian tới"
      icon={<FileText className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-hop-dong-sap-het-han"
        />
      }
      stats={stats}
    >
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle>Danh sách hợp đồng sắp hết hạn</CardTitle>
            <Tabs value={daysFilter.toString()} onValueChange={(v) => setDaysFilter(Number(v))}>
              <TabsList>
                <TabsTrigger value="7">7 ngày</TabsTrigger>
                <TabsTrigger value="15">15 ngày</TabsTrigger>
                <TabsTrigger value="30">30 ngày</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map(i => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : contracts && contracts.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mức độ</TableHead>
                    <TableHead>Mã HĐ</TableHead>
                    <TableHead>Khách hàng</TableHead>
                    <TableHead>Liên hệ</TableHead>
                    <TableHead>Phòng</TableHead>
                    <TableHead>Ngày hết hạn</TableHead>
                    <TableHead>Còn lại</TableHead>
                    <TableHead>Giá thuê</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contracts.map((contract) => (
                    <TableRow key={contract.id}>
                      <TableCell>
                        {getUrgencyBadge(contract.days_left)}
                      </TableCell>
                      <TableCell className="font-medium">
                        {contract.contract_number}
                      </TableCell>
                      <TableCell>{contract.tenants?.full_name || "N/A"}</TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div>{contract.tenants?.phone || "-"}</div>
                          <div className="text-muted-foreground">{contract.tenants?.email || "-"}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div className="font-medium">{contract.rooms?.buildings?.name}</div>
                          <div className="text-muted-foreground">Phòng {contract.rooms?.room_number}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {format(new Date(contract.end_date), "dd/MM/yyyy", { locale: vi })}
                      </TableCell>
                      <TableCell>
                        <span className={
                          contract.days_left <= 7
                            ? "text-red-600 font-semibold"
                            : contract.days_left <= 15
                            ? "text-yellow-600 font-medium"
                            : "text-green-600"
                        }>
                          {contract.days_left} ngày
                        </span>
                      </TableCell>
                      <TableCell>{formatCurrency(contract.monthly_rent)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Không có hợp đồng nào sắp hết hạn trong {daysFilter} ngày tới
            </div>
          )}
        </CardContent>
      </Card>
    </ReportLayout>
    </MainLayout>
  );
}
