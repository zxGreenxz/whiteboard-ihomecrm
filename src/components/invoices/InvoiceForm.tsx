import { useEffect, useCallback, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { format, addDays } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useContracts } from '@/hooks/useContracts';
import { useDocumentTemplates } from '@/hooks/useDocumentTemplates';
import { useInvoiceConfig } from '@/hooks/useSettings';
import { invoiceFormSchema } from '@/lib/invoiceValidation';
import InvoiceItemsTable from './InvoiceItemsTable';
import InvoiceSummarySection from './InvoiceSummarySection';
import type { InvoiceFormData, InvoiceFormItem } from '@/types/invoice';

/** Fetch contract with its services for auto-populating invoice items */
const useContractWithServices = (contractId?: string) => {
  return useQuery({
    queryKey: ['contract-with-services', contractId],
    queryFn: async () => {
      if (!contractId) return null;
      const { data, error } = await supabase
        .from('contracts')
        .select(`
          id, rent_price,
          room:rooms!contracts_room_id_fkey (id, name),
          contract_services (
            id, service_id, unit_price, initial_reading,
            service:services!inner (id, name, type)
          )
        `)
        .eq('id', contractId)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!contractId,
  });
};

interface InvoiceFormProps {
  defaultValues?: Partial<InvoiceFormData>;
  onSubmit: (data: InvoiceFormData) => void;
  isSubmitting?: boolean;
  mode?: 'create' | 'edit';
  /** Khi edit, loại HĐ hiện tại khỏi tính nợ cũ. */
  invoiceId?: string;
}

const today = () => format(new Date(), 'yyyy-MM-dd');
const currentMonth = () => format(new Date(), 'yyyy-MM');

const InvoiceForm = ({
  defaultValues,
  onSubmit,
  isSubmitting = false,
  mode = 'create',
  invoiceId,
}: InvoiceFormProps) => {
  const { data: invoiceConfig } = useInvoiceConfig();
  const dueDays = invoiceConfig?.payment_due_days ?? 5;

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors },
  } = useForm<InvoiceFormData>({
    resolver: zodResolver(invoiceFormSchema),
    defaultValues: {
      building_id: '',
      room_id: '',
      contract_id: '',
      billing_month: currentMonth(),
      issue_date: today(),
      due_date: format(addDays(new Date(), 5), 'yyyy-MM-dd'),
      template_id: null,
      notes: null,
      discount_amount: 0,
      prepaid_amount: 0,
      previous_debt: 0,
      previous_debt_sources: [],
      items: [],
      ...defaultValues,
    },
  });

  // Update due_date default when invoiceConfig loads (only in create mode with no default)
  useEffect(() => {
    if (mode === 'create' && !defaultValues?.due_date && invoiceConfig) {
      setValue('due_date', format(addDays(new Date(), dueDays), 'yyyy-MM-dd'));
    }
  }, [invoiceConfig, dueDays, mode, defaultValues?.due_date, setValue]);

  // Watched values for cascade selects
  const buildingId = watch('building_id');
  const roomId = watch('room_id');
  const contractId = watch('contract_id');

  // Data hooks
  const { data: buildings } = useBuildings();
  const { data: rooms } = useRooms(buildingId || undefined);
  const { data: contractsData } = useContracts();
  const contracts = (contractsData ?? []).filter((c: any) =>
    c.status === 'ACTIVE' && (!roomId || c.room_id === roomId),
  );
  const { data: templates } = useDocumentTemplates('INVOICE');
  const { data: contractDetail } = useContractWithServices(contractId || undefined);

  // Track whether we've already populated items for the current contract
  const populatedContractRef = useRef<string | null>(null);

  // Auto-populate items when contract detail (with services) loads
  useEffect(() => {
    if (!contractDetail || populatedContractRef.current === contractDetail.id) return;
    populatedContractRef.current = contractDetail.id;

    const items: InvoiceFormItem[] = [];

    // Add rent item
    if (contractDetail.rent_price) {
      const roomName = (contractDetail.room as any)?.name || '';
      items.push({
        type: 'RENT',
        description: `Tiền thuê ${roomName}`,
        unit_price: contractDetail.rent_price,
        quantity: 1,
        coefficient: 1,
        sort_order: 0,
      });
    }

    // Add contract services
    const services = (contractDetail.contract_services ?? []) as any[];
    services.forEach((cs: any, idx: number) => {
      items.push({
        service_id: cs.service_id,
        type: 'SERVICE',
        description: cs.service?.name || '',
        unit_price: cs.unit_price || 0,
        quantity: 1,
        coefficient: 1,
        previous_reading:
          cs.service?.type === 'METER_READING' ? (cs.initial_reading ?? null) : null,
        current_reading: null,
        sort_order: idx + 1,
      });
    });

    setValue('items', items);
  }, [contractDetail, setValue]);

  // Reset downstream selects when building changes
  const handleBuildingChange = useCallback(
    (value: string) => {
      setValue('building_id', value);
      setValue('room_id', '');
      setValue('contract_id', '');
      populatedContractRef.current = null;
    },
    [setValue],
  );

  // Reset downstream selects when room changes
  const handleRoomChange = useCallback(
    (value: string) => {
      setValue('room_id', value);
      setValue('contract_id', '');
      populatedContractRef.current = null;
    },
    [setValue],
  );

  const handleContractChange = useCallback(
    (value: string) => {
      populatedContractRef.current = null;
      setValue('contract_id', value);
    },
    [setValue],
  );

  const handleTemplateChange = useCallback(
    (value: string) => {
      setValue('template_id', value === '__none__' ? null : value);
    },
    [setValue],
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Section 1: Thông tin chung */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium">Thông tin chung</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Toà nhà */}
          <div className="space-y-1.5">
            <Label>Toà nhà *</Label>
            <Select value={buildingId} onValueChange={handleBuildingChange}>
              <SelectTrigger>
                <SelectValue placeholder="Chọn toà nhà..." />
              </SelectTrigger>
              <SelectContent>
                {(buildings ?? []).map((b: any) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.building_id && (
              <p className="text-xs text-red-500">{errors.building_id.message}</p>
            )}
          </div>

          {/* Phòng */}
          <div className="space-y-1.5">
            <Label>Phòng *</Label>
            <Select
              value={watch('room_id')}
              onValueChange={handleRoomChange}
              disabled={!buildingId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn phòng..." />
              </SelectTrigger>
              <SelectContent>
                {(rooms ?? []).map((r: any) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.room_id && (
              <p className="text-xs text-red-500">{errors.room_id.message}</p>
            )}
          </div>

          {/* Hợp đồng */}
          <div className="space-y-1.5">
            <Label>Hợp đồng *</Label>
            <Select
              value={contractId}
              onValueChange={handleContractChange}
              disabled={!roomId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn hợp đồng..." />
              </SelectTrigger>
              <SelectContent>
                {contracts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.contract_number || c.id.slice(0, 8)}
                    {c.tenant ? ` — ${c.tenant.full_name}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.contract_id && (
              <p className="text-xs text-red-500">{errors.contract_id.message}</p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Kỳ thanh toán */}
          <div className="space-y-1.5">
            <Label htmlFor="billing_month">Kỳ thanh toán *</Label>
            <Input
              id="billing_month"
              type="month"
              {...register('billing_month')}
            />
            {errors.billing_month && (
              <p className="text-xs text-red-500">{errors.billing_month.message}</p>
            )}
          </div>

          {/* Ngày lập */}
          <div className="space-y-1.5">
            <Label htmlFor="issue_date">Ngày lập *</Label>
            <DateInput
              value={watch('issue_date') || ''}
              onChange={(v) => setValue('issue_date', v, { shouldValidate: true, shouldDirty: true })}
            />
            {errors.issue_date && (
              <p className="text-xs text-red-500">{errors.issue_date.message}</p>
            )}
          </div>

          {/* Hạn thanh toán */}
          <div className="space-y-1.5">
            <Label htmlFor="due_date">Hạn thanh toán *</Label>
            <DateInput
              value={watch('due_date') || ''}
              onChange={(v) => setValue('due_date', v, { shouldValidate: true, shouldDirty: true })}
            />
            {errors.due_date && (
              <p className="text-xs text-red-500">{errors.due_date.message}</p>
            )}
          </div>

          {/* Mẫu in */}
          <div className="space-y-1.5">
            <Label>Mẫu in hoá đơn</Label>
            <Select
              value={watch('template_id') ?? '__none__'}
              onValueChange={handleTemplateChange}
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn mẫu in..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— Mặc định —</SelectItem>
                {(templates ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <Separator />

      {/* Section 2: Dịch vụ & Phí */}
      <InvoiceItemsTable
        control={control}
        register={register}
        watch={watch}
        setValue={setValue}
        errors={errors}
      />

      <Separator />

      {/* Section 3: Tổng kết */}
      <InvoiceSummarySection
        control={control}
        register={register}
        watch={watch}
        setValue={setValue}
        contractId={contractId || undefined}
        excludeInvoiceId={invoiceId}
      />

      <Separator />

      {/* Ghi chú */}
      <div className="space-y-1.5">
        <Label htmlFor="notes">Ghi chú</Label>
        <Textarea
          id="notes"
          {...register('notes')}
          placeholder="Ghi chú cho hoá đơn..."
          rows={3}
        />
      </div>

      {/* Submit */}
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting
            ? 'Đang xử lý...'
            : mode === 'create'
              ? 'Tạo hoá đơn'
              : 'Cập nhật'}
        </Button>
      </div>
    </form>
  );
};

export default InvoiceForm;
