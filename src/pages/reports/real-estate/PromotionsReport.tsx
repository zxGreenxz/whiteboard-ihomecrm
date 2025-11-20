import { Tag, TrendingDown, Gift, DollarSign } from "lucide-react";
import { ReportLayout } from "@/components/reports/ReportLayout";
import { ReportCard } from "@/components/reports/ReportCard";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { usePromotionsReport } from "@/hooks/useReports";
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

export default function PromotionsReport() {
  const { data: promotions, isLoading } = usePromotionsReport();

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const totalSavings = promotions?.reduce((sum, p) => sum + (p.savings || 0), 0) || 0;
  const activePromotions = promotions?.filter(p => p.status === "ACTIVE").length || 0;

  const stats = promotions && (
    <>
      <ReportCard
        title="Tổng khuyến mại"
        value={promotions.length}
        icon={Tag}
        description="Tất cả khuyến mại"
      />
      <ReportCard
        title="Đang hoạt động"
        value={activePromotions}
        icon={Gift}
        description="Khuyến mại hiện hành"
      />
      <ReportCard
        title="Tổng tiết kiệm"
        value={formatCurrency(totalSavings)}
        icon={TrendingDown}
        description="Tổng giá trị giảm giá"
      />
      <ReportCard
        title="TB mỗi hợp đồng"
        value={formatCurrency(promotions.length > 0 ? totalSavings / promotions.length : 0)}
        icon={DollarSign}
        description="Giảm giá trung bình"
      />
    </>
  );

  const exportData = promotions?.map(promo => ({
    "Mã HĐ": promo.contract_number,
    "Khách hàng": promo.tenants?.full_name || "N/A",
    "Phòng": `${promo.rooms?.buildings?.name} - ${promo.rooms?.room_number}`,
    "Tên khuyến mại": promo.promotion_name || "N/A",
    "Loại giảm giá": promo.discount_type || "N/A",
    "Giá gốc": promo.monthly_rent,
    "Giảm giá": promo.discount_amount,
    "Giá thực": promo.effective_rent,
    "Trạng thái": promo.status,
  })) || [];

  return (
    <ReportLayout
      title="Báo cáo Khuyến mại"
      description="Danh sách các chương trình khuyến mại và ưu đãi"
      icon={<Tag className="h-8 w-8" />}
      actions={
        <ExportButtons
          data={exportData}
          filename="bao-cao-khuyen-mai"
        />
      }
      stats={stats}
    >
      <Card>
        <CardHeader>
          <CardTitle>Danh sách khuyến mại</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : promotions && promotions.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mã HĐ</TableHead>
                    <TableHead>Khách hàng</TableHead>
                    <TableHead>Phòng</TableHead>
                    <TableHead>Tên khuyến mại</TableHead>
                    <TableHead>Giá gốc</TableHead>
                    <TableHead>Giảm giá</TableHead>
                    <TableHead>Giá thực</TableHead>
                    <TableHead>Trạng thái</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {promotions.map((promo) => (
                    <TableRow key={promo.id}>
                      <TableCell className="font-medium">
                        {promo.contract_number || promo.id.slice(0, 8)}
                      </TableCell>
                      <TableCell>{promo.tenants?.full_name || "N/A"}</TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div className="font-medium">{promo.rooms?.buildings?.name}</div>
                          <div className="text-muted-foreground">Phòng {promo.rooms?.room_number}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {promo.promotion_name || <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell>{formatCurrency(promo.monthly_rent)}</TableCell>
                      <TableCell className="text-green-600 font-semibold">
                        -{formatCurrency(promo.savings)}
                      </TableCell>
                      <TableCell className="font-semibold">
                        {formatCurrency(promo.effective_rent)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={promo.status === "ACTIVE" ? "default" : "secondary"}>
                          {promo.status === "ACTIVE" ? "Đang áp dụng" : "Đã kết thúc"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Không có khuyến mại nào
            </div>
          )}
        </CardContent>
      </Card>
    </ReportLayout>
  );
}
