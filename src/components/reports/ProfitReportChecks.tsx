import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatCurrency } from "@/lib/utils";
import type {
  FixedFeeCell,
  ProfitReportChecksResult,
  RoomNotesSummary,
  StalePendingVoucher,
} from "@/lib/profitReportChecks";

// =============================================================================
// Chip cảnh báo của Báo cáo Lợi Nhuận — trình bày kết quả `computeProfitReportChecks`
// (+ tuỳ chọn `summarizeRoomNotes`). Không tự tải dữ liệu.
//
//  - variant "hero"  (desktop): trả về các chip `ph-chip` để đặt trong
//    <ProfitHubSlot name="chips">; bấm chip mở bảng chi tiết (Popover).
//  - variant "mobile": một thẻ sáng gồm hàng chip + phần chi tiết xổ ngay bên dưới.
//
// Không bao giờ hiện màu xanh "khớp" khi còn cảnh báo: chip trung tính "Chi cố định
// đủ" chỉ hiện khi KHÔNG còn khoản thiếu/trùng nào.
// =============================================================================

type Section = "missing" | "duplicate" | "stale";
type Tone = "red" | "amber" | "yellow" | "neutral";

export interface ProfitReportChecksProps {
  /** Kết quả computeProfitReportChecks; null/undefined khi chưa tính (đang tải / tắt). */
  checks: ProfitReportChecksResult | null | undefined;
  /** Tóm tắt ghi chú phòng (summarizeRoomNotes) — truyền khi muốn gộp chip phòng vào đây. */
  roomSummary?: RoomNotesSummary | null;
  variant?: "hero" | "mobile";
  /** Bấm "Lập phiếu" ở một khoản thiếu. Không truyền (vd thiếu quyền) thì không có nút. */
  onCreateExpense?: (cell: FixedFeeCell) => void;
}

/** Số tiền gọn cho chip: 339,5tr · 650k · 900đ. */
const fmtShortVnd = (n: number): string => {
  const v = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (v >= 1_000_000) {
    return `${sign}${(v / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}tr`;
  }
  if (v >= 1_000) return `${sign}${Math.round(v / 1_000).toLocaleString("vi-VN")}k`;
  return `${sign}${Math.round(v)}đ`;
};

/** 'YYYY-MM-DD' → 'dd/mm/yyyy' (cắt chuỗi, không lệch múi giờ). */
const fmtDay = (iso: string | null | undefined): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
};

const pct = (ratio: number | null): string => (ratio == null ? "" : ` (${Math.round(ratio * 100)}%)`);

/** Gom ô theo toà, giữ thứ tự vào. */
const groupByBuilding = (cells: readonly FixedFeeCell[]): { id: string; name: string; cells: FixedFeeCell[] }[] => {
  const groups: { id: string; name: string; cells: FixedFeeCell[] }[] = [];
  const at = new Map<string, number>();
  for (const c of cells) {
    const i = at.get(c.buildingId);
    if (i == null) {
      at.set(c.buildingId, groups.length);
      groups.push({ id: c.buildingId, name: c.buildingName || "—", cells: [c] });
    } else groups[i].cells.push(c);
  }
  return groups;
};

const missingText = (c: FixedFeeCell): string => {
  if (c.status === "MISSING") {
    return c.expected != null ? `chưa có phiếu · mức ${formatCurrency(c.expected)}` : "chưa có phiếu · chưa khai mức";
  }
  return `mới có ${formatCurrency(c.actual)} / mức ${formatCurrency(c.expected)}${pct(c.ratio)}`;
};

const duplicateText = (c: FixedFeeCell): string =>
  c.duplicateReason === "SAME_AMOUNT"
    ? `${formatCurrency(c.actual)} · có phiếu trùng số tiền (chưa khai mức)`
    : `${formatCurrency(c.actual)} / mức ${formatCurrency(c.expected)}${pct(c.ratio)}`;

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="px-4 pt-3 pb-2 border-b">
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>
    </div>
  );
}

