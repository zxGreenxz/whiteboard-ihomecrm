import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, addMonths, endOfMonth, startOfMonth, parse } from 'date-fns';
import { Table as TableIcon, Download, Loader2, Pencil, RotateCcw } from 'lucide-react';
import { DiscountNoteTrigger } from './DiscountNoteTrigger';
import { calcProratedDays, prorateAmount } from '@/lib/prorateCalculation';
import { resolveInvoicePricing, type ContractServiceInput } from '@/lib/contractServicePricing';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { PREVIOUS_DEBT_ROUND_THRESHOLD } from '@/lib/invoiceHelpers';
import { getInvoiceTitle } from '@/lib/invoiceUtils';
import { formatCurrency } from '@/lib/utils';
import type { PreviousDebtSource } from '@/types/invoice';

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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useBuildings } from '@/hooks/useBuildings';
import { useBuildingServices } from '@/hooks/useBuildingServices';
import { useCreateInvoice } from '@/hooks/useInvoices';
import { supabase } from '@/integrations/supabase/client';
import type { InvoiceFormData } from '@/types/invoice';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface RowData {
  contract_id: string;
  room_id: string;
  room_name: string;
  rent_price: number;
  occupants: number;
  meter_id: string | null;
  prev_reading: number;
  prev_reading_overridden: boolean;
  current_reading: number | '';
  electric_amount: number; // overrideable
  electric_overridden: boolean;
  water_amount: number; // overrideable
  water_overridden: boolean;
  pdv_amount: number; // overrideable
  pdv_overridden: boolean;
  /**
   * Đơn giá + service_id hiệu lực cho từng phòng — ưu tiên dịch vụ HĐ đăng ký
   * (vd "Điện 3K1"), fallback đơn giá toà khi HĐ chưa cấu hình. *_applicable =
   * false nghĩa HĐ KHÔNG đăng ký dịch vụ đó → không tự bỏ vào hoá đơn.
   */
  elec_rate: number;
  elec_service_id: string | null;
  water_rate: number;
  water_service_id: string | null;
  water_applicable: boolean;
  pdv_rate: number;
  pdv_service_id: string | null;
  pdv_applicable: boolean;
  /** contract_services thô — để re-resolve khi đơn giá toà load sau. */
  services_raw: ContractServiceInput[];
  discount: number;
  discount_notes: string;
  /** Credit (excess_amounts) đã áp vào discount — INSERT excess row âm khi tạo HĐ. */
  applied_credit: number;
  /** Tiền nợ khách hiện có của contract (audit hint, không bao giờ ghi vào DB). */
  credit_balance: number;
  /** Nợ cũ (khách nợ mình) — auto từ HĐ chưa thu + cọc thiếu. */
  previous_debt: number;
  /** Auto-fill từ DB; user có thể override (-) hoặc reload từ DB. */
  previous_debt_sources: PreviousDebtSource[];
  previous_debt_overridden: boolean;
  /** Ngày bắt đầu/kết thúc thực tế — nếu set thì prorate rent + water + pdv. */
  period_start_date: string | null;
  period_end_date: string | null;
  selected: boolean;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('vi-VN').format(Math.round(n || 0));

export default function ExcelInvoiceDialog({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const { data: buildings } = useBuildings();
  const createInvoice = useCreateInvoice();

  const [buildingId, setBuildingId] = useState('');
  const [billingMonth, setBillingMonth] = useState(format(new Date(), 'yyyy-MM'));
  const [issueDate, setIssueDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [dueDate, setDueDate] = useState(format(addMonths(new Date(), 1), 'yyyy-MM-dd'));
  const [rows, setRows] = useState<RowData[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [prorateRowIdx, setProrateRowIdx] = useState<number | null>(null);

  const { data: bldSvc } = useBuildingServices(buildingId);

  // Resolve default prices from building_services (fall back to service.unit_price).
  // Chỉ xét dịch vụ đang BẬT cho toà — nếu không có thì giữ fallback hard-code.
  // Tránh bug: nhiều dịch vụ điện cùng tên kiểu "Điện 3k5"/"Điện MB405" sẽ
  // ghi đè lẫn nhau và lấy phải cái đã tắt.
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

  // Load rooms + active contracts + meters + last reading for the building.
  const handleLoad = async () => {
    if (!buildingId) return;
    setLoaded(false);
    try {
      // 1) Active contracts in this building (via room → building).
      const { data: contracts, error: e1 } = await (supabase as any)
        .from('contracts')
        .select(
          `id, rent_price, room_id, status, total_deposit, deposit_paid, deposit_remaining, discounts, start_date, created_at,
           room:rooms!contracts_room_id_fkey (id, name, building_id),
           contract_customers!contract_customers_contract_id_fkey (id),
           contract_services (
             service_id, unit_price,
             service:services!contract_services_service_id_fkey (name, pricing_type)
           )`
        )
        .eq('status', 'ACTIVE')
        .is('deleted_at', null);
      if (e1) throw e1;
      const buildingContractsRaw = (contracts || []).filter(
        (c: any) => c.room?.building_id === buildingId
      );
      // Gom theo phòng: mỗi phòng chỉ lập hoá đơn cho 1 HĐ. Nếu phòng có >1 HĐ
      // ACTIVE (dữ liệu lỗi — HĐ cũ chưa thanh lý), giữ HĐ mới nhất (start_date
      // desc, tie-break created_at desc) để không lập hoá đơn nhân đôi, rồi cảnh báo.
      const byRoom = new Map<string, any>();
      const dupRoomNames = new Set<string>();
      const pickNewer = (a: any, b: any) => {
        const sa = a.start_date ?? '';
        const sb = b.start_date ?? '';
        if (sa !== sb) return sa > sb ? a : b;
        return (a.created_at ?? '') >= (b.created_at ?? '') ? a : b;
      };
      for (const c of buildingContractsRaw) {
        const existing = byRoom.get(c.room_id);
        if (!existing) {
          byRoom.set(c.room_id, c);
          continue;
        }
        dupRoomNames.add(c.room?.name ?? existing.room?.name ?? '?');
        byRoom.set(c.room_id, pickNewer(existing, c));
      }
      const buildingContracts = Array.from(byRoom.values());
      if (dupRoomNames.size > 0) {
        const names = Array.from(dupRoomNames).sort((a, b) =>
          a.localeCompare(b, 'vi', { numeric: true })
        );
        toast({
          variant: 'destructive',
          title: 'Phòng có nhiều hợp đồng hiệu lực',
          description: `Phòng ${names.join(', ')} đang có 2 hợp đồng hiệu lực — đã chọn HĐ mới nhất để lập hoá đơn. Vui lòng thanh lý hợp đồng cũ.`,
        });
      }

      // 2) Electricity meters in this building.
      const { data: meters } = await supabase
        .from('meters')
        .select('id, room_id, meter_type')
        .eq('building_id', buildingId)
        .eq('meter_type', 'ELECTRICITY')
        .is('deleted_at', null);
      const meterByRoom = new Map<string, string>();
      (meters || []).forEach((m: any) => {
        if (m.room_id) meterByRoom.set(m.room_id, m.id);
      });

      // 3) Latest APPROVED reading per meter.
      const meterIds = (meters || []).map((m: any) => m.id);
      const lastReading = new Map<string, number>();
      if (meterIds.length > 0) {
        const { data: readings } = await (supabase as any)
          .from('meter_readings')
          .select('meter_id, current_reading, reading_date')
          .in('meter_id', meterIds)
          .eq('status', 'APPROVED')
          .is('deleted_at', null)
          .order('reading_date', { ascending: false });
        for (const r of readings || []) {
          if (!lastReading.has(r.meter_id)) {
            lastReading.set(r.meter_id, Number(r.current_reading) || 0);
          }
        }
      }

      // 4) Credit (excess_amounts) per contract — auto fill vào "Giảm trừ".
      const contractIds = buildingContracts.map((c: any) => c.id);
      const creditByContract = new Map<string, number>();
      if (contractIds.length > 0) {
        const { data: credits } = await (supabase as any)
          .from('excess_amounts')
          .select('contract_id, amount, source_invoice:invoices!source_invoice_id(deleted_at)')
          .in('contract_id', contractIds);
        for (const row of credits || []) {
          if (row.source_invoice?.deleted_at) continue;
          const prev = creditByContract.get(row.contract_id) || 0;
          creditByContract.set(row.contract_id, prev + (Number(row.amount) || 0));
        }
      }

      // 5b) Đếm số HĐ đã có (active) per contract — để biết slot khuyến mãi
      //     kế tiếp (1/Y, 2/Y, …) cho từng phòng.
      const invoiceCountByContract = new Map<string, number>();
      if (contractIds.length > 0) {
        const { data: allInvoices } = await (supabase as any)
          .from('invoices')
          .select('id, contract_id')
          .in('contract_id', contractIds)
          .is('deleted_at', null)
          .neq('status', 'CANCELLED');
        for (const inv of allInvoices || []) {
          invoiceCountByContract.set(
            inv.contract_id,
            (invoiceCountByContract.get(inv.contract_id) || 0) + 1,
          );
        }
      }

      // 5) Nợ cũ (khách nợ mình) per contract: HĐ APPROVED/PARTIAL_PAID/OVERDUE chưa tất toán + cọc còn thiếu.
      const previousDebtByContract = new Map<string, { total: number; sources: PreviousDebtSource[] }>();
      // carriedInvoiceIds per contract: HĐ đã được HĐ khác carry-over → bỏ.
      // depositCarriedByContract: contract đã có HĐ mở gánh cọc → bỏ cọc.
      const carriedInvoiceIdsByContract = new Map<string, Set<string>>();
      const depositCarriedByContract = new Set<string>();
      let oldInvoicesData: any[] = [];
      if (contractIds.length > 0) {
        const { data: oldInvoices } = await (supabase as any)
          .from('invoices')
          .select(`
            id, invoice_number, billing_month, total_amount, paid_amount, contract_id, status, notes,
            previous_debt_sources,
            room:rooms!invoices_room_id_fkey (id, name),
            building:buildings!invoices_building_id_fkey (id, name),
            invoice_items (id, type, description)
          `)
          .in('contract_id', contractIds)
          .in('status', ['APPROVED', 'PARTIAL_PAID', 'OVERDUE'])
          .is('deleted_at', null);
        oldInvoicesData = oldInvoices || [];
        // Pass 1: build carryover map.
        for (const inv of oldInvoicesData) {
          const srcs = Array.isArray(inv.previous_debt_sources) ? inv.previous_debt_sources : [];
          for (const s of srcs) {
            if (s?.type === 'invoice' && s?.id) {
              const set = carriedInvoiceIdsByContract.get(inv.contract_id) || new Set<string>();
              set.add(String(s.id));
              carriedInvoiceIdsByContract.set(inv.contract_id, set);
            }
            if (s?.type === 'deposit') {
              depositCarriedByContract.add(inv.contract_id);
            }
          }
        }
        // Pass 2: push as sources, skip carried.
        for (const inv of oldInvoicesData) {
          const carried = carriedInvoiceIdsByContract.get(inv.contract_id);
          if (carried?.has(String(inv.id))) continue;
          const remaining = (Number(inv.total_amount) || 0) - (Number(inv.paid_amount) || 0);
          if (remaining < PREVIOUS_DEBT_ROUND_THRESHOLD) continue;
          const label = getInvoiceTitle(inv);
          const entry = previousDebtByContract.get(inv.contract_id) || { total: 0, sources: [] };
          entry.sources.push({ type: 'invoice', id: inv.id, amount: remaining, label });
          entry.total += remaining;
          previousDebtByContract.set(inv.contract_id, entry);
        }
      }
      // Cộng cọc còn thiếu — skip nếu đã được HĐ khác gánh.
      for (const c of buildingContracts) {
        if (depositCarriedByContract.has(c.id)) continue;
        const depositRemaining = Number(
          c.deposit_remaining ?? ((Number(c.total_deposit) || 0) - (Number(c.deposit_paid) || 0))
        );
        if (depositRemaining < PREVIOUS_DEBT_ROUND_THRESHOLD) continue;
        const entry = previousDebtByContract.get(c.id) || { total: 0, sources: [] };
        entry.sources.push({
          type: 'deposit',
          contract_id: c.id,
          amount: depositRemaining,
          label: 'Cọc còn thiếu',
        });
        entry.total += depositRemaining;
        previousDebtByContract.set(c.id, entry);
      }

      const next: RowData[] = buildingContracts
        .map((c: any) => {
          const occupants = c.contract_customers?.length ?? 1;
          const meterId = meterByRoom.get(c.room_id) ?? null;
          const prev = meterId ? lastReading.get(meterId) ?? 0 : 0;
          const credit = Math.max(0, creditByContract.get(c.id) || 0);
          const debtEntry = previousDebtByContract.get(c.id);
          const previousDebt = debtEntry?.total ?? 0;
          const previousDebtSources = debtEntry?.sources ?? [];

          // Khuyến mãi HĐ (tháng X/Y): slot = số HĐ đã có + 1.
          const promoMonths = Number((c.discounts as any)?.months) || 0;
          const promoPer = Number((c.discounts as any)?.amount_per_month) || 0;
          const used = invoiceCountByContract.get(c.id) || 0;
          const slotIndex = used + 1;
          const promoApplicable =
            promoMonths > 0 && promoPer > 0 && slotIndex <= promoMonths;
          const promoAmount = promoApplicable ? promoPer : 0;
          const promoNote = promoApplicable
            ? `Khuyến mãi HĐ — tháng ${slotIndex}/${promoMonths} × ${promoPer.toLocaleString('vi-VN')}đ`
            : '';

          const totalDiscount = credit + promoAmount;
          const noteParts = [
            promoNote,
            credit > 0 ? `Nợ ${credit.toLocaleString('vi-VN')} Tiền Thối` : '',
          ].filter(Boolean);
          const combinedNotes = noteParts.join(' — ');

          // Đơn giá hiệu lực cho phòng: ưu tiên dịch vụ HĐ đăng ký (vd "Điện
          // 3K1"); HĐ không có nước/PDV → không prefill các khoản đó.
          const servicesRaw = (c.contract_services ?? []) as ContractServiceInput[];
          const pricing = resolveInvoicePricing(servicesRaw, defaults);

          return {
            contract_id: c.id,
            room_id: c.room_id,
            room_name: c.room?.name ?? '?',
            rent_price: Number(c.rent_price) || 0,
            occupants,
            meter_id: meterId,
            prev_reading: prev,
            prev_reading_overridden: false,
            current_reading: '' as const,
            electric_amount: 0,
            electric_overridden: false,
            water_amount: pricing.waterApplicable ? occupants * pricing.water : 0,
            water_overridden: false,
            pdv_amount: pricing.pdvApplicable ? pricing.pdv : 0,
            pdv_overridden: false,
            elec_rate: pricing.elec,
            elec_service_id: pricing.elecServiceId,
            water_rate: pricing.water,
            water_service_id: pricing.waterServiceId,
            water_applicable: pricing.waterApplicable,
            pdv_rate: pricing.pdv,
            pdv_service_id: pricing.pdvServiceId,
            pdv_applicable: pricing.pdvApplicable,
            services_raw: servicesRaw,
            discount: totalDiscount,
            discount_notes: combinedNotes,
            applied_credit: credit,
            credit_balance: credit,
            previous_debt: previousDebt,
            previous_debt_sources: previousDebtSources,
            previous_debt_overridden: false,
            period_start_date: null,
            period_end_date: null,
            selected: true,
          };
        })
        .sort((a: RowData, b: RowData) =>
          a.room_name.localeCompare(b.room_name, 'vi', { numeric: true })
        );
      setRows(next);
      setLoaded(true);
    } catch (err: any) {
      console.error(err);
      toast({
        variant: 'destructive',
        title: 'Lỗi tải dữ liệu',
        description: err.message || 'Không tải được danh sách phòng',
      });
    }
  };

  // Re-resolve đơn giá khi building_services load sau handleLoad. Re-resolve
  // theo từng dòng (HĐ có dịch vụ riêng giữ nguyên giá HĐ; HĐ legacy nhận giá
  // toà mới). Tôn trọng override tay của user.
  useEffect(() => {
    if (!loaded) return;
    setRows((prev) =>
      prev.map((r) => {
        const p = resolveInvoicePricing(r.services_raw, defaults);
        return {
          ...r,
          elec_rate: p.elec,
          elec_service_id: p.elecServiceId,
          water_rate: p.water,
          water_service_id: p.waterServiceId,
          water_applicable: p.waterApplicable,
          pdv_rate: p.pdv,
          pdv_service_id: p.pdvServiceId,
          pdv_applicable: p.pdvApplicable,
          water_amount: r.water_overridden
            ? r.water_amount
            : p.waterApplicable
              ? r.occupants * p.water
              : 0,
          pdv_amount: r.pdv_overridden ? r.pdv_amount : p.pdvApplicable ? p.pdv : 0,
        };
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults.elec, defaults.water, defaults.pdv]);

  const updateRow = (idx: number, patch: Partial<RowData>) => {
    setRows((prev) => {
      const next = [...prev];
      const row = { ...next[idx], ...patch };
      // Auto-recompute electric_amount unless user manually overrode it.
      if (
        ('current_reading' in patch || 'prev_reading' in patch) &&
        !row.electric_overridden
      ) {
        const consumption = Math.max(
          0,
          (Number(row.current_reading) || 0) - (Number(row.prev_reading) || 0)
        );
        row.electric_amount = consumption * row.elec_rate;
      }
      // Auto-recompute water unless user overrode it. HĐ không đăng ký nước →
      // giữ 0.
      if ('occupants' in patch && !row.water_overridden) {
        row.water_amount = row.water_applicable
          ? (Number(row.occupants) || 0) * row.water_rate
          : 0;
      }
      next[idx] = row;
      return next;
    });
  };

  // Re-fetch nợ cũ cho 1 row (sau khi user bấm ↻), ghi đè giá trị đã chỉnh tay.
  const reloadPreviousDebt = async (idx: number) => {
    const row = rows[idx];
    if (!row) return;
    const { computePreviousDebt } = await import('@/lib/invoiceHelpers');
    const { total, sources } = await computePreviousDebt(row.contract_id);
    setRows((prev) => {
      const next = [...prev];
      if (!next[idx]) return prev;
      next[idx] = {
        ...next[idx],
        previous_debt: total,
        previous_debt_sources: sources,
        previous_debt_overridden: false,
      };
      return next;
    });
  };

  const computeRowTotal = (r: RowData) => {
    const days = calcProratedDays(r.period_start_date, r.period_end_date);
    const rent = days > 0 ? prorateAmount(r.rent_price, days) : r.rent_price;
    const water = days > 0 ? prorateAmount(r.water_amount, days) : r.water_amount;
    const pdv = days > 0 ? prorateAmount(r.pdv_amount, days) : r.pdv_amount;
    return rent + r.electric_amount + water + pdv - r.discount + (r.previous_debt || 0);
  };

  const totals = useMemo(() => {
    const sel = rows.filter((r) => r.selected);
    return {
      count: sel.length,
      total: sel.reduce((s, r) => s + computeRowTotal(r), 0),
      previousDebtSum: sel.reduce((s, r) => s + (r.previous_debt || 0), 0),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const allSelected = rows.length > 0 && rows.every((r) => r.selected);
  const toggleAll = () =>
    setRows((prev) => prev.map((r) => ({ ...r, selected: !allSelected })));

  const handleClose = () => {
    setRows([]);
    setLoaded(false);
    onOpenChange(false);
  };

  const handleSubmit = async () => {
    const selected = rows.filter((r) => r.selected);
    if (selected.length === 0) {
      toast({ variant: 'destructive', title: 'Chưa chọn phòng nào' });
      return;
    }
    setSubmitting(true);
    let ok = 0;
    let fail = 0;
    const periodStart = startOfMonth(parse(billingMonth + '-01', 'yyyy-MM-dd', new Date()));
    const periodEnd = endOfMonth(periodStart);
    const fromDate = format(periodStart, 'yyyy-MM-dd');
    const toDate = format(periodEnd, 'yyyy-MM-dd');

    for (const row of selected) {
      try {
        // 1) If user entered a current reading, record an UNAPPROVED meter reading.
        const consumption =
          (Number(row.current_reading) || 0) - (Number(row.prev_reading) || 0);
        if (row.meter_id && row.current_reading !== '' && consumption >= 0) {
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            await supabase.from('meter_readings').insert({
              user_id: user.id,
              meter_id: row.meter_id,
              reading_date: issueDate,
              settlement_month: billingMonth,
              previous_reading: row.prev_reading,
              current_reading: Number(row.current_reading),
              status: 'APPROVED',
              approved_by: user.id,
              approved_at: new Date().toISOString(),
              meter_type: 'ELECTRICITY',
              service_id: row.elec_service_id,
              recorded_by: user.id,
            } as any);
          }
        }

        // 2) Build invoice items. Nếu row có period_start/end → prorate
        //    rent + nước + PDV theo `amount / 30 * số_ngày` và ghi from/to_date.
        const itemDays = calcProratedDays(row.period_start_date, row.period_end_date);
        const useProrate = itemDays > 0;
        const itemFromDate = useProrate ? row.period_start_date! : fromDate;
        const itemToDate = useProrate ? row.period_end_date! : toDate;
        const prorateLabel = useProrate ? ` (${itemDays}/30 ngày)` : '';

        const rentAmount = useProrate ? prorateAmount(row.rent_price, itemDays) : row.rent_price;
        const waterAmount = useProrate ? prorateAmount(row.water_amount, itemDays) : row.water_amount;
        const pdvAmount = useProrate ? prorateAmount(row.pdv_amount, itemDays) : row.pdv_amount;

        const items: InvoiceFormData['items'] = [];
        let order = 0;
        items.push({
          type: 'RENT',
          description:
            `Tiền thuê phòng ${row.room_name} (${format(periodStart, 'MM/yyyy')})` + prorateLabel,
          unit_price: rentAmount,
          quantity: 1,
          coefficient: 1,
          from_date: useProrate ? itemFromDate : undefined,
          to_date: useProrate ? itemToDate : undefined,
          sort_order: order++,
        });
        if (row.electric_amount > 0) {
          const cons = Math.max(consumption, 0);
          items.push({
            service_id: row.elec_service_id,
            type: 'SERVICE',
            description: `Tiền điện (${row.prev_reading} → ${row.current_reading || row.prev_reading})`,
            unit_price: cons > 0 ? row.electric_amount / cons : row.electric_amount,
            quantity: cons > 0 ? cons : 1,
            coefficient: 1,
            previous_reading: row.prev_reading,
            current_reading: Number(row.current_reading) || row.prev_reading,
            from_date: fromDate,
            to_date: toDate,
            sort_order: order++,
          });
        }
        if (waterAmount > 0) {
          items.push({
            service_id: row.water_service_id,
            type: 'SERVICE',
            description: `Tiền nước (${row.occupants} người)` + prorateLabel,
            unit_price: waterAmount,
            quantity: 1,
            coefficient: 1,
            from_date: useProrate ? itemFromDate : undefined,
            to_date: useProrate ? itemToDate : undefined,
            sort_order: order++,
          });
        }
        if (pdvAmount > 0) {
          items.push({
            service_id: row.pdv_service_id,
            type: 'SERVICE',
            description: 'Phí dịch vụ' + prorateLabel,
            unit_price: pdvAmount,
            quantity: 1,
            coefficient: 1,
            from_date: useProrate ? itemFromDate : undefined,
            to_date: useProrate ? itemToDate : undefined,
            sort_order: order++,
          });
        }

        const appliedCredit = Math.min(
          Math.max(0, row.applied_credit || 0),
          Math.max(0, row.discount || 0),
        );
        const formData: InvoiceFormData = {
          building_id: buildingId,
          room_id: row.room_id,
          contract_id: row.contract_id,
          billing_month: billingMonth,
          issue_date: issueDate,
          due_date: dueDate,
          discount_amount: row.discount,
          discount_notes: row.discount_notes?.trim() || null,
          applied_credit: appliedCredit,
          electricity_prev_overridden: row.prev_reading_overridden,
          tax_percent: 0,
          prepaid_amount: 0,
          previous_debt: row.previous_debt || 0,
          // Nếu user đã chỉnh tay → clear sources để DB trigger KHÔNG cascade-paid
          // sai (vì amount đã không khớp tổng sources nữa). User tự đánh dấu HĐ
          // cũ thanh toán nếu muốn.
          previous_debt_sources: row.previous_debt_overridden ? [] : (row.previous_debt_sources ?? []),
          notes: null,
          items,
        };
        await createInvoice.mutateAsync(formData);
        ok++;
      } catch (err) {
        console.error('Create invoice failed for', row.room_name, err);
        fail++;
      }
    }
    setSubmitting(false);
    toast({
      title: 'Hoàn tất tạo hoá đơn',
      description: `Thành công: ${ok}${fail > 0 ? ` — Lỗi: ${fail}` : ''}`,
    });
    if (fail === 0) handleClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-[1400px] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TableIcon className="h-5 w-5 text-indigo-600" />
            Tạo nhanh hoá đơn — Mode Excel
          </DialogTitle>
          <DialogDescription>
            Chọn toà & kỳ → Tải dữ liệu → Nhập chỉ số cuối → Bấm "Tạo hoá đơn"
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-5 gap-3 py-2">
          <div className="space-y-1 col-span-2">
            <Label>Toà nhà *</Label>
            <Select value={buildingId} onValueChange={setBuildingId}>
              <SelectTrigger>
                <SelectValue placeholder="Chọn toà..." />
              </SelectTrigger>
              <SelectContent>
                {(buildings ?? []).map((b: any) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Kỳ thanh toán *</Label>
            <Input
              type="month"
              value={billingMonth}
              onChange={(e) => setBillingMonth(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Ngày phát hành</Label>
            <DateInput value={issueDate} onChange={setIssueDate} />
          </div>
          <div className="space-y-1">
            <Label>Hạn thanh toán</Label>
            <DateInput value={dueDate} onChange={setDueDate} />
          </div>
        </div>

        <div className="flex items-center gap-2 pb-2">
          <Button onClick={handleLoad} disabled={!buildingId}>
            <Download className="h-4 w-4 mr-2" />
            Tải dữ liệu
          </Button>
          {loaded && (
            <span className="text-sm text-muted-foreground">
              Đã tải {rows.length} phòng — đơn giá toà (mặc định): điện{' '}
              {fmt(defaults.elec)}đ/kWh, nước {fmt(defaults.water)}đ/người, PDV{' '}
              {fmt(defaults.pdv)}đ/phòng. HĐ có đăng ký dịch vụ riêng sẽ dùng giá HĐ.
            </span>
          )}
        </div>

        <div className="flex-1 overflow-auto border rounded-md">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-100 sticky top-0 z-10">
              <tr className="text-xs uppercase">
                <th className="p-2 border w-8">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                </th>
                <th className="p-2 border text-left">Phòng</th>
                <th className="p-2 border text-right">Giá Phòng</th>
                <th className="p-2 border text-right w-[70px]">Số người</th>
                <th className="p-2 border text-right w-[90px]">Chỉ số đầu</th>
                <th className="p-2 border text-right w-[100px]">Chỉ số cuối</th>
                <th className="p-2 border text-right">Tiền điện</th>
                <th className="p-2 border text-right">Nước</th>
                <th className="p-2 border text-right">Phí Dịch Vụ</th>
                <th className="p-2 border text-right">Giảm trừ</th>
                <th className="p-2 border text-right bg-red-50/60">Nợ cũ</th>
                <th className="p-2 border text-right bg-amber-50">Tổng</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={12} className="text-center p-8 text-muted-foreground">
                    {loaded ? 'Toà này không có hợp đồng đang hiệu lực.' : 'Chưa tải dữ liệu.'}
                  </td>
                </tr>
              )}
              {rows.map((r, i) => {
                const total = computeRowTotal(r);
                const rowDays = calcProratedDays(r.period_start_date, r.period_end_date);
                return (
                  <tr key={r.contract_id} className={r.selected ? '' : 'opacity-50'}>
                    <td className="p-1 border text-center">
                      <Checkbox
                        checked={r.selected}
                        onCheckedChange={(v) => updateRow(i, { selected: !!v })}
                      />
                    </td>
                    <td className="p-1 border font-medium">{r.room_name}</td>
                    <td className="p-1 border">
                      <CurrencyInput
                        className="h-7 text-right"
                        suffix={false}
                        value={r.rent_price}
                        onChange={(v) => updateRow(i, { rent_price: v })}
                      />
                    </td>
                    <td className="p-1 border">
                      <NumberInput
                        className="h-7 text-right"
                        value={r.occupants}
                        onChange={(v) => updateRow(i, { occupants: v })}
                      />
                    </td>
                    <td className="p-1 border">
                      {r.meter_id ? (
                        r.prev_reading_overridden ? (
                          <div className="relative">
                            <NumberInput
                              className="h-7 text-right pr-6"
                              allowDecimal
                              value={r.prev_reading}
                              onChange={(v) => updateRow(i, { prev_reading: v ?? 0 })}
                            />
                            <Pencil className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-amber-600 pointer-events-none" />
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1 pr-1">
                            <span className="text-slate-600 text-right tabular-nums">
                              {fmt(r.prev_reading)}
                            </span>
                            <button
                              type="button"
                              title="Sửa tay chỉ số đầu"
                              className="text-slate-400 hover:text-amber-600 p-0.5 rounded"
                              onClick={() => updateRow(i, { prev_reading_overridden: true })}
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          </div>
                        )
                      ) : (
                        <span className="text-slate-400 text-right block">—</span>
                      )}
                    </td>
                    <td className="p-1 border">
                      <NumberInput
                        className="h-7 text-right"
                        disabled={!r.meter_id}
                        allowDecimal
                        value={r.current_reading === '' ? null : r.current_reading}
                        onChange={(v) =>
                          updateRow(i, {
                            current_reading: v === 0 ? '' : v,
                          })
                        }
                      />
                    </td>
                    <td className="p-1 border">
                      <CurrencyInput
                        className="h-7 text-right"
                        suffix={false}
                        value={Math.round(r.electric_amount)}
                        onChange={(v) =>
                          updateRow(i, {
                            electric_amount: v,
                            electric_overridden: true,
                          })
                        }
                      />
                    </td>
                    <td className="p-1 border">
                      <CurrencyInput
                        className="h-7 text-right"
                        suffix={false}
                        value={Math.round(r.water_amount)}
                        onChange={(v) =>
                          updateRow(i, {
                            water_amount: v,
                            water_overridden: true,
                          })
                        }
                      />
                    </td>
                    <td className="p-1 border">
                      <CurrencyInput
                        className="h-7 text-right"
                        suffix={false}
                        value={r.pdv_amount}
                        onChange={(v) => updateRow(i, { pdv_amount: v, pdv_overridden: true })}
                      />
                    </td>
                    <td className="p-1 border">
                      <div className="relative">
                        <CurrencyInput
                          className="h-7 text-right pr-3"
                          suffix={false}
                          value={r.discount}
                          onChange={(v) => updateRow(i, { discount: v })}
                        />
                        <DiscountNoteTrigger
                          value={r.discount_notes}
                          onChange={(v) => updateRow(i, { discount_notes: v })}
                          disabled={r.discount <= 0}
                        />
                      </div>
                    </td>
                    <td className="p-1 border bg-red-50/30">
                      <HoverCard openDelay={0} closeDelay={100}>
                        <HoverCardTrigger asChild>
                          <div className="flex items-center gap-1">
                            <CurrencyInput
                              className={`h-7 text-right ${r.previous_debt > 0 ? 'text-red-600 font-medium' : ''}`}
                              suffix={false}
                              value={r.previous_debt}
                              onChange={(v) =>
                                updateRow(i, {
                                  previous_debt: v,
                                  previous_debt_overridden: true,
                                })
                              }
                            />
                            <button
                              type="button"
                              title="Tải lại nợ cũ tự động"
                              className="text-slate-400 hover:text-amber-600 p-0.5 rounded"
                              onClick={() => reloadPreviousDebt(i)}
                            >
                              <RotateCcw className="h-3 w-3" />
                            </button>
                          </div>
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80 text-xs" align="end">
                          <div className="font-semibold text-sm mb-2 text-red-700">
                            Nợ cũ phòng {r.room_name}: {formatCurrency(r.previous_debt || 0)}
                          </div>
                          {r.previous_debt_sources.length === 0 ? (
                            <p className="text-muted-foreground">
                              Không có nợ cũ (HĐ &lt; 10K được làm tròn bỏ qua).
                            </p>
                          ) : (
                            <ul className="space-y-1">
                              {r.previous_debt_sources.map((s, j) => (
                                <li key={j} className="flex justify-between gap-2 border-b border-dashed pb-1 last:border-0">
                                  <span className="truncate">
                                    {s.type === 'deposit' ? '🏠 ' : '📄 '}
                                    {s.label}
                                  </span>
                                  <span className="tabular-nums font-medium">{formatCurrency(s.amount)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {r.previous_debt_overridden && (
                            <p className="text-[10px] text-amber-700 mt-2">
                              ⚠ Đã chỉnh tay — bấm ↻ để tải lại tự động.
                            </p>
                          )}
                        </HoverCardContent>
                      </HoverCard>
                    </td>
                    <td className="p-1 border text-right font-semibold bg-amber-50">
                      <div className="flex items-center justify-end gap-1">
                        <div className="flex flex-col items-end leading-tight">
                          <span className="tabular-nums">{fmt(total)}</span>
                          {rowDays > 0 && (
                            <span className="text-[10px] font-normal text-emerald-700">
                              {rowDays}/30 ngày
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          title="Prorate theo ngày bắt đầu/kết thúc"
                          className={`p-0.5 rounded hover:bg-amber-100 ${
                            rowDays > 0
                              ? 'text-emerald-600'
                              : 'text-slate-400 hover:text-amber-700'
                          }`}
                          onClick={() => setProrateRowIdx(i)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="sticky bottom-0 bg-slate-100">
                <tr className="font-semibold">
                  <td colSpan={10} className="p-2 border text-right">
                    Tổng {totals.count} phòng đã chọn:
                  </td>
                  <td className="p-2 border text-right text-red-700 bg-red-50/40">
                    {fmt(totals.previousDebtSum)}đ
                  </td>
                  <td className="p-2 border text-right text-indigo-700 text-base">
                    {fmt(totals.total)}đ
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={handleClose}>
            Huỷ
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || totals.count === 0}
            className="bg-indigo-600 hover:bg-indigo-700"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Đang tạo...
              </>
            ) : (
              <>Tạo {totals.count} hoá đơn</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ProrateRowDialog
        row={prorateRowIdx != null ? rows[prorateRowIdx] : null}
        onClose={() => setProrateRowIdx(null)}
        onApply={(startDate, endDate) => {
          if (prorateRowIdx == null) return;
          updateRow(prorateRowIdx, {
            period_start_date: startDate,
            period_end_date: endDate,
          });
          setProrateRowIdx(null);
        }}
        onClear={() => {
          if (prorateRowIdx == null) return;
          updateRow(prorateRowIdx, {
            period_start_date: null,
            period_end_date: null,
          });
          setProrateRowIdx(null);
        }}
      />
    </Dialog>
  );
}

interface ProrateRowDialogProps {
  row: RowData | null;
  onClose: () => void;
  onApply: (startDate: string, endDate: string) => void;
  onClear: () => void;
}

function ProrateRowDialog({ row, onClose, onApply, onClear }: ProrateRowDialogProps) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  useEffect(() => {
    if (row) {
      setStart(row.period_start_date || '');
      setEnd(row.period_end_date || '');
    }
  }, [row]);

  const days = calcProratedDays(start, end);
  const open = row != null;
  const previewRent = row && days > 0 ? prorateAmount(row.rent_price, days) : row?.rent_price ?? 0;
  const previewWater = row && days > 0 ? prorateAmount(row.water_amount, days) : row?.water_amount ?? 0;
  const previewPDV = row && days > 0 ? prorateAmount(row.pdv_amount, days) : row?.pdv_amount ?? 0;
  const previewTotal =
    previewRent + (row?.electric_amount ?? 0) + previewWater + previewPDV - (row?.discount ?? 0);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Prorate phòng {row?.room_name || ''}
          </DialogTitle>
          <DialogDescription>
            Điền ngày bắt đầu và kết thúc thực tế → tiền phòng + nước + PDV sẽ chia tỉ lệ <code>/30 × số ngày</code>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Ngày bắt đầu</Label>
              <DateInput value={start} onChange={setStart} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Ngày kết thúc</Label>
              <DateInput value={end} onChange={setEnd} />
            </div>
          </div>

          {days > 0 ? (
            <div className="border rounded-md p-3 bg-emerald-50 text-sm space-y-1">
              <div className="font-medium text-emerald-800">
                {days}/30 ngày — đã prorate
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-slate-700">
                <div>Tiền phòng:</div>
                <div className="text-right tabular-nums">{fmt(previewRent)}đ</div>
                <div>Tiền điện:</div>
                <div className="text-right tabular-nums">{fmt(row?.electric_amount ?? 0)}đ <span className="text-slate-400">(không prorate)</span></div>
                <div>Nước:</div>
                <div className="text-right tabular-nums">{fmt(previewWater)}đ</div>
                <div>PDV:</div>
                <div className="text-right tabular-nums">{fmt(previewPDV)}đ</div>
                <div>Giảm trừ:</div>
                <div className="text-right tabular-nums">−{fmt(row?.discount ?? 0)}đ</div>
                <div className="font-semibold pt-1 border-t mt-1">Tổng:</div>
                <div className="text-right tabular-nums font-semibold pt-1 border-t mt-1">{fmt(previewTotal)}đ</div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Bỏ trống cả 2 ngày để không prorate (giữ giá full tháng).
            </p>
          )}
        </div>
        <DialogFooter className="gap-2">
          {(row?.period_start_date || row?.period_end_date) && (
            <Button type="button" variant="outline" onClick={onClear}>
              Xoá prorate
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            type="button"
            disabled={!start || !end || days <= 0}
            onClick={() => onApply(start, end)}
          >
            Áp dụng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
