import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Zap, Settings } from 'lucide-react';
import type { ContractServiceItem } from '@/components/contracts/detail/types';
import { formatCurrency } from './formatCurrency';

const getServiceTypeLabel = (type: string) => {
  const labels: Record<string, string> = {
    FIXED: 'Cố định',
    PER_PERSON: 'Theo người',
    PER_ROOM: 'Theo căn hộ',
    METER_READING: 'Theo công tơ',
  };
  return labels[type] || type;
};

const getServiceTypeIcon = (type: string) => {
  if (type === 'METER_READING') {
    return <Zap className="h-4 w-4 text-yellow-500" />;
  }
  return <Settings className="h-4 w-4 text-gray-500" />;
};

interface ContractServicesTabProps {
  services: ContractServiceItem[];
  loading: boolean;
}

/** Tab "Dịch vụ" (desktop) — tách nguyên văn từ ContractDetailView (Phase 10D). */
export function ContractServicesTab({ services, loading }: ContractServicesTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Dịch vụ đã đăng ký</CardTitle>
        <CardDescription>
          Danh sách các dịch vụ của hợp đồng
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center py-8 text-gray-500">
            Đang tải...
          </div>
        ) : services.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            Không có dịch vụ nào được đăng ký
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dịch vụ</TableHead>
                <TableHead>Loại</TableHead>
                <TableHead>Đơn vị</TableHead>
                <TableHead className="text-right">Đơn giá</TableHead>
                <TableHead className="text-right">Chỉ số ban đầu</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.map((cs) => (
                <TableRow key={cs.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {getServiceTypeIcon(cs.service.type)}
                      {cs.service.name}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {getServiceTypeLabel(cs.service.type)}
                    </Badge>
                  </TableCell>
                  <TableCell>{cs.service.unit || '-'}</TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCurrency(cs.unit_price)}
                  </TableCell>
                  <TableCell className="text-right">
                    {cs.initial_reading !== null ? cs.initial_reading : '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