function MissingDetail({
  checks,
  onCreateExpense,
}: {
  checks: ProfitReportChecksResult;
  onCreateExpense?: (cell: FixedFeeCell) => void;
}) {
  const f = checks.fixedFees;
  const cells = f.issues.filter((c) => c.status === "MISSING" || c.status === "SHORT");
  const hint =
    f.missingAmount > 0
      ? `Lợi nhuận có thể đang cao hơn thật khoảng ${formatCurrency(f.missingAmount)}` +
        (f.unpricedMissingCount > 0 ? ` (chưa kể ${f.unpricedMissingCount} khoản chưa khai mức).` : ".")
      : "Lợi nhuận có thể đang cao hơn thật vì thiếu các khoản dưới đây.";
  return (
    <div>
      <SectionTitle title="Chi cố định còn thiếu trong tháng" hint={hint} />
      <ul className="divide-y">
        {groupByBuilding(cells).map((g) => (
          <li key={g.id} className="px-4 py-2.5">
            <div className="text-sm font-medium">{g.name}</div>
            <ul className="mt-1 space-y-1">
              {g.cells.map((c) => (
                <li key={c.key} className="flex items-start gap-2 text-xs">
                  <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${c.status === "MISSING" ? "bg-red-500" : "bg-amber-500"}`} />
                  <span className="flex-1 min-w-0">
                    <span className="font-medium">{c.label}</span>
                    <span className="text-muted-foreground">: {missingText(c)}</span>
                    {c.pendingAmount > 0 && (
                      <span className="text-muted-foreground"> · {formatCurrency(c.pendingAmount)} đang chờ duyệt</span>
                    )}
                  </span>
                  {onCreateExpense && (
                    <button
                      type="button"
                      className="shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium hover:bg-muted"
                      onClick={() => onCreateExpense(c)}
                    >
                      Lập phiếu
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DuplicateDetail({ checks }: { checks: ProfitReportChecksResult }) {
  const f = checks.fixedFees;
  const cells = f.issues.filter((c) => c.status === "POSSIBLE_DUPLICATE");
  const hint =
    f.excessAmount > 0
      ? `Vượt mức khai khoảng ${formatCurrency(f.excessAmount)} — lợi nhuận có thể đang thấp hơn thật nếu là phiếu lập trùng.`
      : "Có thể có phiếu lập trùng (phiếu tự lập và phiếu lập tay cùng kỳ) — kiểm từng phiếu bên dưới.";
  return (
    <div>
      <SectionTitle title="Chi cố định có thể bị trùng" hint={hint} />
      <ul className="divide-y">
        {groupByBuilding(cells).map((g) => (
          <li key={g.id} className="px-4 py-2.5">
            <div className="text-sm font-medium">{g.name}</div>
            {g.cells.map((c) => (
              <div key={c.key} className="mt-1 text-xs">
                <div>
                  <span className="font-medium">{c.label}</span>
                  <span className="text-muted-foreground">: {duplicateText(c)}</span>
                </div>
                <ul className="mt-0.5 ml-3 space-y-0.5 text-muted-foreground">
                  {c.vouchers.map((v) => (
                    <li key={v.voucherId}>
                      {v.voucherName || "Phiếu không tên"} · {fmtDay(v.voucherDate)} · {formatCurrency(v.amount)}
                      {v.pending ? " · chờ duyệt" : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StaleDetail({ checks }: { checks: ProfitReportChecksResult }) {
  const s = checks.stalePending;
  return (
    <div>
      <SectionTitle
        title={`Phiếu chờ duyệt quá ${s.thresholdDays} ngày`}
        hint="Các phiếu này đang được cộng vào tổng tháng dù chưa ai duyệt — duyệt hoặc huỷ để số liệu chắc chắn."
      />
      <ul className="divide-y">
        {s.vouchers.map((v: StalePendingVoucher) => (
          <li key={v.voucherId} className="px-4 py-2 text-xs">
            <div className="text-sm font-medium">{v.voucherName || "Phiếu không tên"}</div>
            <div className="text-muted-foreground">
              {v.buildingName || "—"} · ngày phiếu {fmtDay(v.voucherDate)} · đã {v.ageDays} ngày
            </div>
            <div>
              {v.expense > 0 && <span>Chi {formatCurrency(v.expense)}</span>}
              {v.expense > 0 && v.income > 0 && " · "}
              {v.income > 0 && <span>Thu {formatCurrency(v.income)}</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ChipDef {
  key: string;
  tone: Tone;
  text: string;
  section?: Section;
}

const buildChips = (
  checks: ProfitReportChecksResult | null | undefined,
  room: RoomNotesSummary | null | undefined,
): ChipDef[] => {
  const chips: ChipDef[] = [];
  if (checks) {
    const f = checks.fixedFees;
    if (f.missingBuildingCount > 0) {
      chips.push({
        key: "missing",
        tone: "red",
        section: "missing",
        text:
          `Thiếu chi cố định: ${f.missingBuildingCount} toà` +
          (f.missingAmount > 0 ? ` · ≈${fmtShortVnd(f.missingAmount)}` : ""),
      });
    }
    if (f.duplicateBuildingCount > 0) {
      chips.push({
        key: "duplicate",
        tone: "amber",
        section: "duplicate",
        text:
          `Có thể trùng: ${f.duplicateBuildingCount} toà` +
          (f.excessAmount > 0 ? ` · ≈${fmtShortVnd(f.excessAmount)}` : ""),
      });
    }
    const s = checks.stalePending;
    if (s.count > 0) {
      chips.push({
        key: "stale",
        tone: "yellow",
        section: "stale",
        text: `Chờ duyệt quá ${s.thresholdDays} ngày: ${s.count} phiếu · ${fmtShortVnd(s.income + s.expense)}`,
      });
    }
  }
  if (room) {
    if (room.missingInvoiceRooms > 0) {
      chips.push({ key: "no-invoice", tone: "red", text: `${room.missingInvoiceRooms} phòng chưa có hoá đơn` });
    }
    if (room.unpaidInvoiceRooms > 0) {
      chips.push({
        key: "unpaid",
        tone: "amber",
        text:
          `${room.unpaidInvoiceRooms} hoá đơn chưa thu · ${fmtShortVnd(room.unpaidInvoiceAmount)}` +
          (room.overdueInvoiceRooms > 0 ? ` (${room.overdueInvoiceRooms} quá hạn)` : ""),
      });
    }
    if (room.endedUnsettled > 0) {
      chips.push({ key: "ended", tone: "red", text: `${room.endedUnsettled} HĐ kết thúc chưa thanh lý` });
    }
    if (room.vacantRooms > 0) {
      chips.push({ key: "vacant", tone: "amber", text: `${room.vacantRooms} phòng trống` });
    }
  }
  // Chỉ khi KHÔNG còn khoản thiếu/trùng nào — màu trung tính, không phải xanh "khớp".
  if (checks && checks.fixedFees.checkedBuildingCount > 0 && checks.fixedFees.issues.length === 0) {
    chips.push({ key: "fixed-ok", tone: "neutral", text: `Chi cố định đủ · ${checks.fixedFees.checkedBuildingCount} toà` });
  }
  return chips;
};

const HERO_TONE: Record<Tone, string> = {
  red: "ph-chip ph-chip--red",
  amber: "ph-chip ph-chip--amber",
  yellow: "ph-chip ph-chip--yellow",
  neutral: "ph-chip",
};

const MOBILE_TONE: Record<Tone, string> = {
  red: "bg-[#fdecea] border-[#f5c6c0] text-[#a33731]",
  amber: "bg-[#fff4e5] border-[#f6d6a8] text-[#a35a0c]",
  yellow: "bg-[#fdf8e1] border-[#efe0a2] text-[#7d5d0c]",
  neutral: "bg-[#faf8f4] border-[#e7e3da] text-[#514c42]",
};

const MOBILE_DOT: Record<Tone, string> = {
  red: "bg-[#d6453f]",
  amber: "bg-[#e0911f]",
  yellow: "bg-[#c9a227]",
  neutral: "bg-[#b5ae9f]",
};

function Detail({
  section,
  checks,
  onCreateExpense,
}: {
  section: Section;
  checks: ProfitReportChecksResult;
  onCreateExpense?: (cell: FixedFeeCell) => void;
}) {
  if (section === "missing") return <MissingDetail checks={checks} onCreateExpense={onCreateExpense} />;
  if (section === "duplicate") return <DuplicateDetail checks={checks} />;
  return <StaleDetail checks={checks} />;
}

/**
 * Danh sách khoản chi cố định THIẾU / THIẾU SỐ / CÓ THỂ TRÙNG (không chip, không nút) — dùng
 * trong hộp xác nhận chốt lợi nhuận (rà 21/10, F20). Không có cảnh báo nào thì không vẽ gì.
 */
export function FixedFeeIssueList({ checks }: { checks: ProfitReportChecksResult }) {
  const f = checks.fixedFees;
  if (f.issues.length === 0) return null;
  return (
    <div className="divide-y rounded-md border">
      {f.missingBuildingCount > 0 && <MissingDetail checks={checks} />}
      {f.duplicateBuildingCount > 0 && <DuplicateDetail checks={checks} />}
    </div>
  );
}

export default function ProfitReportChecks({
  checks,
  roomSummary,
  variant = "hero",
  onCreateExpense,
}: ProfitReportChecksProps) {
  const [open, setOpen] = useState<Section | null>(null);
  const chips = buildChips(checks, roomSummary);
  if (chips.length === 0) return null;

  if (variant === "hero") {
    return (
      <>
        {chips.map((c) =>
          c.section && checks ? (
            <Popover key={c.key}>
              <PopoverTrigger asChild>
                <button type="button" className={HERO_TONE[c.tone]} title="Bấm để xem chi tiết">
                  {c.tone !== "neutral" && <span className="ph-chip__dot" />}
                  {c.text}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[min(92vw,460px)] max-h-[70vh] overflow-y-auto p-0">
                <Detail section={c.section} checks={checks} onCreateExpense={onCreateExpense} />
              </PopoverContent>
            </Popover>
          ) : (
            <span key={c.key} className={HERO_TONE[c.tone]}>
              {c.tone !== "neutral" && <span className="ph-chip__dot" />}
              {c.text}
            </span>
          ),
        )}
      </>
    );
  }

  const shown = open && checks && chips.some((c) => c.section === open) ? open : null;
  return (
    <div className="rounded-[13px] border border-[#e7e3da] bg-white px-[11px] py-[9px] shadow-[0_1px_2px_rgba(27,24,19,.05)]">
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => {
          const cls = `inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-bold ${MOBILE_TONE[c.tone]}`;
          const dot = c.tone !== "neutral" ? <span className={`h-[7px] w-[7px] rounded-full ${MOBILE_DOT[c.tone]}`} /> : null;
          const section = c.section;
          return section ? (
            <button
              key={c.key}
              type="button"
              className={cls}
              aria-expanded={shown === section}
              onClick={() => setOpen((cur) => (cur === section ? null : section))}
            >
              {dot}
              {c.text}
            </button>
          ) : (
            <span key={c.key} className={cls}>
              {dot}
              {c.text}
            </span>
          );
        })}
      </div>
      {shown && checks && (
        <div className="mt-2 -mx-[11px] border-t">
          <Detail section={shown} checks={checks} onCreateExpense={onCreateExpense} />
        </div>
      )}
    </div>
  );
}
