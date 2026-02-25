import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form';
import { buildingSchema } from '@/lib/buildingValidation';
import type { BuildingFormData, BuildingServiceFormData } from '@/types/building';
import { useServices } from '@/hooks/useServices';
import { useBuildingServices } from '@/hooks/useBuildingServices';
import BuildingAddressSection from './BuildingAddressSection';
import BuildingServicesSection from './BuildingServicesSection';

interface BuildingFormProps {
  defaultValues?: Partial<BuildingFormData>;
  buildingId?: string;
  onSubmit: (data: BuildingFormData, services: BuildingServiceFormData[]) => void;
  isSubmitting: boolean;
  onCancel?: () => void;
}

/**
 * BuildingForm
 * Full-page form for creating/editing buildings.
 * Sections: Title, Thông tin cơ bản, Thông tin địa chỉ, Dịch vụ toà nhà, Footer buttons.
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 2.9, 2.10, 2.11
 */
export default function BuildingForm({
  defaultValues,
  buildingId,
  onSubmit,
  isSubmitting,
  onCancel,
}: BuildingFormProps) {
  const form = useForm<BuildingFormData>({
    resolver: zodResolver(buildingSchema),
    defaultValues: {
      name: '',
      code: '',
      province: '',
      district: '',
      ward: '',
      street_address: '',
      area_id: '',
      status: 'ACTIVE',
      ...defaultValues,
    },
  });

  // Services state
  const [buildingServices, setBuildingServices] = useState<BuildingServiceFormData[]>([]);

  // Load all user services
  const { data: allServices } = useServices();

  // Load existing building services (edit mode)
  const { data: existingBuildingServices } = useBuildingServices(buildingId || '');

  // Initialize services list from all services + existing building services
  useEffect(() => {
    if (!allServices) return;

    const servicesList: BuildingServiceFormData[] = allServices.map((svc) => {
      // Check if this service already has a building_service record
      const existing = existingBuildingServices?.find(
        (bs) => bs.service_id === svc.id
      );

      return {
        service_id: svc.id,
        service_name: svc.name,
        is_active: existing ? existing.is_active : false,
        unit_price_override: existing?.unit_price_override ?? null,
        default_unit_price: svc.unit_price ?? 0,
      };
    });

    setBuildingServices(servicesList);
  }, [allServices, existingBuildingServices]);

  const handleFormSubmit = (data: BuildingFormData) => {
    onSubmit(data, buildingServices);
  };

  const status = form.watch('status');

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleFormSubmit)} className="space-y-6">
        {/* Title bar */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold uppercase">Toà nhà</h2>
          {onCancel && (
            <Button type="button" variant="ghost" size="icon" onClick={onCancel}>
              <X className="h-5 w-5" />
            </Button>
          )}
        </div>

        {/* Thông tin cơ bản */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700 uppercase">Thông tin cơ bản</h3>
              <div className="flex items-center gap-2">
                <Label htmlFor="status-toggle" className="text-sm">
                  Hoạt động
                </Label>
                <Switch
                  id="status-toggle"
                  checked={status === 'ACTIVE'}
                  onCheckedChange={(checked) =>
                    form.setValue('status', checked ? 'ACTIVE' : 'INACTIVE')
                  }
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Tên toà nhà <span className="text-red-500">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="Nhập tên toà nhà" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tên viết tắt/Mã toà</FormLabel>
                    <FormControl>
                      <Input placeholder="Nhập mã toà nhà" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </CardContent>
        </Card>

        {/* Thông tin địa chỉ */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <h3 className="text-sm font-semibold text-gray-700 uppercase">Thông tin địa chỉ</h3>
            <BuildingAddressSection
              control={form.control}
              setValue={form.setValue}
              watch={form.watch}
            />
          </CardContent>
        </Card>

        {/* Dịch vụ toà nhà */}
        <Card>
          <CardContent className="pt-6">
            <BuildingServicesSection
              services={buildingServices}
              onChange={setBuildingServices}
            />
          </CardContent>
        </Card>

        {/* Footer buttons */}
        <div className="flex justify-end gap-3">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Huỷ bỏ
            </Button>
          )}
          <Button
            type="submit"
            disabled={isSubmitting}
            className="bg-green-600 hover:bg-green-700"
          >
            {isSubmitting ? 'Đang lưu...' : 'Lưu'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
