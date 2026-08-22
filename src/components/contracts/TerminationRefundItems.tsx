import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, CalendarMinus2, Undo2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Button } from "@/components/ui/button";
import { useBuildingServices } from "@/hooks/useBuildingServices";
import { resolveInvoicePricing } from "@/lib/contractServicePricing";
import { prorateAmount, calcProratedDays } from "@/lib/prorateCalculation";
import type { RefundItem } from "@/lib/contractValidation";
import type { ContractWithRelations } from "@/types/contract";

interface TerminationRefundItemsProps {
  contract: ContractWithRelations;
  /** Ngày trả phòng — mặc định cho ô "không ở TỪ ngày" của dòng prorate. */
  moveOutDate?: string;
  /** Emit mảng khoản hoàn đã chuẩn hoá mỗi khi có thay đổi. */
  onChange: (items: RefundItem[]) => void;
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

/** Ngày cuối cùng của tháng chứa `iso`, dạng YYYY-MM-DD. */
function cuoiThangCua(iso?: string): string {
  if (!iso) return "";
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return "";
  // Ngày 0 của tháng kế = ngày cuối tháng này. Dựng bằng UTC để không bị múi giờ
  // đẩy sang tháng khác — đúng lớp lỗi ngày-UTC đã dọn ở 11547392.
  const last = new Date(Date.UTC(y, m, 0));
  return last.toISOString().slice(0, 10);
}

/**
 * Khu vực "Hoàn lại khách" — ngược chiều với "Thu thêm".
 *
 * Dùng cho tình huống thường gặp: khách đã đóng tiền phòng cả tháng rồi trả
 * phòng giữa chừng, phần ngày không ở phải trả lại. Trước đợt 22/08/2026 không
 * có ô nào nhập được khoản này: hoàn cọc bị kẹp ở cọc thực thu, credit bị kẹp ở
 * lot đang có, còn "Thu thêm" chỉ nhận số dương.
 *
 * Component emit-only — mọi phép toán quyết toán nằm ở lib/terminationSettlement
 * và bản plpgsql tương ứng, không tính ở đây.
 */
export function TerminationRefundItems({
  contract,
  moveOutDate,
  onChange,
}: TerminationRefundItemsProps) {
  const buildingId = contract.room?.building_id || "";
  const { data: bldSvc } = useBuildingServices(buildingId);

  // Cùng cơ sở đơn giá với "Thu thêm" để hai mục soi gương nhau: cùng một ngày
  // mà bên thu và bên hoàn ra hai đơn giá khác nhau là dấu hiệu sai, không phải
  // tính năng.
  const defaults = useMemo(() => {
    let elec = 3500;
    let water = 100000;
    let pdv = 150000;
    const danhSach = (bldSvc ?? []) as {
      is_active?: boolean | null;
      unit_price_override?: number | null;
      service?: { name?: string | null; unit_price?: number | null } | null;
    }[];
    for (const bs of danhSach.filter((b) => b.is_active)) {
      const name = bs.service?.name?.toLowerCase() ?? "";
      const price = bs.unit_price_override ?? bs.service?.unit_price ?? 0;
      if (name.includes("điện")) elec = Number(price) || elec;
      else if (name.includes("nước")) water = Number(price) || water;
      else if (name.includes("dịch vụ") || name.includes("phí"))
        pdv = Number(price) || pdv;
    }
    return { elec, water, pdv, elecServiceId: null, waterServiceId: null, pdvServiceId: null };
  }, [bldSvc]);

  const pricing = useMemo(
    () => resolveInvoicePricing(contract.contract_services, defaults),
    [contract.contract_services, defaults],
  );

  const occupants = contract.contract_customers?.length || 1;
  const rent = Number(contract.rent_price) || 0;
  const proratedBase = useMemo(
    () =>
      rent +
      (pricing.waterApplicable ? occupants * pricing.water : 0) +
      (pricing.pdvApplicable ? pricing.pdv : 0),
    [rent, occupants, pricing],
  );

  // ── State ───────────────────────────────────────────────────────────────
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [proratedAmount, setProratedAmount] = useState(0);
  const [proratedTouched, setProratedTouched] = useState(false);
  const [customRows, setCustomRows] = useState<CustomRow[]>([]);

  // Gợi ý khoảng "không ở": từ NGÀY SAU ngày trả phòng đến hết tháng đó. Người
  // dùng sửa được; chỉ gợi ý khi họ chưa tự nhập.
  useEffect(() => {
    if (!moveOutDate) return;
    setFromDate((cu) => {
      if (cu) return cu;
      const d = new Date(`${moveOutDate}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) return cu;
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    });
    setToDate((cu) => cu || cuoiThangCua(moveOutDate));
  }, [moveOutDate]);

  const days = calcProratedDays(fromDate, toDate);
  const autoProrated = days > 0 ? prorateAmount(proratedBase, days) : 0;
  useEffect(() => {
    if (!proratedTouched) setProratedAmount(autoProrated);
  }, [autoProrated, proratedTouched]);

  // ── Emit ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const items: RefundItem[] = [];
    if (proratedAmount > 0) {
      const range =
        fromDate && toDate
          ? ` (${fmtDM(fromDate)}–${fmtDM(toDate)}, ${days} ngày)`
          : "";
      items.push({
        kind: "PRORATED_REFUND",
        description: `Hoàn tiền phòng ngày không ở${range}`,
        amount: proratedAmount,
        days,
        unit_price: proratedBase,
      });
    }
    for (const r of customRows) {
      if (r.name.trim() && r.amount > 0) {
        items.push({ kind: "CUSTOM", description: r.name.trim(), amount: r.amount });
      }
    }
    onChange(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proratedAmount, days, fromDate, toDate, proratedBase, customRows]);

  const total =
    proratedAmount +
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
          Hoàn lại khách
        </h3>
        <span className="text-xs text-muted-foreground normal-case">
          Các khoản mình trả lại khách
        </span>
      </div>

      <div className="rounded-xl border bg-card divide-y divide-border/70 overflow-hidden">
        {/* Dòng 1: tiền phòng những ngày khách KHÔNG ở */}
        <div className="px-3.5 py-3 space-y-2">
          <div className="flex items-center gap-2">
            <CalendarMinus2 className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium">Tiền phòng ngày không ở</span>
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
            <span className="text-xs text-muted-foreground">Không ở từ</span>
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
          {proratedBase > 0 && (
            <p className="pl-6 text-[11px] text-muted-foreground">
              Cơ sở tháng: {formatVND(proratedBase)}đ (tiền phòng
              {pricing.waterApplicable ? " + nước" : ""}
              {pricing.pdvApplicable ? " + PDV" : ""})
            </p>
          )}
        </div>

        {/* Dòng tuỳ ý */}
        {customRows.map((row) => (
          <div key={row.id} className="flex items-center gap-2 px-3.5 py-3">
            <Undo2 className="h-4 w-4 text-muted-foreground shrink-0" />
            <Input
              className="h-9 text-sm"
              placeholder="Tên khoản hoàn (vd: hoàn tiền dịch vụ)"
              value={row.name}
              onChange={(e) => updateCustomRow(row.id, { name: e.target.value })}
            />
            <div className="ml-auto w-36 shrink-0">
              <CurrencyInput
                className="h-9 text-sm text-right"
                value={row.amount}
                onChange={(v) => updateCustomRow(row.id, { amount: v })}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => removeCustomRow(row.id)}
              aria-label="Xoá dòng hoàn"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}

        <div className="flex items-center justify-between px-3.5 py-2.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={addCustomRow}
          >
            <Plus className="h-3.5 w-3.5" />
            Thêm khoản hoàn khác
          </Button>
          <div className="text-sm">
            <span className="text-muted-foreground mr-2">Tổng hoàn</span>
            <b className="tabular-nums">{formatVND(total)} đ</b>
          </div>
        </div>
      </div>
    </div>
  );
}
