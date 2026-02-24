import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useInvoiceStatistics, type InvoiceStatisticsFilters } from '@/hooks/useInvoices';
import {
  DollarSign,
  Home,
  Receipt,
  CreditCard,
  RefreshCcw,
  Banknote,
  TrendingDown,
} from 'lucide-react';

interface InvoiceStatsSummaryProps {
  filters?: InvoiceStatisticsFilters;
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);

interface StatCard {
  label: string;
  value: string;
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  valueColor: string;
}

const InvoiceStatsSummary = ({ filters }: InvoiceStatsSummaryProps) => {
  const { data: stats, isLoading } = useInvoiceStatistics(filters);

  // TODO: API only returns total_paid, total_remaining, total_count
  // The following values need backend support: total_amount, rent_amount, service_amount, total_collected, total_refunded
  const totalPaid = stats?.total_paid ?? 0;
  const totalRemaining = stats?.total_remaining ?? 0;

  const row1: StatCard[] = [
    {
      label: 'Tổng tiền',
      value: formatCurrency(0), // TODO: needs total_amount from API
      icon: DollarSign,
      iconColor: 'text-green-600',
      iconBg: 'bg-green-100',
      valueColor: 'text-green-600',
    },
    {
      label: 'Tiền nhà',
      value: formatCurrency(0), // TODO: needs rent_amount from API
      icon: Home,
      iconColor: 'text-blue-600',
      iconBg: 'bg-blue-100',
      valueColor: 'text-blue-600',
    },
    {
      label: 'Tiền dịch vụ',
      value: formatCurrency(0), // TODO: needs service_amount from API
      icon: Receipt,
      iconColor: 'text-purple-600',
      iconBg: 'bg-purple-100',
      valueColor: 'text-purple-600',
    },
    {
      label: 'Tổng tiền thu',
      value: formatCurrency(0), // TODO: needs total_collected from API
      icon: CreditCard,
      iconColor: 'text-green-600',
      iconBg: 'bg-green-100',
      valueColor: 'text-green-600',
    },
  ];

  const row2: StatCard[] = [
    {
      label: 'Tổng tiền hoàn',
      value: formatCurrency(0), // TODO: needs total_refunded from API
      icon: RefreshCcw,
      iconColor: 'text-red-600',
      iconBg: 'bg-red-100',
      valueColor: 'text-red-600',
    },
    {
      label: 'Đã thu',
      value: formatCurrency(totalPaid),
      icon: Banknote,
      iconColor: 'text-blue-600',
      iconBg: 'bg-blue-100',
      valueColor: 'text-blue-600',
    },
    {
      label: 'Phải thu',
      value: formatCurrency(totalRemaining),
      icon: TrendingDown,
      iconColor: 'text-orange-600',
      iconBg: 'bg-orange-100',
      valueColor: 'text-orange-600',
    },
  ];

  const renderCard = (card: StatCard) => (
    <Card key={card.label} className="shadow-sm">
      <CardContent className="flex items-center gap-3 p-3">
        <div className={`h-11 w-11 rounded-full ${card.iconBg} flex items-center justify-center shrink-0`}>
          <card.icon className={`h-5 w-5 ${card.iconColor}`} />
        </div>
        <div className="min-w-0">
          {isLoading ? (
            <Skeleton className="h-6 w-24 mb-1" />
          ) : (
            <p className={`text-lg font-bold ${card.valueColor} truncate`}>{card.value}</p>
          )}
          <p className="text-xs text-muted-foreground">{card.label}</p>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-3 mb-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {row1.map(renderCard)}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {row2.map(renderCard)}
      </div>
    </div>
  );
};

export default InvoiceStatsSummary;
