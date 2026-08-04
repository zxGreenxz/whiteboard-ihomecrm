import { useEffect, useMemo, useState } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
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
import { useUpdateInvoice, useExcessAmount } from '@/hooks/useInvoices';
import type {
  InvoiceFormData,
  InvoiceWithRelations,
  PreviousDebtSource,
} from '@/types/invoice';
import { roundInvoiceTotal } from '@/lib/invoiceUtils';
import { computePreviousDebt } from '@/lib/invoiceHelpers';
import { useBuildingServices } from '@/hooks/useBuildingServices';
import { supabase } from '@/integrations/supabase/client';
import { DiscountNoteTrigger } from './DiscountNoteTrigger';
import { Receipt, Plus, Trash2, Pencil, RotateCcw, Loader2 } from 'lucide-react';
import { format, parse, startOfMonth, endOfMonth } from 'date-fns';

interface EditInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations;
}

const customItemSchema = z.object({
  type: z.enum(['SERVICE', 'OTHER']),
  description: z.string().min(1, 'Vui lòng nhập mô tả'),
  quantity: z.number().min(0.0001, 'Số lượng phải > 0'),
  unit_price: z.number().min(0),
  service_id: z.string().nullable().optional(),
});

const editInvoiceSchema = z.object({
  billing_month: z.string().regex(/^\d{4}-\d{2}$/, 'Định dạng YYYY-MM'),
  issue_date: z.string().min(1),
  due_date: z.string().min(1),
  title: z.string().optional(),
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
  previous_debt: z.number().min(0).default(0),
  previous_debt_overridden: z.boolean().default(false),
});

type EditFormData = z.infer<typeof editInvoiceSchema>;

const fmt = (n: number) =>
  new Intl.NumberFormat('vi-VN').format(Math.round(n || 0));
const formatCurrency = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n || 0);

// Decompose existing invoice_items into structured fields (rent/electric/water/pdv)
// + leftover as custom_items.
function decomposeItems(invoice: InvoiceWithRelations) {
  let rent = 0;
  let electric = 0;
  let prev = 0;
  let curr: number | null = null;
  let water = 0;
  let occupants = 1;
  let pdv = 0;
  const custom: Array<{
    type: 'SERVICE' | 'OTHER';
    description: string;
    quantity: number;
    unit_price: number;
    service_id?: string | null;
  }> = [];

  for (const it of invoice.invoice_items ?? []) {
    const desc = (it.description || '').toLowerCase();
    if (it.type === 'RENT') {
      rent = Number(it.unit_price) || 0;
      continue;
    }
    if (it.type === 'SERVICE') {
      if (desc.includes('điện')) {
        electric = (it.unit_price || 0) * (it.quantity || 1);
        prev = Number(it.previous_reading) || 0;
        curr = it.current_reading == null ? null : Number(it.current_reading);
        continue;
      }
      if (desc.includes('nước')) {
        water = (it.unit_price || 0) * (it.quantity || 1);
        occupants = Number(it.quantity) || 1;
        continue;
      }
      if (desc.includes('dịch vụ') || desc.includes('phí dịch vụ')) {
        pdv = (it.unit_price || 0) * (it.quantity || 1);
        continue;
      }
    }
    // fallback: custom item
    custom.push({
      type: (it.type === 'SERVICE' ? 'SERVICE' : 'OTHER') as 'SERVICE' | 'OTHER',
      description: it.description,
      quantity: Number(it.quantity) || 1,
      unit_price: Number(it.unit_price) || 0,
      service_id: it.service_id,
    });
  }
  return { rent, electric, prev, curr, water, occupants, pdv, custom };
}

