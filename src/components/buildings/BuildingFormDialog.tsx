import { useEffect, useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

import { buildingSchema } from '@/lib/buildingValidation';
import type { BuildingFormData, BuildingServiceFormData, BuildingWithRelations, CommissionTier } from '@/types/building';
import { DEFAULT_COMMISSION_TIERS } from '@/types/building';
import { useCreateBuilding, useUpdateBuilding } from '@/hooks/useBuildings';
import { useBuildingServices, useUpsertBuildingServices } from '@/hooks/useBuildingServices';
import { useServices } from '@/hooks/useServices';
import { useDocumentTemplatesByType } from '@/hooks/useDocumentTemplates';
import { useAccounts } from '@/hooks/useAccounts';
import { useMyContext } from '@/hooks/useMyContext';
import BuildingAddressSection from './BuildingAddressSection';
import BuildingGeoSection from './BuildingGeoSection';
import BuildingServicesSection from './BuildingServicesSection';
import { CommissionTiersField } from './CommissionTiersField';

interface BuildingFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  building?: BuildingWithRelations;
}

export default function BuildingFormDialog({
  open,
  onOpenChange,
  building,
}: BuildingFormDialogProps) {
  const isEditMode = !!building;

  // Hooks
  const createBuilding = useCreateBuilding();
  const updateBuilding = useUpdateBuilding();
  const upsertServices = useUpsertBuildingServices();

  // Services
  const { data: allServices } = useServices();
  const { data: existingBuildingServices } = useBuildingServices(building?.id || '');
  const [buildingServices, setBuildingServices] = useState<BuildingServiceFormData[]>([]);

  // Document templates for Cấu hình section
  const { data: invoiceTemplates = [] } = useDocumentTemplatesByType('invoice');
  const { data: leaseTemplates = [] } = useDocumentTemplatesByType('lease_contract');

  // Danh sách sổ quỹ cho 2 dropdown "Sổ quỹ TT/TK mặc định" — chỉ super admin
  // được xem & chỉnh các field này (mặc định áp dụng cho mọi user khi thanh toán).
  const { data: accounts = [] } = useAccounts();
  const { data: ctx } = useMyContext();
  const isSuper = !!ctx?.isSuper;

  // Form
  const form = useForm<BuildingFormData>({
    resolver: zodResolver(buildingSchema),
    defaultValues: {
      name: '',
      code: '',
      province: '',
      district: '',
      ward: '',
      street_address: '',
      status: 'ACTIVE',
      has_elevator: false,
      commission_tiers: DEFAULT_COMMISSION_TIERS,
    },
  });

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      if (building) {
        form.reset({
          name: building.name,
          code: building.code ?? '',
          province: building.province,
          district: building.district,
          ward: building.ward,
          street_address: building.street_address ?? '',
          latitude:
            (building as { latitude?: number | null }).latitude ?? null,
          longitude:
            (building as { longitude?: number | null }).longitude ?? null,
          status: building.status,
          has_elevator:
            (building as { has_elevator?: boolean }).has_elevator ?? false,
          contract_template_id:
            (building as { contract_template_id?: string | null })
              .contract_template_id ?? null,
          invoice_template_id:
            (building as { invoice_template_id?: string | null })
              .invoice_template_id ?? null,
          default_account_id_tt:
            (building as { default_account_id_tt?: string | null })
              .default_account_id_tt ?? null,
          default_account_id_tk:
            (building as { default_account_id_tk?: string | null })
              .default_account_id_tk ?? null,
          commission_tiers:
            ((building as { commission_tiers?: CommissionTier[] })
              .commission_tiers as CommissionTier[]) ?? DEFAULT_COMMISSION_TIERS,
        });
      } else {
        form.reset({
          name: '',
          code: '',
          province: '',
          district: '',
          ward: '',
          street_address: '',
          latitude: null,
          longitude: null,
          status: 'ACTIVE',
          has_elevator: false,
          contract_template_id: null,
          invoice_template_id: null,
          default_account_id_tt: null,
          default_account_id_tk: null,
          commission_tiers: DEFAULT_COMMISSION_TIERS,
        });
      }
    }
  }, [open, building, form]);

  // Initialize services list from all services + existing building services
  useEffect(() => {
    if (!allServices) return;

    const servicesList: BuildingServiceFormData[] = allServices.map((svc: any) => {
      const existing = existingBuildingServices?.find(
        (bs: any) => bs.service_id === svc.id
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

  const onSubmit = async (data: BuildingFormData) => {
    const servicesPayload = buildingServices.map((s) => ({
      service_id: s.service_id,
      is_active: s.is_active,
      unit_price_override: s.unit_price_override,
    }));

    try {
      if (isEditMode && building) {
        await updateBuilding.mutateAsync({
          id: building.id,
          updates: {
            name: data.name,
            code: data.code || null,
            province: data.province,
            district: data.district,
            ward: data.ward,
            street_address: data.street_address,
            latitude: data.latitude ?? null,
            longitude: data.longitude ?? null,
            status: data.status,
            has_elevator: data.has_elevator ?? false,
            contract_template_id: data.contract_template_id ?? null,
            invoice_template_id: data.invoice_template_id ?? null,
            default_account_id_tt: (data.default_account_id_tt ?? null) as any,
            default_account_id_tk: (data.default_account_id_tk ?? null) as any,
            commission_tiers: (data.commission_tiers ?? DEFAULT_COMMISSION_TIERS) as any,
          },
        });
        await upsertServices.mutateAsync({
          buildingId: building.id,
          services: servicesPayload,
        });
        toast.success('Dữ liệu đã được CẬP NHẬT thành công');
      } else {
        const newBuilding = await createBuilding.mutateAsync({
          name: data.name,
          code: data.code || null,
          province: data.province,
          district: data.district,
          ward: data.ward,
          street_address: data.street_address,
          latitude: data.latitude ?? null,
          longitude: data.longitude ?? null,
          status: data.status,
          has_elevator: data.has_elevator ?? false,
          contract_template_id: data.contract_template_id ?? null,
          invoice_template_id: data.invoice_template_id ?? null,
          default_account_id_tt: (data.default_account_id_tt ?? null) as any,
          default_account_id_tk: (data.default_account_id_tk ?? null) as any,
          commission_tiers: (data.commission_tiers ?? DEFAULT_COMMISSION_TIERS) as any,
        });
        await upsertServices.mutateAsync({
          buildingId: newBuilding.id,
          services: servicesPayload,
        });
        toast.success('Dữ liệu đã được TẠO thành công');
      }
      onOpenChange(false);
    } catch (error: any) {
      // Errors handled by hook toasts
    }
  };

  const isPending =
    createBuilding.isPending || updateBuilding.isPending || upsertServices.isPending;

  const status = form.watch('status');
  const hasElevator = form.watch('has_elevator');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] p-0">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="text-green-600 text-lg font-bold uppercase">
            Toà nhà
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isEditMode ? 'Cập nhật thông tin toà nhà' : 'Thêm toà nhà mới'}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(90vh-80px)] px-6 pb-6">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Section 1: Thông tin cơ bản */}
              <Card>
                <CardContent className="pt-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-700 uppercase">
                      Thông tin cơ bản
                    </h3>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="building-status-toggle" className="text-sm">
                        Hoạt động
                      </Label>
                      <Switch
                        id="building-status-toggle"
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
                            <Input
                              placeholder="VD: 1392qt, QT, 1392"
                              {...field}
                              value={field.value ?? ''}
                            />
                          </FormControl>
                          <p className="text-xs text-muted-foreground">
                            Có thể nhập nhiều mã/viết tắt cách nhau bởi dấu phẩy. Khi tạo công việc nhanh, gõ bất kỳ mã nào trong danh sách đều khớp toà nhà này.
                          </p>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Section 2: Thông tin địa chỉ */}
              <Card>
                <CardContent className="pt-6 space-y-4">
                  <h3 className="text-sm font-semibold text-gray-700 uppercase">
                    Thông tin địa chỉ
                  </h3>
                  <BuildingAddressSection
                    control={form.control}
                    setValue={form.setValue}
                    watch={form.watch}
                  />
                  <BuildingGeoSection setValue={form.setValue} watch={form.watch} />
                </CardContent>
              </Card>

              {/* Section 3: Dịch vụ toà nhà */}
              <Card>
                <CardContent className="pt-6">
                  <BuildingServicesSection
                    services={buildingServices}
                    onChange={setBuildingServices}
                  />
                </CardContent>
              </Card>

              {/* Section 4: Cấu hình */}
              <Card>
                <CardContent className="pt-6 space-y-4">
                  <h3 className="text-sm font-semibold text-gray-700 uppercase">
                    Cấu hình
                  </h3>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <Label htmlFor="building-elevator-toggle" className="text-sm">
                        Có thang máy
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Bật để cảnh báo khi toà thiếu phiếu bảo trì thang máy (ở báo cáo Phân bổ lợi nhuận).
                      </p>
                    </div>
                    <Switch
                      id="building-elevator-toggle"
                      checked={!!hasElevator}
                      onCheckedChange={(checked) =>
                        form.setValue('has_elevator', checked)
                      }
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {isSuper && (
                      <FormField
                        control={form.control}
                        name="default_account_id_tt"
                        render={({ field }) => (
                          <FormItem className="space-y-2">
                            <FormLabel className="text-sm">
                              Sổ quỹ TT mặc định
                            </FormLabel>
                            <Select
                              value={field.value ?? '__none__'}
                              onValueChange={(v) =>
                                field.onChange(v === '__none__' ? null : v)
                              }
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder="Chọn sổ quỹ TT" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="__none__">-- Không chọn --</SelectItem>
                                {(accounts || []).map((a: any) => (
                                  <SelectItem key={a.id} value={a.id}>
                                    {a.name}
                                    {a.bank_name ? ` — ${a.bank_name}` : ''}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                              Khi khách thanh toán hoá đơn phòng bằng TT, mặc định ghi vào sổ này (mọi user).
                            </p>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                    {isSuper && (
                      <FormField
                        control={form.control}
                        name="default_account_id_tk"
                        render={({ field }) => (
                          <FormItem className="space-y-2">
                            <FormLabel className="text-sm">
                              Sổ quỹ TK mặc định
                            </FormLabel>
                            <Select
                              value={field.value ?? '__none__'}
                              onValueChange={(v) =>
                                field.onChange(v === '__none__' ? null : v)
                              }
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder="Chọn sổ quỹ TK" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="__none__">-- Không chọn --</SelectItem>
                                {(accounts || []).map((a: any) => (
                                  <SelectItem key={a.id} value={a.id}>
                                    {a.name}
                                    {a.bank_name ? ` — ${a.bank_name}` : ''}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">
                              Khi khách thanh toán hoá đơn phòng bằng TK (chuyển khoản), mặc định ghi vào sổ này (mọi user).
                            </p>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                    <FormField
                      control={form.control}
                      name="invoice_template_id"
                      render={({ field }) => (
                        <FormItem className="space-y-2">
                          <FormLabel className="text-sm">Mẫu in hóa đơn</FormLabel>
                          <Select
                            value={field.value ?? '__none__'}
                            onValueChange={(v) =>
                              field.onChange(v === '__none__' ? null : v)
                            }
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Chọn" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="__none__">-- Không chọn --</SelectItem>
                              {(invoiceTemplates || []).map((t) => (
                                <SelectItem key={t.id} value={t.id}>
                                  {t.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="contract_template_id"
                      render={({ field }) => (
                        <FormItem className="space-y-2">
                          <FormLabel className="text-sm">Mẫu hợp đồng</FormLabel>
                          <Select
                            value={field.value ?? '__none__'}
                            onValueChange={(v) =>
                              field.onChange(v === '__none__' ? null : v)
                            }
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Chọn" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="__none__">-- Không chọn --</SelectItem>
                              {(leaseTemplates || []).map((t) => (
                                <SelectItem key={t.id} value={t.id}>
                                  {t.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Section 5: Hoa hồng môi giới */}
              <Card>
                <CardContent className="pt-6 space-y-4">
                  <h3 className="text-sm font-semibold text-gray-700 uppercase">
                    Hoa hồng môi giới
                  </h3>
                  <FormField
                    control={form.control}
                    name="commission_tiers"
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <CommissionTiersField
                            value={(field.value as CommissionTier[]) ?? []}
                            onChange={field.onChange}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </CardContent>
              </Card>

              {/* Footer */}
              <div className="flex justify-end gap-3 pt-2 pb-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={isPending}
                >
                  Huỷ bỏ
                </Button>
                <Button
                  type="submit"
                  disabled={isPending}
                  className="bg-green-600 hover:bg-green-700"
                >
                  {isPending ? 'Đang lưu...' : 'Lưu'}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
