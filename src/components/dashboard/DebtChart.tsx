import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { formatCurrency } from "@/lib/utils";
import { subMonths, startOfMonth, endOfMonth, format } from "date-fns";

interface DebtData {
  month: string;
  debt: number;
}

export function DebtChart() {
  const { data: debtData = [], isLoading } = useQuery({
    queryKey: ["debt-chart"],
    queryFn: async (): Promise<DebtData[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      // 1 QUERY cho cả 6 tháng rồi bucket theo tháng ở client — bản cũ chạy
      // vòng lặp 6 query TUẦN TỰ (mỗi tháng 1 round-trip, cùng khuôn N+1 mà
      // useRevenueChart đã sửa). due_date là cột DATE → so sánh bằng chuỗi
      // ngày cục bộ 'yyyy-MM-dd' cho ranh giới tháng chuẩn (bản cũ gửi ISO-UTC
      // bị cast lệch 1 ngày ở biên tháng).
      const rangeStart = format(startOfMonth(subMonths(new Date(), 5)), "yyyy-MM-dd");
      const rangeEnd = format(endOfMonth(new Date()), "yyyy-MM-dd");

      const { data: invoices } = await supabase
        .from("invoices")
        .select("total_amount, paid_amount, due_date")
        .in("status", ["APPROVED", "PARTIAL_PAID"])
        .gte("due_date", rangeStart)
        .lte("due_date", rangeEnd);

      // Khởi tạo đủ 6 tháng (tháng không có nợ vẫn hiện 0).
      const byMonth = new Map<string, number>();
      const data: DebtData[] = [];
      for (let i = 5; i >= 0; i--) {
        const key = format(subMonths(new Date(), i), "MM/yyyy");
        byMonth.set(key, 0);
        data.push({ month: key, debt: 0 });
      }
      for (const inv of invoices || []) {
        const d = new Date((inv as any).due_date);
        if (Number.isNaN(d.getTime())) continue;
        const key = format(d, "MM/yyyy");
        if (byMonth.has(key)) {
          const debtAmount = (inv.total_amount || 0) - (inv.paid_amount || 0);
          byMonth.set(key, (byMonth.get(key) || 0) + debtAmount);
        }
      }
      for (const row of data) {
        row.debt = byMonth.get(row.month) || 0;
      }

      return data;
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Công nợ theo tháng</CardTitle>
          <CardDescription>6 tháng gần nhất</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[300px] flex items-center justify-center">
            <p className="text-muted-foreground">Đang tải...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Color based on debt level
  const getBarColor = (debt: number) => {
    if (debt > 50000000) return "#ef4444"; // red - high debt
    if (debt > 20000000) return "#f59e0b"; // orange - medium debt
    if (debt > 0) return "#fbbf24"; // yellow - low debt
    return "#10b981"; // green - no debt
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Công nợ theo tháng</CardTitle>
        <CardDescription>Theo hạn thanh toán - 6 tháng gần nhất</CardDescription>
      </CardHeader>
      <CardContent>
        {debtData.length === 0 ? (
          <div className="h-[300px] flex items-center justify-center">
            <p className="text-muted-foreground">Chưa có dữ liệu</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={debtData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 12 }}
              />
              <YAxis
                tick={{ fontSize: 12 }}
                tickFormatter={(value) => `${(value / 1000000).toFixed(0)}M`}
              />
              <Tooltip
                formatter={(value: number) => formatCurrency(value)}
                labelFormatter={(label) => `Tháng ${label}`}
              />
              <Bar dataKey="debt" name="Công nợ" radius={[8, 8, 0, 0]}>
                {debtData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={getBarColor(entry.debt)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
