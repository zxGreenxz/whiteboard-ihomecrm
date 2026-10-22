import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Building2, Zap, Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Button } from "@/components/ui/button";
import { InlineSkeleton } from "@/components/loading/LoadingState";
import { useOrganization } from '@/contexts/OrganizationContext';
import { resolveMeterBilling } from '@/lib/meter-capture/service';
import { meterSourceReference, type MeterBillingSource } from '@/lib/meter-capture/types';
import { MeterEvidenceThumb } from '@/components/meter-readings/MeterEvidenceThumb';
import { useBuildingServices } from "@/hooks/useBuildingServices";
import { resolveInvoicePricing } from "@/lib/contractServicePricing";
import { prorateAmount, calcProratedDays } from "@/lib/prorateCalculation";
import type { ExtraChargeItem } from "@/lib/contractValidation";
import type { ContractWithRelations } from "@/types/contract";

interface TerminationExtraChargesProps {
  contract: ContractWithRelations;
  /** Ngày thanh lý (move-out/forfeit) — mặc định cho ô "đến ngày" của dòng prorate. */
  chargeDate?: string;
  /** Emit mảng khoản thu thêm đã chuẩn hoá mỗi khi có thay đổi. */
  onChange: (items: ExtraChargeItem[]) => void;
  onValidityChange?: (valid: boolean) => void;
}

let customRowSeq = 0;
interface CustomRow {
  id: number;
  name: string;
  amount: number;
}

function formatVND(value: number): string {
  return new Intl.NumberFormat("vi-VN").format(value);
}

function fmtDM(iso?: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
}

/**
 * Khu vực "Thu thêm" dùng chung cho cả 2 chế độ thanh lý (rời phòng & bỏ cọc).
 * Bố cục dạng thẻ: cột nhãn — controls — số tiền (canh phải). Dòng đầu cho nhập
 * "ở từ ngày → đến ngày" để tự suy ra số ngày prorate. Component emit-only.
 */
