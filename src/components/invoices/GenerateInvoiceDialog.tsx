import { useEffect, useMemo, useState } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CurrencyInput } from '@/components/ui/currency-input';
import { NumberInput } from '@/components/ui/number-input';
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
import { useCreateInvoice, useExcessAmount } from '@/hooks/useInvoices';
import type { InvoiceFormData } from '@/types/invoice';
import { useContracts } from '@/hooks/useContracts';
import { useVehicles } from '@/hooks/useVehicles';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useBuildingServices } from '@/hooks/useBuildingServices';
import { supabase } from '@/integrations/supabase/client';
import { DiscountNoteTrigger } from './DiscountNoteTrigger';
import { Receipt, Plus, Trash2, Pencil, AlertTriangle } from 'lucide-react';
import { format, addMonths, startOfMonth, endOfMonth, parse } from 'date-fns';

interface GenerateInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const customItemSchema = z.object({
  type: z.enum(['SERVICE', 'OTHER']),
  description: z.string().min(1, 'Vui lòng nhập mô tả'),
  quantity: z.number().min(0.0001, 'Số lượng phải > 0'),
  unit_price: z.number().min(0),
  service_id: z.string().nullable().optional(),
});

const generateInvoiceSchema = z.object({
  contract_id: z.string().min(1, 'Vui lòng chọn hợp đồng'),
  billing_month: z.string().regex(/^\d{4}-\d{2}$/, 'Định dạng YYYY-MM'),
  issue_date: z.string().min(1, 'Vui lòng chọn ngày phát hành'),
  due_date: z.string().min(1, 'Vui lòng chọn hạn thanh toán'),
  title: z.string().min(1, 'Vui lòng nhập tiêu đề'),
  rent_price: z.number().min(0).default(0),
  occupants: z.number().min(1).default(1),
  prev_reading: z.number().min(0).default(0),
  prev_reading_overridden: z.boolean().default(false),
  current_reading: z.number().nullable().default(null),
  electric_amount: z.number().min(0).default(0),
  electric_overridden: z.boolean().default(false),
  water_amount: z.number().min(0).default(0),
  water_overridden: z.boolean().default(false),
  pdv_amount: z.number().min(0).default(0),
  custom_items: z.array(customItemSchema).default([]),
  notes: z.string().optional(),
  discount_amount: z.number().min(0).default(0),
  discount_notes: z.string().nullable().optional(),
  applied_credit: z.number().min(0).optional(),
});

type GenerateInvoiceFormData = z.infer<typeof generateInvoiceSchema>;

const fmt = (n: number) =>
  new Intl.NumberFormat('vi-VN').format(Math.round(n || 0));
const formatCurrency = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n || 0);