const EditInvoiceDialog = ({ open, onOpenChange, invoice }: EditInvoiceDialogProps) => {
  const updateMutation = useUpdateInvoice();
  const [meterId, setMeterId] = useState<string | null>(null);
  const [debtSources, setDebtSources] = useState<PreviousDebtSource[]>(
    Array.isArray(invoice.previous_debt_sources)
      ? (invoice.previous_debt_sources as PreviousDebtSource[])
      : [],
  );
  const [isLoadingDebt, setIsLoadingDebt] = useState(false);

  const decomposed = useMemo(() => decomposeItems(invoice), [invoice]);

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    control,
    reset,
  } = useForm<EditFormData>({
    resolver: zodResolver(editInvoiceSchema),
    defaultValues: {
      billing_month: invoice.billing_month,
      issue_date: invoice.issue_date,
      due_date: invoice.due_date,
      title: '',
      rent_price: decomposed.rent,
      occupants: decomposed.occupants,
      prev_reading: decomposed.prev,
      prev_reading_overridden: !!invoice.electricity_prev_overridden,
      current_reading: decomposed.curr,
      electric_amount: decomposed.electric,
      electric_overridden: true, // edit mode: respect existing value
      water_amount: decomposed.water,
      water_overridden: true,
      pdv_amount: decomposed.pdv,
      custom_items: decomposed.custom,
      notes: invoice.notes || '',
      discount_amount: invoice.discount_amount || 0,
      discount_notes: invoice.discount_notes || '',
      applied_credit: 0,
      previous_debt: invoice.previous_debt || 0,
      previous_debt_overridden: false,
    },
  });

  // Reset when invoice prop changes
  useEffect(() => {
    const d = decomposeItems(invoice);
    reset({
      billing_month: invoice.billing_month,
      issue_date: invoice.issue_date,
      due_date: invoice.due_date,
      title: '',
      rent_price: d.rent,
      occupants: d.occupants,
      prev_reading: d.prev,
      prev_reading_overridden: !!invoice.electricity_prev_overridden,
      current_reading: d.curr,
      electric_amount: d.electric,
      electric_overridden: true,
      water_amount: d.water,
      water_overridden: true,
      pdv_amount: d.pdv,
      custom_items: d.custom,
      notes: invoice.notes || '',
      discount_amount: invoice.discount_amount || 0,
      discount_notes: invoice.discount_notes || '',
      applied_credit: 0,
      previous_debt: invoice.previous_debt || 0,
      previous_debt_overridden: false,
    });
    // Sources gốc của HĐ — giữ nguyên nếu user không bấm "tính lại"/chỉnh tay,
    // để lần sửa HĐ KHÔNG âm thầm xoá link cascade tất toán HĐ cũ.
    setDebtSources(
      Array.isArray(invoice.previous_debt_sources)
        ? (invoice.previous_debt_sources as PreviousDebtSource[])
        : [],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice.id]);

  const { fields: customFields, append: appendCustom, remove: removeCustom } = useFieldArray({
    control,
    name: 'custom_items',
  });

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
  const watchedPreviousDebt = watch('previous_debt') || 0;

  // Tính lại nợ cũ từ các HĐ cũ chưa tất toán (loại chính HĐ đang sửa).
  const handleReloadPreviousDebt = async () => {
    if (!invoice.contract_id) return;
    setIsLoadingDebt(true);
    try {
      const { total, sources } = await computePreviousDebt(invoice.contract_id, {
        excludeInvoiceId: invoice.id,
      });
      setValue('previous_debt', total, { shouldDirty: true });
      setValue('previous_debt_overridden', false);
      setDebtSources(sources);
    } finally {
      setIsLoadingDebt(false);
    }
  };

  const { data: bldSvc } = useBuildingServices(invoice.building_id);
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

  // Load meter for room (chỉ số đầu)
  useEffect(() => {
    if (!invoice.room_id) {
      setMeterId(null);
      return;
    }
    (async () => {
      const { data: meters } = await supabase
        .from('meters')
        .select('id')
        .eq('room_id', invoice.room_id)
        .eq('meter_type', 'ELECTRICITY')
        .is('deleted_at', null)
        .limit(1);
      setMeterId((meters as any)?.[0]?.id ?? null);
    })();
  }, [invoice.room_id]);

  // Auto tính tiền điện theo chỉ số (chỉ khi user chưa override)
  useEffect(() => {
    if (watch('electric_overridden')) return;
    const consumption = Math.max(0, (Number(watchedCurrent) || 0) - watchedPrev);
    setValue('electric_amount', consumption * defaults.elec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedCurrent, watchedPrev, defaults.elec]);

  const subtotal =
    watchedRent +
    watchedElectric +
    watchedWater +
    watchedPDV +
    watchedCustomItems.reduce(
      (s, it) => s + (it.quantity || 0) * (it.unit_price || 0),
      0,
    );
  // total = tạm tính − giảm trừ + nợ cũ (KHỚP công thức save-side ở useUpdateInvoice).
  // làm tròn phần lẻ: <900đ → xuống, ≥900đ → lên bội số 1000 (khớp giá trị sẽ lưu)
  const totalAmount = roundInvoiceTotal(
    Math.max(0, subtotal - watchedDiscount + watchedPreviousDebt),
  );

  const { data: creditBalance = 0 } = useExcessAmount(invoice.contract_id);

  const onSubmit = (data: EditFormData) => {
    const periodStart = startOfMonth(parse(data.billing_month + '-01', 'yyyy-MM-dd', new Date()));
    const periodEnd = endOfMonth(periodStart);
    const fromDate = format(periodStart, 'yyyy-MM-dd');
    const toDate = format(periodEnd, 'yyyy-MM-dd');
    const consumption =
      (Number(data.current_reading) || 0) - (Number(data.prev_reading) || 0);

    const items: InvoiceFormData['items'] = [];
    let order = 0;
    items.push({
      type: 'RENT',
      description: `Tiền thuê`,
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

    const formData: InvoiceFormData = {
      building_id: invoice.building_id,
      room_id: invoice.room_id,
      contract_id: invoice.contract_id,
      billing_month: data.billing_month,
      issue_date: data.issue_date,
      due_date: data.due_date,
      notes: data.notes || null,
      discount_amount: data.discount_amount || 0,
      discount_notes: data.discount_notes?.trim() || null,
      applied_credit: 0,
      electricity_prev_overridden: !!data.prev_reading_overridden,
      prepaid_amount: invoice.prepaid_amount || 0,
      previous_debt: data.previous_debt || 0,
      // User chỉnh tay → clear sources để DB trigger KHÔNG cascade-paid sai
      // (amount không còn khớp tổng sources). Cùng quy ước với flow tạo HĐ.
      previous_debt_sources: data.previous_debt_overridden ? [] : debtSources,
      items,
    };

    updateMutation.mutate(
      { id: invoice.id, formData },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            Chỉnh sửa hoá đơn {invoice.invoice_number || ''}
          </DialogTitle>
          <DialogDescription>
            Cùng layout như tạo hoá đơn (Mode Excel — cho 1 phòng).
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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

          {/* Structured row */}
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-100">
                <tr className="text-xs uppercase">
                  <th className="p-2 border text-right">Giá phòng</th>
                  <th className="p-2 border text-right w-[80px]">Số người</th>
                  <th className="p-2 border text-right w-[110px]">Chỉ số đầu</th>
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
                            onClick={() => setValue('prev_reading_overridden', true)}
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
                      onChange={(v) => {
                        setValue('current_reading', v);
                        setValue('electric_overridden', false);
                      }}
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
            {creditBalance > 0 && (
              <p className="text-[11px] text-amber-700 text-right">
                Tiền nợ khách hiện có: {formatCurrency(creditBalance)}
              </p>
            )}
          </div>

          {/* Nợ cũ (khách nợ mình) */}
          <div className="bg-red-50 border border-red-200 p-3 rounded-md space-y-1">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="previous_debt" className="text-red-800 shrink-0">
                Nợ cũ kỳ trước:
              </Label>
              <div className="flex items-center gap-1 w-56">
                <CurrencyInput
                  className={`h-9 text-right ${watchedPreviousDebt > 0 ? 'text-red-700 font-medium' : ''}`}
                  suffix={false}
                  value={watchedPreviousDebt}
                  onChange={(v) => {
                    setValue('previous_debt', v, { shouldDirty: true });
                    setValue('previous_debt_overridden', true);
                  }}
                />
                <button
                  type="button"
                  title="Tính lại nợ cũ từ các hoá đơn cũ chưa tất toán"
                  onClick={handleReloadPreviousDebt}
                  className="text-slate-400 hover:text-amber-600 p-1 rounded"
                  disabled={!invoice.contract_id || isLoadingDebt}
                >
                  {isLoadingDebt ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
            {watch('previous_debt_overridden') ? (
              <p className="text-[11px] text-amber-700 text-right">
                Đã chỉnh tay — hoá đơn cũ sẽ KHÔNG tự tất toán khi thu đủ.
              </p>
            ) : debtSources.length > 0 ? (
              <ul className="text-[11px] text-red-700 space-y-0.5 pt-1">
                {debtSources.map((s, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="truncate">📄 {s.label}</span>
                    <span className="tabular-nums">{formatCurrency(s.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Hủy
            </Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Đang cập nhật...' : 'Cập nhật'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default EditInvoiceDialog;
