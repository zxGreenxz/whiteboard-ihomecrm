import { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm, type Path, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateInvoice, useExcessAmount } from '@/hooks/useInvoices';
import type { InvoiceFormData, PreviousDebtSource } from '@/types/invoice';
import { isContractInEffect } from '@/types/contract';
import { useContracts } from '@/hooks/useContracts';
import { useVehicles } from '@/hooks/useVehicles';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useBuildingServices } from '@/hooks/useBuildingServices';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from "@/lib/authSession";
import { useToast } from '@/hooks/use-toast';
import { computePreviousDebt, getContractDiscountSlot } from '@/lib/invoiceHelpers';
import { format, addMonths } from 'date-fns';
import { resolveInvoicePricing, type ContractServiceInput } from '@/lib/contractServicePricing';
import { todayISO } from '@/lib/collect';
import {
  buildInvoiceItems,
  firstEntryError,
  invoiceEntrySchema,
  makeEntryValues,
  resolveBuildingDefaults,
  type BuildingServiceRow,
  type InvoiceEntryValues,
} from '@/lib/invoiceEntry';
import { InvoiceEntryShell } from './invoice-entry/InvoiceEntryShell';
import { useInvoiceEntry } from './invoice-entry/useInvoiceEntry';
import type { InvoiceEntrySelectors, InvoiceEntryVariant } from './invoice-entry/types';

interface GenerateInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const createInvoiceSchema = invoiceEntrySchema.extend({
  contract_id: z.string().min(1, 'Vui lòng chọn hợp đồng'),
});

type CreateInvoiceValues = InvoiceEntryValues & { contract_id: string };

/** Hình dạng HĐ trả về từ useContracts (CONTRACT_DIALOG_SELECT) — chỉ các cột dialog dùng. */
interface ContractOption {
  id: string;
  status: string;
  contract_number?: string | null;
  rent_price?: number | string | null;
  total_deposit?: number | string | null;
  room_id?: string | null;
  room?: {
    id: string;
    name: string;
    building_id: string;
    building?: { name?: string | null } | null;
  } | null;
  contract_customers?: Array<{
    is_representative?: boolean | null;
    customer?: { full_name?: string | null } | null;
  }>;
  contract_services?: ContractServiceInput[] | null;
}
interface NamedRow { id: string; name: string }
interface VehicleRow { parking_fee?: number | string | null; license_plate?: string | null; vehicle_type?: string | null }

const initialValues = (): CreateInvoiceValues => ({
  ...makeEntryValues({
    issue_date: todayISO(),
    // format() của date-fns đọc theo giờ LOCAL; toISOString() thì đổi sang UTC
    // rồi cắt, nên trước 7h sáng giờ VN sẽ ra ngày hôm trước.
    due_date: format(addMonths(new Date(), 1), 'yyyy-MM-dd'),
    billing_month: format(new Date(), 'yyyy-MM'),
  }),
  contract_id: '',
});

const SELECT_TRIGGER: Record<InvoiceEntryVariant, string> = {
  desktop: 'h-8 rounded-md border-[hsl(210_20%_88%)] bg-white px-1.5 text-[13px] font-semibold',
  mobile: 'ien-in',
};

/**
 * Tạo hoá đơn lẻ cho một hợp đồng — dùng bộ nhập liệu chung với "Sửa hoá đơn".
 * Giá trị nạp từ hợp đồng/đơn giá toà là "giá trị gốc" để đánh dấu ô đã đổi và
 * để nút "Về giá trị gốc" quay lại.
 */
