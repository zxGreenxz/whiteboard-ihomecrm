import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const data: DebtData[] = [];

      // Get debt for last 6 months
      for (let i = 5; i >= 0; i--) {
        const monthDate = subMonths(new Date(), i);
        const monthStart = startOfMonth(monthDate);
        const monthEnd = endOfMonth(monthDate);

        // Get unpaid/partial paid invoices with due date in this month
        const { data: invoices } = await supabase
          .from("invoices")
          .select("total_amount, paid_amount")
          .in("status", ["APPROVED", "PARTIAL_PAID"])
          .gte("due_date", monthStart.toISOString())
          .lte("due_date", monthEnd.toISOString());

        const debt = invoices?.reduce((sum, inv) => {
          const debtAmount = (inv.total_amount || 0) - (inv.paid_amount || 0);
          return sum + debtAmount;
        }, 0) || 0;

        data.push({
          month: format(monthDate, "MM/yyyy"),
          debt,
        });
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