const GenerateInvoiceDialog = ({ open, onOpenChange }: GenerateInvoiceDialogProps) => {
  const [filterBuildingId, setFilterBuildingId] = useState<string>('');
  const [filterRoomId, setFilterRoomId] = useState<string>('');
  const [meterId, setMeterId] = useState<string | null>(null);

  const createMutation = useCreateInvoice();
  const { data: contractsData } = useContracts();
  const allActiveContracts = (contractsData ?? []).filter((c: any) => c.status === 'ACTIVE');
  const contracts = allActiveContracts.filter((c: any) => {
    if (filterBuildingId && c.room?.building_id !== filterBuildingId) return false;
    if (filterRoomId && c.room_id !== filterRoomId) return false;
    return true;
  });
  const { data: buildings = [] } = useBuildings();
  const { data: rooms = [] } = useRooms(filterBuildingId || undefined);

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    control,
    reset,
  } = useForm<GenerateInvoiceFormData>({
    resolver: zodResolver(generateInvoiceSchema),
    defaultValues: {
      issue_date: new Date().toISOString().split('T')[0],
      due_date: addMonths(new Date(), 1).toISOString().split('T')[0],
      billing_month: format(new Date(), 'yyyy-MM'),
      rent_price: 0,
      occupants: 1,
      prev_reading: 0,
      prev_reading_overridden: false,
      current_reading: null,
      electric_amount: 0,
      electric_overridden: false,
      water_amount: 0,
      water_overridden: false,
      pdv_amount: 0,
      custom_items: [],
      discount_amount: 0,
      discount_notes: '',
      applied_credit: 0,
    },
  });

  const { fields: customFields, append: appendCustom, remove: removeCustom } = useFieldArray({
    control,
    name: 'custom_items',
  });

  const watchedContractId = watch('contract_id');
  const watchedRent = watch('rent_price') || 0;
  const watchedOccupants = watch('occupants') || 0;
  const watchedPrev = watch('prev_reading') || 0;
  const watchedCurrent = watch('current_reading');
  const watchedElectric = watch('electric_amount') || 0;
  const watchedWater = watch('water_amount') || 0;
  const watchedPDV = watch('pdv_amount') || 0;
  const watchedCustomItems = watch('custom_items') || [];
  const watchedDiscount = watch('discount_amount') || 0;
  const watchedDiscountNotes = watch('discount_notes') || '';
  const watchedBillingMonth = watch('billing_month') || '';

  const selectedContract = contracts?.find((c) => c.id === watchedContractId);
  const buildingIdOfContract =
    (selectedContract as any)?.room?.building_id ||
    (selectedContract as any)?.bed?.room?.building_id ||
    '';
  const { data: bldSvc } = useBuildingServices(buildingIdOfContract);
  const { data: vehicles } = useVehicles({ contract_id: watchedContractId });

  // Lấy đơn giá mặc định từ building_services (giống ExcelInvoiceDialog).
  const defaults = useMemo(() => {
    let elec = 3500;
    let water = 100000;
    let pdv = 150000;
    let elecServiceId: string | null = null;
    let waterServiceId: string | null = null;
    let pdvServiceId: string | null = null;
    for (const bs of (bldSvc ?? []).filter((b: any) => b.is_active)) {
      const name = bs.service?.name?.toLowerCase() ?? '';
      const price = bs.unit_price_override ?? bs.service?.unit_price ?? 0;
      if (name.includes('điện')) {
        elec = Number(price) || elec;
        elecServiceId = bs.service_id;
      } else if (name.includes('nước')) {
        water = Number(price) || water;
        waterServiceId = bs.service_id;
      } else if (name.includes('dịch vụ') || name.includes('phí')) {
        pdv = Number(price) || pdv;
        pdvServiceId = bs.service_id;
      }
    }
    return { elec, water, pdv, elecServiceId, waterServiceId, pdvServiceId };
  }, [bldSvc]);

  // Khi chọn HĐ: load rent_price, occupants, meter prev_reading; prefill nước+PDV.
  useEffect(() => {
    if (!selectedContract) return;
    const occ = (selectedContract as any).contract_customers?.length || 1;
    setValue('rent_price', Number((selectedContract as any).rent_price) || 0);
    setValue('occupants', occ);
    setValue('current_reading', null);
    setValue('prev_reading_overridden', false);
    setValue('electric_amount', 0);
    setValue('electric_overridden', false);
    setValue('water_amount', occ * defaults.water);
    setValue('water_overridden', false);
    setValue('pdv_amount', defaults.pdv);
    // Auto tiêu đề
    const billing = watchedBillingMonth || format(new Date(), 'yyyy-MM');
    setValue(
      'title',
      `Hóa đơn ${(selectedContract as any).contract_number || 'HĐ'} - ${billing.slice(5)}/${billing.slice(0, 4)}`,
    );

    // Load meter điện cho phòng + chỉ số đầu (latest APPROVED).
    const roomId = (selectedContract as any).room_id || (selectedContract as any).bed?.room?.id;
    if (roomId) {
      (async () => {
        const { data: meters } = await supabase
          .from('meters')
          .select('id')
          .eq('room_id', roomId)
          .eq('meter_type', 'ELECTRICITY')
          .is('deleted_at', null)
          .limit(1);
        const mid = (meters as any)?.[0]?.id ?? null;
        setMeterId(mid);
        if (mid) {
          const { data: readings } = await (supabase as any)
            .from('meter_readings')
            .select('current_reading, reading_date')
            .eq('meter_id', mid)
            .eq('status', 'APPROVED')
            .is('deleted_at', null)
            .order('reading_date', { ascending: false })
            .limit(1);
          setValue('prev_reading', Number((readings as any)?.[0]?.current_reading) || 0);
        } else {
          setValue('prev_reading', 0);
        }
      })();
    } else {
      setMeterId(null);
      setValue('prev_reading', 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedContract?.id, defaults.water, defaults.pdv]);

  // Auto tính tiền điện theo chỉ số (nếu user không override).
  useEffect(() => {
    if (watch('electric_overridden')) return;
    const consumption = Math.max(0, (Number(watchedCurrent) || 0) - watchedPrev);
    setValue('electric_amount', consumption * defaults.elec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedCurrent, watchedPrev, defaults.elec]);

  // Auto tính nước theo số người (nếu không override).
  useEffect(() => {
    if (watch('water_overridden')) return;
    setValue('water_amount', watchedOccupants * defaults.water);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedOccupants, defaults.water]);

  // Auto-fill vehicle parking fees vào custom_items khi đổi HĐ.
  useEffect(() => {
    if (!selectedContract) return;
    const next = (vehicles ?? [])
      .filter((v: any) => v.parking_fee && v.parking_fee > 0)
      .map((v: any) => ({
        type: 'SERVICE' as const,
        description: `Phí gửi xe ${v.license_plate || v.vehicle_type}`,
        quantity: 1,
        unit_price: Number(v.parking_fee) || 0,
      }));
    setValue('custom_items', next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedContract?.id, vehicles?.length]);

  // Auto chọn hợp đồng khi đã có toà + phòng. Nếu có nhiều HĐ ACTIVE cùng
  // phòng → để trống và cảnh báo đỏ user phải tự chọn.
  const matchingContracts = useMemo(() => {
    if (!filterBuildingId || !filterRoomId) return [];
    return (allActiveContracts as any[]).filter(
      (c) => c.room?.building_id === filterBuildingId && c.room_id === filterRoomId,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterBuildingId, filterRoomId, allActiveContracts.length]);
  const multipleContractsWarning = matchingContracts.length > 1;

  useEffect(() => {
    if (!filterBuildingId || !filterRoomId) return;
    if (matchingContracts.length === 1) {
      const id = matchingContracts[0].id;
      if (watchedContractId !== id) setValue('contract_id', id, { shouldValidate: true });
    } else if (matchingContracts.length > 1 && watchedContractId) {
      // Có >1 HĐ → clear lựa chọn để user chọn thủ công
      if (!matchingContracts.some((c) => c.id === watchedContractId)) {
        setValue('contract_id', '', { shouldValidate: false });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterBuildingId, filterRoomId, matchingContracts.length]);

  // Pre-check: HĐ + kỳ đã có invoice chưa? Tránh hit unique constraint khi submit.
  const { data: existingInvoice } = useQuery({
    queryKey: ['invoice-exists', watchedContractId, watchedBillingMonth],
    enabled: !!watchedContractId && /^\d{4}-\d{2}$/.test(watchedBillingMonth || ''),
    queryFn: async () => {
      const { data } = await (supabase
        .from('invoices')
        .select('id, invoice_number') as any)
        .eq('contract_id', watchedContractId)
        .eq('billing_month', watchedBillingMonth)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle();
      return data ?? null;
    },
  });

  // Credit auto-fill discount.
  const { data: creditBalance = 0 } = useExcessAmount(watchedContractId);
  useEffect(() => {
    if (!watchedContractId) return;
    if (creditBalance <= 0) return;
    if (watchedDiscount > 0) return;
    setValue('discount_amount', creditBalance);
    setValue('discount_notes', `Nợ ${creditBalance.toLocaleString('vi-VN')} Tiền Thối`);
    setValue('applied_credit', creditBalance);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedContractId, creditBalance]);

  const subtotal =
    watchedRent +
    watchedElectric +
    watchedWater +
    watchedPDV +
    watchedCustomItems.reduce(
      (s, it) => s + (it.quantity || 0) * (it.unit_price || 0),
      0,
    );
  const totalAmount = Math.max(0, subtotal - watchedDiscount);

  const handleClose = () => {
    reset();
    setFilterBuildingId('');
    setFilterRoomId('');
    setMeterId(null);
    onOpenChange(false);
  };

  const onSubmit = async (data: GenerateInvoiceFormData) => {
    if (!selectedContract) return;
    const roomData = (selectedContract as any).room;
    const bedData = (selectedContract as any).bed;
    const buildingId = roomData?.building_id || bedData?.room?.building_id || '';
    const roomId = roomData?.id || bedData?.room?.id || '';
    const bedId = bedData?.id || null;
    if (!buildingId || !roomId) return;

    const periodStart = startOfMonth(parse(data.billing_month + '-01', 'yyyy-MM-dd', new Date()));
    const periodEnd = endOfMonth(periodStart);
    const fromDate = format(periodStart, 'yyyy-MM-dd');
    const toDate = format(periodEnd, 'yyyy-MM-dd');

    // 1) Ghi chỉ số mới (nếu user nhập) — APPROVED ngay.
    const consumption =
      (Number(data.current_reading) || 0) - (Number(data.prev_reading) || 0);
    if (meterId && data.current_reading != null && consumption >= 0) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('meter_readings').insert({
          user_id: user.id,
          meter_id: meterId,
          reading_date: data.issue_date,
          settlement_month: data.billing_month,
          previous_reading: data.prev_reading,
          current_reading: Number(data.current_reading),
          status: 'APPROVED',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
          meter_type: 'ELECTRICITY',
          service_id: defaults.elecServiceId,
          recorded_by: user.id,
        } as any);
      }
    }

    // 2) Build items.
    const items: InvoiceFormData['items'] = [];
    let order = 0;
    items.push({
      type: 'RENT',
      description: `Tiền thuê căn hộ ${roomData?.name || bedData?.name || ''}`.trim(),
      unit_price: data.rent_price,
      quantity: 1,
      coefficient: 1,
      sort_order: order++,
    });
    if (data.electric_amount > 0) {
      const cons = Math.max(consumption, 0);
      items.push({
        service_id: defaults.elecServiceId,
        type: 'SERVICE',
        description: `Tiền điện (${data.prev_reading} → ${data.current_reading ?? data.prev_reading})`,
        unit_price: cons > 0 ? data.electric_amount / cons : data.electric_amount,
        quantity: cons > 0 ? cons : 1,
        coefficient: 1,
        previous_reading: data.prev_reading,
        current_reading: Number(data.current_reading) || data.prev_reading,
        from_date: fromDate,
        to_date: toDate,
        sort_order: order++,
      });
    }
    if (data.water_amount > 0) {
      items.push({
        service_id: defaults.waterServiceId,
        type: 'SERVICE',
        description: `Tiền nước (${data.occupants} người)`,
        unit_price:
          data.occupants > 0 ? data.water_amount / data.occupants : data.water_amount,
        quantity: data.occupants || 1,
        coefficient: 1,
        sort_order: order++,
      });
    }
    if (data.pdv_amount > 0) {
      items.push({
        service_id: defaults.pdvServiceId,
        type: 'SERVICE',
        description: 'Phí dịch vụ',
        unit_price: data.pdv_amount,
        quantity: 1,
        coefficient: 1,
        sort_order: order++,
      });
    }
    for (const ci of data.custom_items || []) {
      items.push({
        service_id: ci.service_id || null,
        type: ci.type as any,
        description: ci.description,
        unit_price: ci.unit_price,
        quantity: ci.quantity,
        coefficient: 1,
        sort_order: order++,
      });
    }

    const discountAmount = data.discount_amount || 0;
    const appliedCredit = Math.min(
      Math.max(0, data.applied_credit || 0),
      Math.max(0, discountAmount),
    );

    const invoiceFormData: InvoiceFormData = {
      building_id: buildingId,
      room_id: roomId,
      bed_id: bedId,
      contract_id: data.contract_id,
      billing_month: data.billing_month,
      issue_date: data.issue_date,
      due_date: data.due_date,
      notes: data.notes || null,
      discount_amount: discountAmount,
      discount_notes: data.discount_notes?.trim() || null,
      applied_credit: appliedCredit,
      electricity_prev_overridden: !!data.prev_reading_overridden,
      tax_percent: 0,
      prepaid_amount: 0,
      previous_debt: 0,
      items,
    };

    createMutation.mutate(invoiceFormData, { onSuccess: handleClose });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            Tạo hóa đơn mới
          </DialogTitle>
          <DialogDescription>
            Tạo hóa đơn thanh toán cho hợp đồng (cùng layout như Mode Excel — cho 1 phòng).
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Filter Toà / Phòng */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Toà nhà</Label>
              <Select
                value={filterBuildingId || '__all__'}
                onValueChange={(value) => {
                  const next = value === '__all__' ? '' : value;
                  setFilterBuildingId(next);
                  setFilterRoomId('');
                  setValue('contract_id', '');
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Tất cả toà nhà" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Tất cả toà nhà</SelectItem>
                  {(buildings as any[]).map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Phòng</Label>
              <Select
                value={filterRoomId || '__all__'}
                onValueChange={(value) => {
                  const next = value === '__all__' ? '' : value;
                  setFilterRoomId(next);
                  setValue('contract_id', '');
                }}
                disabled={!filterBuildingId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={filterBuildingId ? 'Tất cả phòng' : 'Chọn toà trước'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Tất cả phòng</SelectItem>
                  {(rooms as any[]).map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Contract */}
          <div className="space-y-1">
            <Label>Hợp đồng *</Label>
            <Select
              value={watchedContractId || ''}
              onValueChange={(value) => setValue('contract_id', value, { shouldValidate: true })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Chọn hợp đồng..." />
              </SelectTrigger>
              <SelectContent>
                {contracts?.map((contract: any) => {
                  const rep =
                    contract.contract_customers?.find((cc: any) => cc.is_representative) ||
                    contract.contract_customers?.[0];
                  const customerName = rep?.customer?.full_name ?? '';
                  return (
                    <SelectItem key={contract.id} value={contract.id}>
                      {contract.contract_number || contract.id.slice(0, 8)}
                      {customerName && ` - ${customerName}`}
                      {contract.room && ` - ${contract.room.name}`}
                      {contract.bed && ` - ${contract.bed.name}`}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {errors.contract_id && (
              <p className="text-sm text-red-500">{errors.contract_id.message}</p>
            )}
            {multipleContractsWarning && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded px-3 py-2 text-xs text-red-700">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  Phòng này đang có {matchingContracts.length} hợp đồng còn hiệu lực —
                  vui lòng tự chọn đúng hợp đồng cần lập hoá đơn.
                </span>
              </div>
            )}
          </div>

          {/* Dates */}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label>Kỳ thanh toán *</Label>
              <Input
                type="month"
                value={watchedBillingMonth}
                onChange={(e) => setValue('billing_month', e.target.value, { shouldValidate: true })}
              />
              {errors.billing_month && (
                <p className="text-xs text-red-500">{errors.billing_month.message}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Ngày phát hành *</Label>
              <DateInput
                value={watch('issue_date') || ''}
                onChange={(v) => setValue('issue_date', v, { shouldValidate: true })}
              />
            </div>
            <div className="space-y-1">
              <Label>Hạn thanh toán *</Label>
              <DateInput
                value={watch('due_date') || ''}
                onChange={(v) => setValue('due_date', v, { shouldValidate: true })}
              />
            </div>
          </div>

          {/* Tiêu đề */}
          <div className="space-y-1">
            <Label htmlFor="title">Tiêu đề hóa đơn *</Label>
            <Input id="title" {...register('title')} placeholder="VD: Hóa đơn tháng 05/2026" />
            {errors.title && <p className="text-xs text-red-500">{errors.title.message}</p>}
          </div>

          {/* Cảnh báo: HĐ + kỳ này đã có invoice */}
          {existingInvoice && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                Hợp đồng này đã có hoá đơn kỳ <b>{watchedBillingMonth}</b>{' '}
                ({existingInvoice.invoice_number || existingInvoice.id?.slice(0, 8)}).
                Hệ thống chỉ cho phép 1 hoá đơn / hợp đồng / kỳ — chọn kỳ khác hoặc
                xoá/sửa hoá đơn cũ trước.
              </span>
            </div>
          )}

          {selectedContract && (
            <>
              {/* Structured row — như 1 dòng của Mode Excel */}
              <div className="border rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100">
                    <tr className="text-xs uppercase">
                      <th className="p-2 border text-right">Giá phòng</th>
                      <th className="p-2 border text-right w-[80px]">Số người</th>
                      <th className="p-2 border text-right w-[100px]">Chỉ số đầu</th>
                      <th className="p-2 border text-right w-[110px]">Chỉ số cuối</th>
                      <th className="p-2 border text-right">Tiền điện</th>
                      <th className="p-2 border text-right">Nước</th>
                      <th className="p-2 border text-right">Phí dịch vụ</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="p-1 border">
                        <CurrencyInput
                          className="h-8 text-right"
                          suffix={false}
                          value={watchedRent}
                          onChange={(v) => setValue('rent_price', v)}
                        />
                      </td>
                      <td className="p-1 border">
                        <NumberInput
                          className="h-8 text-right"
                          value={watchedOccupants}
                          onChange={(v) => setValue('occupants', v)}
                        />
                      </td>
                      <td className="p-1 border">
                        {meterId ? (
                          watch('prev_reading_overridden') ? (
                            <div className="relative">
                              <NumberInput
                                className="h-8 text-right pr-6"
                                allowDecimal
                                value={watchedPrev}
                                onChange={(v) => setValue('prev_reading', v ?? 0)}
                              />
                              <Pencil className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-amber-600 pointer-events-none" />
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-1 pr-1">
                              <span className="text-slate-600 tabular-nums">
                                {fmt(watchedPrev)}
                              </span>
                              <button
                                type="button"
                                title="Sửa tay chỉ số đầu"
                                className="text-slate-400 hover:text-amber-600 p-0.5 rounded"
                                onClick={() =>
                                  setValue('prev_reading_overridden', true)
                                }
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            </div>
                          )
                        ) : (
                          <span className="text-slate-400 text-right block px-2">—</span>
                        )}
                      </td>
                      <td className="p-1 border">
                        <NumberInput
                          className="h-8 text-right"
                          disabled={!meterId}
                          allowDecimal
                          value={watchedCurrent}
                          onChange={(v) => setValue('current_reading', v)}
                        />
                      </td>
                      <td className="p-1 border">
                        <CurrencyInput
                          className="h-8 text-right"
                          suffix={false}
                          value={Math.round(watchedElectric)}
                          onChange={(v) =>
                            setValue('electric_amount', v, { shouldDirty: true })
                          }
                          onBlur={() => setValue('electric_overridden', true)}
                        />
                      </td>
                      <td className="p-1 border">
                        <CurrencyInput
                          className="h-8 text-right"
                          suffix={false}
                          value={Math.round(watchedWater)}
                          onChange={(v) => setValue('water_amount', v, { shouldDirty: true })}
                          onBlur={() => setValue('water_overridden', true)}
                        />
                      </td>
                      <td className="p-1 border">
                        <CurrencyInput
                          className="h-8 text-right"
                          suffix={false}
                          value={watchedPDV}
                          onChange={(v) => setValue('pdv_amount', v)}
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="px-2 py-1 text-[11px] text-muted-foreground bg-slate-50 border-t">
                  Đơn giá toà: điện {fmt(defaults.elec)}đ/kWh — nước {fmt(defaults.water)}đ/người — PDV {fmt(defaults.pdv)}đ/phòng.
                </p>
              </div>

              {/* Custom items */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Khoản thu thêm</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      appendCustom({
                        type: 'OTHER',
                        description: '',
                        quantity: 1,
                        unit_price: 0,
                      })
                    }
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Thêm
                  </Button>
                </div>
                {customFields.length > 0 && (
                  <div className="border rounded-md overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-xs uppercase">
                        <tr>
                          <th className="p-2 border text-left">Loại</th>
                          <th className="p-2 border text-left">Mô tả</th>
                          <th className="p-2 border text-right w-[80px]">SL</th>
                          <th className="p-2 border text-right w-[120px]">Đơn giá</th>
                          <th className="p-2 border text-right w-[120px]">Thành tiền</th>
                          <th className="p-2 border w-8" />
                        </tr>
                      </thead>
                      <tbody>
                        {customFields.map((field, idx) => {
                          const row = watchedCustomItems[idx];
                          const lineTotal = (row?.quantity || 0) * (row?.unit_price || 0);
                          return (
                            <tr key={field.id}>
                              <td className="p-1 border">
                                <Select
                                  value={row?.type || 'OTHER'}
                                  onValueChange={(v) =>
                                    setValue(`custom_items.${idx}.type` as const, v as any)
                                  }
                                >
                                  <SelectTrigger className="h-8 w-[110px]">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="SERVICE">Dịch vụ</SelectItem>
                                    <SelectItem value="OTHER">Khác</SelectItem>
                                  </SelectContent>
                                </Select>
                              </td>
                              <td className="p-1 border">
                                <Input
                                  className="h-8"
                                  {...register(`custom_items.${idx}.description` as const)}
                                />
                              </td>
                              <td className="p-1 border">
                                <NumberInput
                                  className="h-8 text-right"
                                  allowDecimal
                                  value={row?.quantity || 0}
                                  onChange={(v) =>
                                    setValue(`custom_items.${idx}.quantity` as const, v)
                                  }
                                />
                              </td>
                              <td className="p-1 border">
                                <CurrencyInput
                                  className="h-8 text-right"
                                  suffix={false}
                                  value={row?.unit_price || 0}
                                  onChange={(v) =>
                                    setValue(`custom_items.${idx}.unit_price` as const, v)
                                  }
                                />
                              </td>
                              <td className="p-1 border text-right font-medium">
                                {fmt(lineTotal)}
                              </td>
                              <td className="p-1 border text-center">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => removeCustom(idx)}
                                >
                                  <Trash2 className="h-3.5 w-3.5 text-red-600" />
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Giảm trừ */}
              <div className="bg-amber-50 border border-amber-200 p-3 rounded-md space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="discount_amount" className="text-amber-900 shrink-0">
                    Giảm trừ:
                  </Label>
                  <div className="relative w-48">
                    <CurrencyInput
                      className="h-9 text-right pr-3"
                      suffix={false}
                      value={watchedDiscount}
                      onChange={(v) => setValue('discount_amount', v, { shouldDirty: true })}
                    />
                    <DiscountNoteTrigger
                      value={watchedDiscountNotes}
                      onChange={(v) => setValue('discount_notes', v, { shouldDirty: true })}
                      disabled={watchedDiscount <= 0}
                    />
                  </div>
                </div>
                {watchedContractId && creditBalance > 0 && (
                  <p className="text-[11px] text-amber-700 text-right">
                    Tiền nợ khách: {formatCurrency(creditBalance)}
                  </p>
                )}
              </div>

              {/* Total */}
              <div className="bg-blue-50 border border-blue-200 p-4 rounded-md">
                <div className="flex items-center justify-between">
                  <span className="text-lg font-medium text-blue-900">Tổng cộng:</span>
                  <span className="text-2xl font-bold text-blue-900">
                    {formatCurrency(totalAmount)}
                  </span>
                </div>
              </div>
            </>
          )}

          {/* Notes */}
          <div className="space-y-1">
            <Label htmlFor="notes">Ghi chú</Label>
            <Textarea
              id="notes"
              {...register('notes')}
              placeholder="Ghi chú về hóa đơn..."
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Hủy
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending || !selectedContract || !!existingInvoice}
            >
              {createMutation.isPending ? 'Đang tạo...' : 'Tạo hóa đơn'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default GenerateInvoiceDialog;
