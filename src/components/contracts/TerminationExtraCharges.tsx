import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Building2, Zap, Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
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

  // ── Meter điện: lấy meter_id + chỉ số đầu (latest APPROVED) ──────────────
  const [meterId, setMeterId] = useState<string | null>(null);
  const [previousReading, setPreviousReading] = useState<number>(0);
  useEffect(() => {
    const roomId = contract.room_id;
    if (!roomId) {
      setMeterId(null);
      setPreviousReading(Number(contract.initial_electricity_reading) || 0);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: meters } = await supabase
        .from("meters")
        .select("id")
        .eq("room_id", roomId)
        .eq("meter_type", "ELECTRICITY")
        .is("deleted_at", null)
        .limit(1);
      const mid = (meters as any)?.[0]?.id ?? null;
      if (cancelled) return;
      setMeterId(mid);
      if (mid) {
        const { data: readings } = await (supabase as any)
          .from("meter_readings")
          .select("current_reading")
          .eq("meter_id", mid)
          .eq("status", "APPROVED")
          .is("deleted_at", null)
          .order("reading_date", { ascending: false })
          .limit(1);
        if (cancelled) return;
        const prev = Number((readings as any)?.[0]?.current_reading);
        setPreviousReading(
          Number.isFinite(prev) && prev > 0
            ? prev
            : Number(contract.initial_electricity_reading) || 0,
        );
      } else {
        setPreviousReading(Number(contract.initial_electricity_reading) || 0);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract.room_id]);

  // ── State các dòng mặc định + dòng tuỳ ý ────────────────────────────────
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>(() => chargeDate || "");
  const [proratedAmount, setProratedAmount] = useState(0);
  const [proratedTouched, setProratedTouched] = useState(false);
  const [currentReading, setCurrentReading] = useState<number | null>(null);
  const [cleaningAmount, setCleaningAmount] = useState(200000);
  const [customRows, setCustomRows] = useState<CustomRow[]>([]);

  const days = calcProratedDays(fromDate, toDate);

  // Auto thành tiền dòng 1 theo số ngày ở thêm (cho tới khi user gõ tay).
  const autoProrated = days > 0 ? prorateAmount(proratedBase, days) : 0;
  useEffect(() => {
    if (!proratedTouched) setProratedAmount(autoProrated);
  }, [autoProrated, proratedTouched]);

  // Tiền điện = (cuối − đầu) × đơn giá điện (chỉ hiển thị, auto).
  const consumption =
    currentReading != null && currentReading > previousReading
      ? currentReading - previousReading
      : 0;
  const electricAmount = Math.round(consumption * (pricing.elec || 0));

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
    if (electricAmount > 0 && currentReading != null) {
      items.push({
        kind: "ELECTRIC",
        description: `Tiền điện (${formatVND(previousReading)} → ${formatVND(currentReading)})`,
        amount: electricAmount,
        previous_reading: previousReading,
        current_reading: currentReading,
        unit_price: pricing.elec || 0,
        meter_id: meterId,
      });
    }
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
    currentReading,
    previousReading,
    meterId,
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

        {/* Dòng 2: Tiền điện (chốt số) */}
        <div className="flex items-center gap-2 px-3.5 py-3">
          <Zap className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium shrink-0">Tiền điện</span>
          <div className="flex items-center gap-1.5 ml-2 flex-wrap">
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              className="h-9 w-[86px] text-sm"
              title="Số điện đầu"
              value={previousReading === 0 ? "" : previousReading}
              onChange={(e) =>
                setPreviousReading(Math.max(0, Number(e.target.value) || 0))
              }
            />
            <span className="text-xs text-muted-foreground">→</span>
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              className="h-9 w-[86px] text-sm"
              placeholder="Số cuối"
              title="Số điện cuối"
              value={currentReading == null ? "" : currentReading}
              onChange={(e) => {
                const raw = e.target.value;
                setCurrentReading(raw === "" ? null : Math.max(0, Number(raw) || 0));
              }}
            />
            {consumption > 0 && (
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {formatVND(consumption)} kWh
              </span>
            )}
          </div>
          <div className="ml-auto flex h-9 w-36 items-center justify-end rounded-md border border-input bg-muted/40 px-3 text-sm font-semibold tabular-nums">
            {formatVND(electricAmount)}
            <span className="ml-1 font-normal text-muted-foreground">đ</span>
          </div>
          <div className="w-9 shrink-0" />
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