const GenerateInvoiceDialog = ({ open, onOpenChange }: GenerateInvoiceDialogProps) => {
  const [filterBuildingId, setFilterBuildingId] = useState<string>('');
  const [filterRoomId, setFilterRoomId] = useState<string>('');
  const [meterId, setMeterId] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<InvoiceEntryValues>(() => initialValues());
  const [debtSources, setDebtSources] = useState<PreviousDebtSource[]>([]);

  const createMutation = useCreateInvoice();
  const { toast } = useToast();
  // Chỉ kéo HĐ ACTIVE server-side — dialog lập hoá đơn không cần HĐ đã thanh
  // lý/nháp (filter client giữ lại như chốt chặn phụ).
  // enabled: open — dialog mounted sẵn (đóng) không fetch, đỡ kéo cả bảng HĐ
  // full-PII mỗi lần tải trang /invoices.
  const { data: contractsData } = useContracts({ statuses: ['ACTIVE'], enabled: open });
  const allActiveContracts = ((contractsData ?? []) as unknown as ContractOption[]).filter((c) => isContractInEffect(c.status));
  const contracts = allActiveContracts.filter((c) => {
    if (filterBuildingId && c.room?.building_id !== filterBuildingId) return false;
    if (filterRoomId && c.room_id !== filterRoomId) return false;
    return true;
  });
  const { data: buildings = [] } = useBuildings({ enabled: open });
  const { data: rooms = [] } = useRooms(filterBuildingId || undefined, {
    enabled: open,
  });

  const form = useForm<CreateInvoiceValues>({
    resolver: zodResolver(createInvoiceSchema) as Resolver<CreateInvoiceValues>,
    defaultValues: initialValues(),
  });
  const {
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
  } = form;

  /** Nạp giá trị tự động: vừa ghi vào form, vừa ghi vào "giá trị gốc". */
  const seed = useCallback(
    (patch: Partial<InvoiceEntryValues>) => {
      for (const [key, value] of Object.entries(patch)) {
        setValue(key as Path<CreateInvoiceValues>, value as never);
      }
      setBaseline((b) => ({ ...b, ...patch }));
    },
    [setValue],
  );

  const watchedContractId = watch('contract_id');
  const watchedBillingMonth = watch('billing_month') || '';
  const watchedDiscount = watch('discount_amount') || 0;

  const selectedContract = contracts?.find((c) => c.id === watchedContractId);
  const buildingIdOfContract = selectedContract?.room?.building_id || '';
  const { data: bldSvc } = useBuildingServices(buildingIdOfContract);
  // Chỉ fetch xe của HĐ đã chọn — trước đây khi chưa chọn HĐ fetch TOÀN BỘ xe
  // (count exact) ngay lúc tải trang dù dialog đang đóng.
  const { data: vehiclesData } = useVehicles(
    watchedContractId ? { contract_id: watchedContractId } : undefined,
    undefined,
    { enabled: open && !!watchedContractId },
  );
  const vehicles = vehiclesData?.data ?? [];

  // Lấy đơn giá mặc định từ building_services (giống ExcelInvoiceDialog).
  const defaults = useMemo(
    () => resolveBuildingDefaults(bldSvc as BuildingServiceRow[] | undefined),
    [bldSvc],
  );

  // Đơn giá hiệu lực = ưu tiên dịch vụ HĐ đã đăng ký, fallback đơn giá toà.
  // HĐ có cấu hình dịch vụ riêng → nước/PDV CHỈ áp khi HĐ liệt kê (không thì
  // không tự bỏ vào hoá đơn). Điện lấy đúng loại + đơn giá của HĐ (vd 3K1).
  const pricing = useMemo(
    () =>
      resolveInvoicePricing(selectedContract?.contract_services ?? undefined, defaults),
    [selectedContract, defaults],
  );

  // Khi chọn HĐ: load rent_price, occupants, meter prev_reading; prefill nước+PDV.
  useEffect(() => {
    if (!selectedContract) return;
    const occ = selectedContract.contract_customers?.length || 1;
    seed({
      rent_price: Number(selectedContract.rent_price) || 0,
      occupants: occ,
      current_reading: null,
      prev_reading_overridden: false,
      electric_amount: 0,
      electric_overridden: false,
      water_amount: pricing.waterApplicable ? occ * pricing.water : 0,
      water_overridden: false,
      pdv_amount: pricing.pdvApplicable ? pricing.pdv : 0,
    });

    // Load meter điện cho phòng + chỉ số đầu (latest APPROVED).
    const roomId = selectedContract.room_id;
    if (roomId) {
      (async () => {
        const { data: meters } = await supabase
          .from('meters')
          .select('id')
          .eq('room_id', roomId)
          .eq('meter_type', 'ELECTRICITY')
          .is('deleted_at', null)
          .limit(1);
        const mid = (meters as Array<{ id: string }> | null)?.[0]?.id ?? null;
        setMeterId(mid);
        if (mid) {
          const { data: readings } = await supabase
            .from('meter_readings')
            .select('current_reading, reading_date')
            .eq('meter_id', mid)
            .eq('status', 'APPROVED')
            .is('deleted_at', null)
            .order('reading_date', { ascending: false })
            .limit(1);
          seed({ prev_reading: Number((readings as Array<{ current_reading: number | string | null }> | null)?.[0]?.current_reading) || 0 });
        } else {
          seed({ prev_reading: 0 });
        }
      })();
    } else {
      setMeterId(null);
      seed({ prev_reading: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedContract?.id,
    pricing.water,
    pricing.pdv,
    pricing.waterApplicable,
    pricing.pdvApplicable,
  ]);

  // Auto-fill vehicle parking fees vào custom_items khi đổi HĐ.
  useEffect(() => {
    if (!selectedContract) return;
    const next = (vehicles as VehicleRow[])
      .filter((v) => Number(v.parking_fee) > 0)
      .map((v) => ({
        type: 'SERVICE' as const,
        accounting_class: 'REVENUE' as const,
        description: `Phí gửi xe ${v.license_plate || v.vehicle_type}`,
        quantity: 1,
        unit_price: Number(v.parking_fee) || 0,
      }));
    seed({ custom_items: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedContract?.id, vehicles.length]);

  // Auto chọn hợp đồng khi đã có toà + phòng. Nếu có nhiều HĐ ACTIVE cùng
  // phòng → để trống và cảnh báo đỏ user phải tự chọn.
  const matchingContracts = useMemo(() => {
    if (!filterBuildingId || !filterRoomId) return [];
    return allActiveContracts.filter(
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

  // Pre-check: HĐ + kỳ đã có invoice "đang hoạt động" (chưa huỷ, chưa xoá) chưa?
  // Tránh hit unique constraint khi submit. HĐ đã huỷ KHÔNG block tạo lại — khớp
  // partial unique index `deleted_at IS NULL AND status <> CANCELLED`.
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
        .neq('status', 'CANCELLED')
        // Hoá đơn THANH LÝ (kind SETTLEMENT) được phép chung tháng — không block.
        .eq('kind', 'MONTHLY')
        .limit(1)
        .maybeSingle();
      return data ?? null;
    },
  });

  // Nợ cũ — auto-fill khi đổi contract; user chỉnh tay sẽ set overridden, không ghi đè.
  const {
    data: previousDebtBreakdown,
    isFetching: isLoadingDebt,
    refetch: refetchDebt,
  } = useQuery({
    queryKey: ['compute-previous-debt', watchedContractId],
    enabled: !!watchedContractId,
    queryFn: () => computePreviousDebt(watchedContractId),
    staleTime: 5_000,
  });

  useEffect(() => {
    if (!watchedContractId) return;
    if (!previousDebtBreakdown) return;
    if (watch('previous_debt_overridden')) return;
    seed({ previous_debt: previousDebtBreakdown.total });
    setDebtSources(previousDebtBreakdown.sources);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedContractId, previousDebtBreakdown]);

  const handleReloadPreviousDebt = async () => {
    const { data } = await refetchDebt();
    if (data) {
      seed({ previous_debt: data.total, previous_debt_overridden: false });
      setDebtSources(data.sources);
    }
  };

  // Credit auto-fill discount + Khuyến mãi HĐ (tháng X/Y).
  const { data: creditBalance = 0 } = useExcessAmount(watchedContractId);
  const { data: discountSlot } = useQuery({
    queryKey: ['contract-discount-slot', watchedContractId],
    enabled: !!watchedContractId,
    queryFn: () => getContractDiscountSlot(watchedContractId),
    staleTime: 5_000,
  });

  useEffect(() => {
    if (!watchedContractId) return;
    if (watchedDiscount > 0) return; // user đã chỉnh hoặc đã auto-fill rồi
    const promoAmount = discountSlot?.applicable ? discountSlot.amountPerMonth : 0;
    const promoNote = discountSlot?.applicable ? discountSlot.label : '';
    const creditAmount = creditBalance > 0 ? creditBalance : 0;
    const creditNote =
      creditAmount > 0 ? `Nợ ${creditAmount.toLocaleString('vi-VN')} Tiền Thối` : '';

    const total = promoAmount + creditAmount;
    if (total <= 0) return;

    const notes = [promoNote, creditNote].filter(Boolean).join(' — ');
    seed({ discount_amount: total, discount_notes: notes, applied_credit: creditAmount });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedContractId, creditBalance, discountSlot?.applicable]);

  const ctl = useInvoiceEntry(form, { baseline, pricing, active: !!selectedContract });

  const handleClose = () => {
    reset(initialValues());
    setBaseline(initialValues());
    setDebtSources([]);
    setFilterBuildingId('');
    setFilterRoomId('');
    setMeterId(null);
    onOpenChange(false);
  };

  const onSubmit = async (data: CreateInvoiceValues) => {
    if (!selectedContract) return;
    const roomData = selectedContract.room;
    const buildingId = roomData?.building_id || '';
    const roomId = roomData?.id || '';
    if (!buildingId || !roomId) return;

    // 1) Ghi chỉ số mới (nếu user nhập) — APPROVED ngay.
    //    Skip nếu đã có chỉ số APPROVED cho meter này trong cùng kỳ
    //    (tránh 409 do unique reading_code / chỉ số trùng).
    const consumption =
      (Number(data.current_reading) || 0) - (Number(data.prev_reading) || 0);
    // [A5] Lý do KHÔNG chốt được chỉ số. Cố ý KHÔNG toast ở đây: hoá đơn mãi
    // tới dòng createMutation.mutate bên dưới mới được tạo, và nó vẫn có thể
    // fail (unique billing_month / RLS). Báo ở đây là nói sai "đã tạo hoá đơn".
    let readingWarn: string | null = null;
    if (meterId && data.current_reading != null && consumption >= 0) {
      const { data: existing } = await supabase
        .from('meter_readings')
        .select('id')
        .eq('meter_id', meterId)
        .eq('settlement_month', data.billing_month)
        .is('deleted_at', null)
        .limit(1);
      if (!existing || existing.length === 0) {
        const user = await getSessionUser();
        if (!user) {
          // Trước đây im lặng tuyệt đối. Nhánh này hoá đơn cũng sẽ fail
          // (useCreateInvoice tự getSessionUser rồi throw 'Not authenticated'),
          // nên toast không bao giờ chạy — vẫn ghi log để còn dấu vết.
          console.error('Skip ghi chỉ số: không lấy được phiên đăng nhập');
        } else {
          const { error: readingErr } = await supabase
            .from('meter_readings')
            .insert({
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
              service_id: pricing.elecServiceId,
              recorded_by: user.id,
            } as any);
          if (readingErr) {
            console.error('Ghi chỉ số điện thất bại:', readingErr);
            readingWarn = readingErr.message;
          }
        }
      }
    } else if (data.current_reading != null && Number(data.current_reading) > 0) {
      // Có nhập chỉ số nhưng không chốt được. Hai nhánh này trước đây im lặng
      // tuyệt đối — không cả console.warn — nên hoá đơn và sổ chỉ số lệch nhau
      // mà không ai biết.
      readingWarn = !meterId
        ? 'phòng chưa gắn công tơ điện'
        : 'chỉ số mới nhỏ hơn chỉ số cũ';
    }

    // 2) Build items — prorate rent + nước + PDV khi có ngày thuê thực tế.
    const items = buildInvoiceItems(data, {
      elecServiceId: pricing.elecServiceId,
      waterServiceId: pricing.waterServiceId,
      pdvServiceId: pricing.pdvServiceId,
      rentDescription: `Tiền thuê căn hộ ${roomData?.name || ''}`.trim(),
    });

    const discountAmount = data.discount_amount || 0;
    const appliedCredit = Math.min(
      Math.max(0, data.applied_credit || 0),
      Math.max(0, discountAmount),
    );

    const invoiceFormData: InvoiceFormData = {
      building_id: buildingId,
      room_id: roomId,
      contract_id: data.contract_id,
      billing_month: data.billing_month,
      issue_date: data.issue_date,
      due_date: data.due_date,
      notes: data.notes || null,
      discount_amount: discountAmount,
      discount_notes: data.discount_notes?.trim() || null,
      applied_credit: appliedCredit,
      electricity_prev_overridden: !!data.prev_reading_overridden,
      prepaid_amount: 0,
      previous_debt: data.previous_debt || 0,
      // User chỉnh tay → clear sources để trigger DB không cascade-paid sai.
      previous_debt_sources: data.previous_debt_overridden ? [] : debtSources,
      items,
    };

    createMutation.mutate(invoiceFormData, {
      onSuccess: () => {
        // [A5] Chỉ báo SAU khi hoá đơn đã tạo thật, nên câu "đã tạo hoá đơn" là
        // đúng. TOAST_LIMIT = 1 (use-toast.ts) nên toast destructive này chiếm
        // chỗ toast thành công phát trước đó — cảnh báo thắng, đúng như luồng
        // Excel đã làm (ExcelInvoiceDialog.tsx:207-213).
        if (readingWarn) {
          toast({
            variant: 'destructive',
            title: 'Chưa lưu được chỉ số điện',
            description:
              `Đã tạo hoá đơn nhưng KHÔNG lưu được chỉ số điện (${readingWarn}). ` +
              'Tiền điện trên hoá đơn và sổ chỉ số đang lệch nhau — vui lòng ghi chỉ số thủ công.',
          });
        }
        handleClose();
      },
    });
  };

  const selectors = (variant: InvoiceEntryVariant): InvoiceEntrySelectors => {
    const trigger = SELECT_TRIGGER[variant];
    return {
      building: (
        <Select
          value={filterBuildingId || '__all__'}
          onValueChange={(value) => {
            const next = value === '__all__' ? '' : value;
            setFilterBuildingId(next);
            setFilterRoomId('');
            setValue('contract_id', '');
          }}
        >
          <SelectTrigger className={trigger} aria-label="Toà nhà">
            <SelectValue placeholder="Tất cả toà nhà" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Tất cả toà nhà</SelectItem>
            {(buildings as NamedRow[]).map((b) => (
              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
      room: (
        <Select
          value={filterRoomId || '__all__'}
          onValueChange={(value) => {
            const next = value === '__all__' ? '' : value;
            setFilterRoomId(next);
            setValue('contract_id', '');
          }}
          disabled={!filterBuildingId}
        >
          <SelectTrigger className={trigger} aria-label="Phòng">
            <SelectValue placeholder={filterBuildingId ? 'Tất cả phòng' : 'Chọn toà trước'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Tất cả phòng</SelectItem>
            {(rooms as NamedRow[]).map((r) => (
              <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
      contract: (
        <Select
          value={watchedContractId || ''}
          onValueChange={(value) => setValue('contract_id', value, { shouldValidate: true })}
        >
          <SelectTrigger className={trigger} aria-label="Hợp đồng">
            <SelectValue placeholder="Chọn hợp đồng..." />
          </SelectTrigger>
          <SelectContent>
            {contracts.map((contract) => {
              const rep =
                contract.contract_customers?.find((cc) => cc.is_representative) ||
                contract.contract_customers?.[0];
              const customerName = rep?.customer?.full_name ?? '';
              return (
                <SelectItem key={contract.id} value={contract.id}>
                  {contract.contract_number || contract.id.slice(0, 8)}
                  {customerName && ` - ${customerName}`}
                  {contract.room && ` - ${contract.room.name}`}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      ),
    };
  };

  const selectedRoom = selectedContract?.room;
  const repCustomer =
    selectedContract?.contract_customers?.find((cc) => cc.is_representative) ||
    selectedContract?.contract_customers?.[0];
  const buildingName: string =
    selectedRoom?.building?.name ||
    (buildings as NamedRow[]).find((b) => b.id === selectedRoom?.building_id)?.name ||
    '';

  return (
    <InvoiceEntryShell
      open={open}
      onOpenChange={handleClose}
      onSubmit={handleSubmit(onSubmit)}
      mode="create"
      ctl={ctl}
      header={{
        title: 'Tạo hoá đơn lẻ',
        invoiceNo: 'Hoá đơn mới',
        building: buildingName,
        room: selectedRoom?.name || '',
        rep: repCustomer?.customer?.full_name || '',
        lockNote: 'Chọn hợp đồng để nạp giá phòng, chỉ số điện và đơn giá dịch vụ.',
      }}
      selectors={selectors}
      selectorsNotice={
        errors.contract_id?.message ||
        (multipleContractsWarning
          ? `Phòng này đang có ${matchingContracts.length} hợp đồng còn hiệu lực — vui lòng tự chọn đúng hợp đồng cần lập hoá đơn.`
          : null)
      }
      duplicate={
        existingInvoice
          ? {
              period: watchedBillingMonth,
              invoiceNo: existingInvoice.invoice_number || existingInvoice.id?.slice(0, 8) || '',
            }
          : null
      }
      pricing={pricing}
      meterId={meterId}
      debt={{
        sources: debtSources,
        loading: isLoadingDebt,
        canReload: !!watchedContractId,
        onReload: handleReloadPreviousDebt,
      }}
      creditBalance={watchedContractId ? creditBalance : 0}
      defaultDepositAmount={Number(selectedContract?.total_deposit) || 0}
      ready={!!selectedContract}
      validationError={firstEntryError(errors)}
      onResetAll={() => reset({ ...baseline, contract_id: watchedContractId })}
      onCancel={handleClose}
      footNote="Hoá đơn mới tạo ở trạng thái nháp, chờ duyệt."
      submit={{
        label: 'Tạo hoá đơn',
        pendingLabel: 'Đang tạo...',
        pending: createMutation.isPending,
        disabled: !selectedContract || !!existingInvoice,
      }}
    />
  );
};

export default GenerateInvoiceDialog;
