import { Plus } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { CurrencyInput } from '@/components/ui/currency-input';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { BuildingServiceFormData } from '@/types/building';

interface BuildingServicesSectionProps {
  services: BuildingServiceFormData[];
  onChange: (services: BuildingServiceFormData[]) => void;
  onAddService?: () => void;
}

/**
 * BuildingServicesSection
 * Table of building services with toggle (Sử dụng), service name, and unit price override.
 * Requirements: 2.5, 2.6, 2.7
 */
export default function BuildingServicesSection({
  services,
  onChange,
  onAddService,
}: BuildingServicesSectionProps) {
  const handleToggle = (index: number, checked: boolean) => {
    const updated = [...services];
    updated[index] = { ...updated[index], is_active: checked };
    onChange(updated);
  };

  const handlePriceChange = (index: number, value: number) => {
    const updated = [...services];
    updated[index] = {
      ...updated[index],
      unit_price_override: value || null,
    };
    onChange(updated);
  };

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat('vi-VN').format(price);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700 uppercase">Dịch vụ toà nhà</h3>
        {onAddService && (
          <Button type="button" variant="outline" size="sm" onClick={onAddService}>
            <Plus className="h-4 w-4 mr-1" />
            Thêm dịch vụ
          </Button>
        )}
      </div>

      {services.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          Chưa có dịch vụ nào. Hãy thêm dịch vụ trong mục Dịch vụ trước.
        </p>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="w-[80px] text-center">Sử dụng</TableHead>
                <TableHead>Tên dịch vụ</TableHead>
                <TableHead className="w-[200px]">Đơn giá</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.map((service, index) => (
                <TableRow key={service.service_id}>
                  <TableCell className="text-center">
                    <Switch
                      checked={service.is_active}
                      onCheckedChange={(checked) => handleToggle(index, checked)}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{service.service_name}</TableCell>
                  <TableCell>
                    <CurrencyInput
                      placeholder={formatPrice(service.default_unit_price)}
                      value={service.unit_price_override}
                      onChange={(v) => handlePriceChange(index, v)}
                      className="h-8"
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
