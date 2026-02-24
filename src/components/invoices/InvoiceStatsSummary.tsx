import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useInvoiceStatistics, type InvoiceStatisticsFilters } from '@/hooks/useInvoices';
import { DollarSign, FileText, TrendingDown } from 'lucide-react';

interface InvoiceStatsSummaryProps {
  filters?: InvoiceStatisticsFilters;
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);

const InvoiceStatsSummary = ({ filters }: InvoiceStatsSummaryProps) => {
  const { data: stats, isLoading } = useInvoiceStatistics(filters);

  const cards = [
    {
      label: 'Tổng đã thu',
      value: formatCurrency(stats?.total_paid ?? 0),
      icon: DollarSign,
      color: 'text-green-600',
      bg: 'bg-green-50',
    },
    {
      label: 'Tổng phải thu',
      value: formatCurrency(stats?.total_remaining ?? 0),
      icon: TrendingDown,
      color: 'text-orange-600',
      bg: 'bg-orange-50',
    },
    {
      label: 'Tổng số hoá đơn',
      value: String(stats?.total_count ?? 0),
      icon: FileText,
      color: 'text-blue-600',
      bg: 'bg-blue-50',
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent className="flex items-center gap-4 p-4">
            <div className={`h-10 w-10 rounded-lg ${card.bg} flex items-center justify-center`}>
              <card.icon className={`h-5 w-5 ${card.color}`} />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{card.label}</p>
              {isLoading ? (
                <Skeleton className="h-7 w-28 mt-1" />
              ) : (
                <p className={`text-xl font-bold ${card.color}`}>{card.value}</p>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};

export default InvoiceStatsSummary;