export function TerminationExtraCharges({
  contract,
  chargeDate,
  onChange,
  onValidityChange,
}: TerminationExtraChargesProps) {
  const buildingId = contract.room?.building_id || "";
  const { data: bldSvc } = useBuildingServices(buildingId);

  // Đơn giá toà (giống GenerateInvoiceDialog) → resolveInvoicePricing theo HĐ.
  const defaults = useMemo(() => {
    let elec = 3500;
    let water = 100000;
    let pdv = 150000;
    let elecServiceId: string | null = null;
    let waterServiceId: string | null = null;
    let pdvServiceId: string | null = null;
    for (const bs of (bldSvc ?? []).filter((b: any) => b.is_active)) {
      const name = bs.service?.name?.toLowerCase() ?? "";
      const price = bs.unit_price_override ?? bs.service?.unit_price ?? 0;
      if (name.includes("điện")) {
        elec = Number(price) || elec;
        elecServiceId = bs.service_id;
      } else if (name.includes("nước")) {
        water = Number(price) || water;
        waterServiceId = bs.service_id;
      } else if (name.includes("dịch vụ") || name.includes("phí")) {
        pdv = Number(price) || pdv;
        pdvServiceId = bs.service_id;
      }
    }
    return { elec, water, pdv, elecServiceId, waterServiceId, pdvServiceId };
  }, [bldSvc]);

  const pricing = useMemo(
    () => resolveInvoicePricing(contract.contract_services, defaults),
    [contract.contract_services, defaults],
  );

  const occupants = contract.contract_customers?.length || 1;
  const rent = Number(contract.rent_price) || 0;
  // Cơ sở prorate tháng: tiền phòng + nước (×số người nếu HĐ áp) + PDV (nếu áp).
  const proratedBase = useMemo(
    () =>
      rent +
      (pricing.waterApplicable ? occupants * pricing.water : 0) +
      (pricing.pdvApplicable ? pricing.pdv : 0),
    [rent, occupants, pricing],
  );

  const { selectedOrganizationId: orgId } = useOrganization();
  const [meterSources, setMeterSources] = useState<MeterBillingSource[]>([]);
  const [meterLookup, setMeterLookup] = useState<'loading' | 'ready' | 'error'>('loading');
  const [meterError, setMeterError] = useState('');
  const [reload, setReload] = useState(0);
  const [currentReading, setCurrentReading] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    setMeterSources([]); setCurrentReading(null); setMeterError(''); setMeterLookup('loading');
    onValidityChange?.(false);
    if (!orgId || !chargeDate) {
      setMeterLookup('error'); setMeterError('Cần chọn tổ chức và ngày thanh lý để đối chiếu chỉ số.');
      return;
    }
    resolveMeterBilling(orgId, { contractId: contract.id, month: chargeDate.slice(0, 7), readingDate: chargeDate, purpose: 'MOVE_OUT' })
      .then(sources => { if (!cancelled) { setMeterSources(sources); setMeterLookup('ready'); } })
      .catch(cause => { if (!cancelled) { setMeterLookup('error'); setMeterError(cause instanceof Error ? cause.message : 'Không tải được nguồn chỉ số. Tải lại trước khi quyết toán.'); } });
    return () => { cancelled = true; };
  }, [orgId, contract.id, chargeDate, reload, onValidityChange]);

  // ── State các dòng mặc định + dòng tuỳ ý ────────────────────────────────
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>(() => chargeDate || "");
  const [proratedAmount, setProratedAmount] = useState(0);
  const [proratedTouched, setProratedTouched] = useState(false);
  const [cleaningAmount, setCleaningAmount] = useState(200000);
  const [customRows, setCustomRows] = useState<CustomRow[]>([]);

  const days = calcProratedDays(fromDate, toDate);

  // Auto thành tiền dòng 1 theo số ngày ở thêm (cho tới khi user gõ tay).
  const autoProrated = days > 0 ? prorateAmount(proratedBase, days) : 0;
  useEffect(() => {
    if (!proratedTouched) setProratedAmount(autoProrated);
  }, [autoProrated, proratedTouched]);

  const onlySource = meterSources.length === 1 ? meterSources[0] : undefined;
  const manualSource = onlySource?.start && !onlySource.end
    && onlySource.issues.every(issue => issue === 'MISSING_END') ? onlySource : null;
  const previousReading = manualSource?.start ? Number(manualSource.start.value) : null;
  const manualConsumption = currentReading != null && previousReading != null ? currentReading - previousReading : 0;
  const manualInvalid = !!manualSource && currentReading != null && (!Number.isFinite(currentReading) || manualConsumption < 0);
  const unresolvedSources = meterSources.some(source => source !== manualSource && (!source.start || !source.end || source.issues.length > 0 || Number(source.end.value) < Number(source.start.value)));
  const electricValid = meterLookup === 'ready' && !unresolvedSources && !manualInvalid;
  useEffect(() => { onValidityChange?.(electricValid); }, [electricValid, onValidityChange]);
  const electricItems = useMemo<ExtraChargeItem[]>(() => {
    if (meterLookup !== 'ready' || !chargeDate) return [];
    return meterSources.flatMap(source => {
      if (source.start && source.end?.readingId && !source.issues.length) {
        const previous = Number(source.start.value), current = Number(source.end.value);
        if (current < previous) return [];
        return [{ kind: 'ELECTRIC' as const, description: `Tiền điện ${source.meterName} (${formatVND(previous)} → ${formatVND(current)})`,
          amount: Math.round((current - previous) * (pricing.elec || 0)), previous_reading: previous, current_reading: current,
          unit_price: pricing.elec || 0, meter_id: source.meterId,
          meter_source: meterSourceReference(source, { contractId: contract.id, month: chargeDate.slice(0, 7), readingDate: chargeDate, purpose: 'MOVE_OUT', sortOrder: 0 }) }];
      }
      if (source === manualSource && currentReading != null && previousReading != null && manualConsumption > 0) {
        return [{ kind: 'ELECTRIC' as const, description: `Tiền điện ${source.meterName} (${formatVND(previousReading)} → ${formatVND(currentReading)})`,
          amount: Math.round(manualConsumption * (pricing.elec || 0)), previous_reading: previousReading, current_reading: currentReading,
          unit_price: pricing.elec || 0, meter_id: source.meterId }];
      }
      return [];
    });
  }, [meterLookup, meterSources, chargeDate, pricing.elec, contract.id, manualSource, currentReading, previousReading, manualConsumption]);
  const electricAmount = electricItems.reduce((sum, item) => sum + item.amount, 0);

  // ── Emit mảng ExtraChargeItem chuẩn hoá lên cha ─────────────────────────
  useEffect(() => {
    const items: ExtraChargeItem[] = [];
    if (proratedAmount > 0) {
      const range =
        fromDate && toDate ? ` (${fmtDM(fromDate)}–${fmtDM(toDate)}, ${days} ngày)` : "";
      items.push({
        kind: "PRORATED",
        description: `Tiền phòng + Nước + PDV${range}`,
        amount: proratedAmount,
        days,
        unit_price: proratedBase,
      });
    }
    for (const item of electricItems) items.push({ ...item, ...(item.meter_source ? { meter_source: { ...item.meter_source, sortOrder: items.length } } : {}) });
    if (cleaningAmount > 0) {
      items.push({
        kind: "CLEANING",
        description: "Tiền vệ sinh",
        amount: cleaningAmount,
      });
    }
    for (const r of customRows) {
      if (r.name.trim() && r.amount > 0) {
        items.push({
          kind: "CUSTOM",
          description: r.name.trim(),
          amount: r.amount,
        });
      }
    }
    onChange(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    proratedAmount,
    days,
    fromDate,
    toDate,
    proratedBase,
    electricAmount,
    electricItems,
    cleaningAmount,
    customRows,
  ]);

  const total =
    proratedAmount +
    electricAmount +
    cleaningAmount +
    customRows.reduce(
      (s, r) => s + (r.name.trim() && r.amount > 0 ? r.amount : 0),
      0,
    );

  const addCustomRow = () =>
    setCustomRows((rows) => [...rows, { id: ++customRowSeq, name: "", amount: 0 }]);
  const updateCustomRow = (id: number, patch: Partial<CustomRow>) =>
    setCustomRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const removeCustomRow = (id: number) =>
    setCustomRows((rows) => rows.filter((r) => r.id !== id));

  const onDateChange = (which: "from" | "to") => (iso: string) => {
    if (which === "from") setFromDate(iso);
    else setToDate(iso);
    setProratedTouched(false);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Thu thêm
        </h3>
        <span className="text-xs text-muted-foreground normal-case">
          Các khoản khách phải trả thêm
        </span>
      </div>

      <div className="rounded-xl border bg-card divide-y divide-border/70 overflow-hidden">
        {/* Dòng 1: Tiền phòng + Nước + PDV (theo khoảng ngày ở thêm) */}
        <div className="px-3.5 py-3 space-y-2">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium">Tiền phòng + Nước + PDV</span>
            <div className="ml-auto w-36">
              <CurrencyInput
                className="h-9 text-sm text-right"
                value={proratedAmount}
                onChange={(v) => {
                  setProratedAmount(v);
                  setProratedTouched(true);
                }}
              />
            </div>
            <div className="w-9 shrink-0" />
          </div>
          <div className="flex items-center gap-2 flex-wrap pl-6">
            <span className="text-xs text-muted-foreground">Ở từ</span>
            <DateInput
              value={fromDate}
              onChange={onDateChange("from")}
              className="w-[140px] [&_input]:h-9 [&_input]:text-sm"
            />
            <span className="text-muted-foreground text-xs">đến</span>
            <DateInput
              value={toDate}
              onChange={onDateChange("to")}
              className="w-[140px] [&_input]:h-9 [&_input]:text-sm"
            />
            {days > 0 && (
              <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {days} ngày
              </span>
            )}
          </div>
        </div>

        {/* Each physical meter retains its own reading source and internal evidence. */}
        <div className="space-y-3 px-3.5 py-3">
          <div className="flex gap-2 items-center"><Zap className="h-4 w-4" /><span className="text-sm font-medium">Tiền điện (chốt số)</span></div>
          {meterLookup === 'loading' && <InlineSkeleton label="nguồn chỉ số đúng hợp đồng và ngày thanh lý" width="16rem" />}
          {meterLookup === 'error' && <p role="alert" className="text-xs text-destructive">{meterError} <button type="button" className="underline" onClick={() => setReload(value => value + 1)}>Tải lại nguồn chỉ số</button></p>}
          {meterLookup === 'ready' && meterSources.length === 0 && <p className="text-xs text-muted-foreground">Phòng chưa có đồng hồ điện đang dùng. Đăng ký đồng hồ tại Ghi chỉ số nếu cần chốt điện.</p>}
          {meterSources.map(source => <div key={source.meterId} className="space-y-2 border-t pt-2">
            <p className="text-sm">{source.meterName} · {source.registerCode || 'kWh'}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Input title={`Số điện đầu ${source.meterName}`} type="number" className="h-9 w-28" value={source.start?.value ?? ''} readOnly placeholder="Thiếu số đầu" />
              <MeterEvidenceThumb captureId={source.start?.captureId} label={`Ảnh số đầu ${source.meterName}`} />
              <span>→</span>
              <Input title={`Số điện cuối ${source.meterName}`} type="number" inputMode="decimal" min={0} step="0.01" className="h-9 w-28" placeholder="Số cuối"
                value={source === manualSource ? currentReading ?? '' : source.end?.value ?? ''}
                readOnly={source !== manualSource} disabled={meterLookup !== 'ready'}
                onChange={event => setCurrentReading(event.target.value === '' ? null : Number(event.target.value))} />
              <MeterEvidenceThumb captureId={source.end?.captureId} label={`Ảnh số cuối ${source.meterName}`} />
              <span className="text-sm font-semibold">{formatVND(electricItems.find(item => item.meter_id === source.meterId)?.amount ?? 0)} đ</span>
            </div>
            {source.end && source.start && !source.issues.length ? <p className="text-xs text-muted-foreground">Liên kết chỉ số đã chốt và chứng cứ khi quyết toán, kể cả 0 kWh.</p>
              : source === manualSource ? <p className={`text-xs ${manualInvalid ? 'text-destructive' : 'text-muted-foreground'}`} role={manualInvalid ? 'alert' : undefined}>{manualInvalid ? 'Số cuối không được nhỏ hơn số đầu.' : currentReading != null && manualConsumption === 0 ? 'Số nhập tay 0 kWh chưa được lưu làm chứng cứ. Chốt bằng ảnh tại Ghi chỉ số để lưu mốc này.' : 'Chưa có ảnh đã chốt: có thể nhập số cuối thủ công. Số đầu lấy đúng kỳ/hợp đồng.'}</p>
              : <p role="alert" className="text-xs text-destructive">Thiếu nguồn hợp lệ cho đồng hồ này. Chốt đủ chỉ số tại Ghi chỉ số rồi tải lại.</p>}
          </div>)}
          {meterLookup === 'ready' && <Button type="button" variant="outline" size="sm" onClick={() => setReload(value => value + 1)}>Tải lại chỉ số đã chốt</Button>}
        </div>

        {/* Dòng 3: Tiền vệ sinh */}
        <div className="flex items-center gap-2 px-3.5 py-3">
          <Sparkles className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium">Tiền vệ sinh</span>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            (mặc định 200.000đ)
          </span>
          <div className="ml-auto w-36">
            <CurrencyInput
              className="h-9 text-sm text-right"
              value={cleaningAmount}
              onChange={setCleaningAmount}
            />
          </div>
          <div className="w-9 shrink-0" />
        </div>

        {/* Dòng tuỳ ý */}
        {customRows.map((r) => (
          <div key={r.id} className="flex items-center gap-2 px-3.5 py-3">
            <Input
              className="h-9 flex-1 min-w-0 text-sm"
              placeholder="Tên khoản thu thêm…"
              value={r.name}
              onChange={(e) => updateCustomRow(r.id, { name: e.target.value })}
            />
            <div className="w-36 shrink-0">
              <CurrencyInput
                className="h-9 text-sm text-right"
                value={r.amount}
                onChange={(v) => updateCustomRow(r.id, { amount: v })}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 text-muted-foreground hover:text-red-600"
              onClick={() => removeCustomRow(r.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}

        {/* Footer: thêm khoản + tổng */}
        <div className="flex items-center justify-between gap-2 bg-muted/40 px-3.5 py-2.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 border-dashed"
            onClick={addCustomRow}
          >
            <Plus className="h-4 w-4 mr-1" />
            Thêm khoản
          </Button>
          <div className="text-sm">
            <span className="text-muted-foreground">Tổng thu thêm: </span>
            <span className="font-semibold text-base text-red-600 tabular-nums">
              {formatVND(total)} đ
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
