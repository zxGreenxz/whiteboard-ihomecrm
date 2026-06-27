import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useBuildingServices } from "@/hooks/useBuildingServices";
import { resolveInvoicePricing } from "@/lib/contractServicePricing";
import { prorateAmount } from "@/lib/prorateCalculation";
import type { ExtraChargeItem } from "@/lib/contractValidation";
import type { ContractWithRelations } from "@/types/contract";

interface TerminationExtraChargesProps {
  contract: ContractWithRelations;
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

/**
 * Khu vực "Thu thêm" dùng chung cho cả 2 chế độ thanh lý (rời phòng & bỏ cọc).
 * 3 dòng mặc định + nút "+" thêm dòng tuỳ ý. Component emit-only: tự tính từng
 * khoản rồi đẩy mảng ExtraChargeItem lên form cha qua onChange.
 */
export function TerminationExtraCharges({
  contract,
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
  const [days, setDays] = useState(0);
  const [proratedAmount, setProratedAmount] = useState(0);
  const [proratedTouched, setProratedTouched] = useState(false);
  const [currentReading, setCurrentReading] = useState<number | null>(null);
  const [cleaningAmount, setCleaningAmount] = useState(200000);
  const [customRows, setCustomRows] = useState<CustomRow[]>([]);

  // Auto thành tiền dòng 1 theo số ngày ở thêm (cho tới khi user gõ tay).
  const autoProrated = days > 0 ? prorateAmount(proratedBase, days) : 0;
  useEffect(() => {
    if (!proratedTouched) setProratedAmount(autoProrated);
  }, [autoProrated, proratedTouched]);

  // Tiền điện = (cuối − đầu) × đơn giá điện (chỉ hiển thị, auto).
  const electricAmount =
    currentReading != null && currentReading > previousReading
      ? Math.round((currentReading - previousReading) * (pricing.elec || 0))
      : 0;

  // ── Emit mảng ExtraChargeItem chuẩn hoá lên cha ─────────────────────────
  useEffect(() => {
    const items: ExtraChargeItem[] = [];
    if (proratedAmount > 0) {
      items.push({
        kind: "PRORATED",
        description: `Tiền phòng + Nước + PDV (${days} ngày ở thêm)`,
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
    customRows.reduce((s, r) => s + (r.name.trim() && r.amount > 0 ? r.amount : 0), 0);

  const addCustomRow = () =>
    setCustomRows((rows) => [
      ...rows,
      { id: ++customRowSeq, name: "", amount: 0 },
    ]);
  const updateCustomRow = (id: number, patch: Partial<CustomRow>) =>
    setCustomRows((rows) =>
      rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  const removeCustomRow = (id: number) =>
    setCustomRows((rows) => rows.filter((r) => r.id !== id));

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        Thu thêm
      </h3>

      {/* Dòng 1: Tiền phòng + Nước + PDV (theo số ngày ở thêm) */}
      <div className="grid grid-cols-[1fr_auto_140px] items-center gap-2">
        <span className="text-sm">Tiền phòng + Nước + PDV</span>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            min={0}
            inputMode="numeric"
            className="h-8 w-20 text-sm"
            placeholder="0"
            value={days === 0 ? "" : days}
            onChange={(e) => {
              const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
              setDays(v);
              setProratedTouched(false);
            }}
          />
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            ngày
          </span>
        </div>
        <CurrencyInput
          className="h-8 text-sm"
          value={proratedAmount}
          onChange={(v) => {
            setProratedAmount(v);
            setProratedTouched(true);
          }}
        />
      </div>

      {/* Dòng 2: Tiền điện (chốt số) */}
      <div className="grid grid-cols-[1fr_auto_140px] items-center gap-2">
        <span className="text-sm">Tiền điện</span>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            min={0}
            inputMode="numeric"
            className="h-8 w-24 text-sm"
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
            className="h-8 w-24 text-sm"
            placeholder="Số cuối"
            title="Số điện cuối"
            value={currentReading == null ? "" : currentReading}
            onChange={(e) => {
              const raw = e.target.value;
              setCurrentReading(raw === "" ? null : Math.max(0, Number(raw) || 0));
            }}
          />
        </div>
        <div className="h-8 flex items-center justify-end px-2 text-sm font-medium tabular-nums">
          {formatVND(electricAmount)} đ
        </div>
      </div>

      {/* Dòng 3: Tiền vệ sinh */}
      <div className="grid grid-cols-[1fr_auto_140px] items-center gap-2">
        <span className="text-sm">Tiền vệ sinh</span>
        <span />
        <CurrencyInput
          className="h-8 text-sm"
          value={cleaningAmount}
          onChange={setCleaningAmount}
        />
      </div>

      {/* Dòng tuỳ ý */}
      {customRows.map((r) => (
        <div
          key={r.id}
          className="grid grid-cols-[1fr_140px_auto] items-center gap-2"
        >
          <Input
            className="h-8 text-sm"
            placeholder="Tên khoản thu"
            value={r.name}
            onChange={(e) => updateCustomRow(r.id, { name: e.target.value })}
          />
          <CurrencyInput
            className="h-8 text-sm"
            value={r.amount}
            onChange={(v) => updateCustomRow(r.id, { amount: v })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-red-600"
            onClick={() => removeCustomRow(r.id)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          onClick={addCustomRow}
        >
          <Plus className="h-4 w-4 mr-1" />
          Thêm khoản
        </Button>
        <div className="text-sm">
          Tổng thu thêm:{" "}
          <span className="font-semibold text-red-600">
            {formatVND(total)} đ
          </span>
        </div>
      </div>
    </div>
  );
}
