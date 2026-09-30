import { useEffect, useState, useMemo, useRef } from 'react';
import { recordWriteBlocked, recordWriteMessage } from '@/lib/recordWriteOutcome';
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
import BuildingAddressSection from './BuildingAddressSection';
import BuildingGeoSection from './BuildingGeoSection';
import BuildingServicesSection from './BuildingServicesSection';
import { CommissionTiersField } from './CommissionTiersField';
import { BuildingLegalOwnerFields } from './BuildingLegalOwnerFields';
import BuildingOwnershipDocs from '@/components/residence/BuildingOwnershipDocs';
import { useBuildingLegalOwnerForm } from '@/hooks/useBuildingLegalOwnerForm';
import { FinancialWorkflowError } from '@/lib/financialWorkflowError';
import { focusFirstError } from '@/lib/formErrors';
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { runBuildingSaveWorkflow } from '@/lib/buildingSaveWorkflow';
import { useBuildingSavePending } from '@/hooks/useBuildingSavePending';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import type { BuildingLegalOwner } from '@/lib/buildingLegalOwner';

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
  const {selectedOrganizationId}=useOrganization();
  const priorSave=useBuildingSavePending(building?`edit:${building.id}`:'create',selectedOrganizationId,open);
  const saveGuard=useMemo(()=>persistentFinancialWorkflow('building-form-save'),[]);
  const savedOwner=useRef<BuildingLegalOwner|null>(null);
  const [coreFailure, setCoreFailure] = useState<unknown>();
  const [coreBlocked, setCoreBlocked] = useState(false);
  const draftKey = useRef<string | null>(null);
  const owner = useBuildingLegalOwnerForm(building?.id, open);
  const [createdBuildingId, setCreatedBuildingId] = useState<string | null>(null);
  const [updatedBuildingId, setUpdatedBuildingId] = useState<string | null>(null);
  const [savedServicesPayload, setSavedServicesPayload] = useState<Array<{ service_id: string; is_active: boolean; unit_price_override: number | null }> | null>(null);
  const [partialMessage, setPartialMessage] = useState<string | null>(null);
  useEffect(() => { setCreatedBuildingId(null); setUpdatedBuildingId(null); setSavedServicesPayload(null); setPartialMessage(null); }, [building?.id]);

  // Hooks
  const createBuilding = useCreateBuilding({ silentSuccess: true });
  const updateBuilding = useUpdateBuilding({ silentSuccess: true });
  const upsertServices = useUpsertBuildingServices({silent:true});

  // Services
  const servicesQuery = useServices(undefined, { enabled: open });
  const { data: allServices } = servicesQuery;
  const existingServicesQuery = useBuildingServices(open ? building?.id || '' : '');
  const { data: existingBuildingServices } = existingServicesQuery;
  const [buildingServices, setBuildingServices] = useState<BuildingServiceFormData[]>([]);

  // Document templates for Cấu hình section
  const { data: invoiceTemplates = [] } = useDocumentTemplatesByType('invoice');
  const { data: leaseTemplates = [] } = useDocumentTemplatesByType('lease_contract');

  // Sổ nhận chuyển khoản / thanh toán (buildings.default_account_id_tk/_tt) KHÔNG
  // còn sửa ở form này (đợt 1 sửa phiếu, 25/09/2026): chỉ sửa ở màn "Sổ nhận tiền"
  // qua set_building_receiving_cashbooks_v1, cùng lúc với danh sách sổ phụ. Form
  // không đọc cũng không gửi hai cột đó: gửi lại giá trị đọc lúc mở form sẽ ghi đè
  // cấu hình chủ vừa đổi ở màn Sổ nhận tiền trong lúc form còn mở.

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
      const key = building?.id ?? 'create';
      if (draftKey.current === key && (coreFailure || createdBuildingId || updatedBuildingId || form.formState.isDirty)) return;
      draftKey.current = key;
      setCoreFailure(undefined); setCoreBlocked(false);
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
    if (coreBlocked || sourceBlocked) return;
    if (!await owner.validate()) return;
    form.clearErrors('root.server');
    setPartialMessage(null); setCoreFailure(undefined);
    let savedId: string | null = createdBuildingId ?? updatedBuildingId;
    const ownerSnapshot = savedOwner.current ?? owner.form.getValues();
    const servicesPayload = savedServicesPayload ?? buildingServices.map(s=>({service_id:s.service_id,is_active:s.is_active,unit_price_override:s.unit_price_override}));
    const corePayload={
      name:data.name,code:data.code||null,province:data.province,district:data.district,ward:data.ward,street_address:data.street_address,
      latitude:data.latitude??null,longitude:data.longitude??null,status:data.status,has_elevator:data.has_elevator??false,
      contract_template_id:data.contract_template_id??null,invoice_template_id:data.invoice_template_id??null,
      commission_tiers:(data.commission_tiers??DEFAULT_COMMISSION_TIERS) as any,
    };
    try {
      if(!selectedOrganizationId)throw new Error('Chọn tổ chức trước khi lưu tòa.');
      await runBuildingSaveWorkflow(saveGuard,{
        key:building?`edit:${building.id}`:'create',organizationId:selectedOrganizationId,expectedCore:corePayload,
        writeCore:()=>building?updateBuilding.mutateAsync({id:building.id,updates:corePayload}):createBuilding.mutateAsync(corePayload),
        readCore:async ids=>{const {data:rows,error}=await supabase.from('buildings').select('*').in('id',[...ids]).eq('organization_id',selectedOrganizationId).is('deleted_at',null);if(error)throw error;return rows;},
        onCoreConfirmed:id=>{savedId=id;savedOwner.current=ownerSnapshot;setSavedServicesPayload(servicesPayload);if(building)setUpdatedBuildingId(id);else setCreatedBuildingId(id);},
        saveRelated:async(id,progress,recovering)=>{
          await owner.save(id,ownerSnapshot,recovering);
          progress.stage='lưu dịch vụ tòa nhà';
          try {const ids=await upsertServices.mutateAsync({buildingId:id,services:servicesPayload});progress.completed.push(...(ids??[]).map(serviceId=>({id:serviceId,label:'Đã đối chiếu dịch vụ tòa'})));}
          catch(error){if(error instanceof FinancialWorkflowError)progress.completed.push(...error.completed);throw error;}
        },
      });
      toast.success(`Đã ${building?'cập nhật':'tạo'} tòa nhà ${data.name}`);
      setCreatedBuildingId(null);
      setUpdatedBuildingId(null);
      setSavedServicesPayload(null);
      draftKey.current = null; savedOwner.current=null;
      onOpenChange(false);
    } catch (error: unknown) {
      if (savedId) {
        const message = recordWriteMessage(error,'lưu tòa nhà và dữ liệu liên quan')+" Mở lại tòa có ID đã lưu để đối chiếu; không tạo lại tòa.";
        setPartialMessage(message);
      } else {
        setCoreFailure(error); setCoreBlocked(recordWriteBlocked(error));
        form.setError('root.server', { type: 'server', message: recordWriteMessage(error,'lưu tòa nhà') });
      }
    }
  };

  const sources = [servicesQuery, ...(isEditMode ? [existingServicesQuery] : [])];
  const sourceBlocked = sources.some(query => query.isError || query.isLoading);
  const isPending =
    createBuilding.isPending || updateBuilding.isPending || upsertServices.isPending || owner.saving || form.formState.isSubmitting;

  const status = form.watch('status');
  const hasElevator = form.watch('has_elevator');

  return (
    <Dialog open={open} onOpenChange={value => { if (!isPending && (value || (!createdBuildingId && !updatedBuildingId))) onOpenChange(value); }}>
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
            <form onSubmit={form.handleSubmit(onSubmit, errors => { void focusFirstError(errors); })} className="space-y-4">
              {priorSave && <p role="alert" className="rounded border border-amber-500 p-3 text-sm">Yêu cầu lưu tòa trước chưa được xác nhận đầy đủ. {priorSave.ids.length>0?`ID cần đối chiếu: ${priorSave.ids.join(', ')}.`:'Giữ thông tin đã nhập và đối chiếu trước khi tạo lại.'} {priorSave.buildingId && <a className="underline" href={`/buildings/${priorSave.buildingId}`}>Mở tòa đã lưu</a>} Lần lưu tiếp chỉ được tiếp tục phần còn thiếu sau khi đối chiếu đúng tòa.</p>}
              {form.formState.errors.root?.server?.message && <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.server.message}</p>}
              {partialMessage && <p role="alert" className="rounded-md border border-amber-500 p-3 text-sm">{partialMessage}</p>}
              {sourceBlocked && <div role="alert" className="rounded border border-destructive p-3 text-sm">Chưa tải đủ dịch vụ của tòa. Tải lại trước khi lưu.<Button type="button" variant="outline" onClick={() => {for(const query of sources)void query.refetch();}}>Tải lại dịch vụ</Button></div>}
              <fieldset disabled={isPending || coreBlocked || sourceBlocked || !!createdBuildingId || !!updatedBuildingId} className="space-y-4">
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
                  <p className="text-xs text-muted-foreground">
                    Sổ nhận chuyển khoản / thanh toán cài ở Tài chính → Sổ quỹ → Sổ nhận tiền.
                  </p>
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

              </fieldset>
              {(createdBuildingId || updatedBuildingId) && <p role="status" className="text-sm text-amber-700">Tòa nhà đã lưu với ID {createdBuildingId ?? updatedBuildingId}. Lần lưu tiếp theo chỉ hoàn tất chủ sở hữu và dịch vụ; thông tin cơ bản cần chỉnh sau khi hoàn tất.</p>}
              <BuildingLegalOwnerFields {...owner} />
              {isEditMode && building && <BuildingOwnershipDocs buildingId={building.id} buildingName={building.name} />}
              {/* Footer */}
              <div className="flex justify-end gap-3 pt-2 pb-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={isPending}
                >
                  {createdBuildingId || updatedBuildingId ? 'Đóng để đối chiếu tòa đã lưu' : 'Huỷ bỏ'}
                </Button>
                <Button
                  type="submit"
                  disabled={isPending || coreBlocked || sourceBlocked || owner.loading || !!owner.error}
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
