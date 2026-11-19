import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatCurrency } from "@/lib/utils";
import {
  POST_LOCK_HOW_TO_ADD,
  postLockChipText,
  postLockReason,
  type PostLockVoucher,
} from "@/lib/profitPostLock";

// =============================================================================
// Khối "Phát sinh sau chốt" của Báo cáo Lợi Nhuận (rà 21/10 F06, chủ chốt 22/10/2026): tháng
// đã chốt KHÔNG cộng các khoản tạo/duyệt sau lúc chốt (vd thu tiền hoá đơn của tháng đó) —
// trang tách chúng ra và BÁO LÊN ở đây. Không tự tải dữ liệu.
//
//  - variant "hero"  (desktop): một chip `ph-chip` trong <ProfitHubSlot name="chips">; bấm mở
//    danh sách (Popover).
//  - variant "mobile": thẻ sáng, bấm để xổ danh sách ngay bên dưới.
// =============================================================================

export interface ProfitPostLockNoticeProps {
  /** Khoản đã tách khỏi tháng đã chốt (đúng tháng + phạm vi đang xem). */
  entries: readonly PostLockVoucher[];
  count: number;
  income: number;
  expense: number;
  variant?: "hero" | "mobile";
}

/** Số tiền gọn cho chip: 339,5tr · 650k · 900đ. */
const fmtShortVnd = (n: number): string => {
  const v = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (v >= 1_000_000) return `${sign}${(v / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}tr`;
  if (v >= 1_000) return `${sign}${Math.round(v / 1_000).toLocaleString("vi-VN")}k`;
  return `${sign}${Math.round(v)}đ`;
};

const fmtDay = (iso: string | null | undefined): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
};

/** Thời điểm chốt theo giờ máy người xem: dd/mm/yyyy HH:mm. */
const fmtMoment = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function PostLockList({ entries }: { entries: readonly PostLockVoucher[] }) {
  return (
    <ul className="divide-y">
      {entries.map((v) => (
        <li key={`${v.voucher_id}|${v.building_id}|${v.month}`} className="px-4 py-2.5 text-xs">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">
              {v.restricted ? "Phiếu hạn chế" : v.code || "Phiếu chưa có mã"}
            </span>
            <span className="text-muted-foreground">{v.building_name || "—"}</span>
            <span className={`ml-auto tabular-nums font-semibold ${v.income > 0 ? "text-emerald-700" : "text-orange-700"}`}>
              {v.income > 0 ? `thu ${formatCurrency(v.income)}` : `chi ${formatCurrency(v.expense)}`}
            </span>
          </div>
          {!v.restricted && v.name && <div className="mt-0.5 truncate">{v.name}</div>}
          <div className="mt-0.5 text-muted-foreground">
            Ngày phiếu {fmtDay(v.voucher_date)} · {postLockReason(v)} · tháng chốt {v.month.slice(5, 7)}/{v.month.slice(0, 4)}{" "}
            lúc {fmtMoment(v.locked_at)}
            {v.approved_at ? ` · duyệt ${fmtMoment(v.approved_at)}` : ""}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Detail({ entries, title }: { entries: readonly PostLockVoucher[]; title: string }) {
  return (
    <div>
      <div className="px-4 pt-3 pb-2 border-b">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Các khoản dưới đây tạo/duyệt SAU lúc chốt nên không nằm trong số đã chốt và không cộng vào
          tổng, danh sách thu/chi của tháng. {POST_LOCK_HOW_TO_ADD}.
        </div>
      </div>
      <PostLockList entries={entries} />
    </div>
  );
}

export default function ProfitPostLockNotice({ entries, count, income, expense, variant = "hero" }: ProfitPostLockNoticeProps) {
  const [open, setOpen] = useState(false);
  const text = postLockChipText({ count, income, expense }, fmtShortVnd);
  if (!text) return null;
  const title = `Phát sinh sau chốt — chưa cộng vào tháng đã chốt (${count} khoản)`;

  if (variant === "hero") {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="ph-chip ph-chip--amber" title="Bấm để xem chi tiết">
            <span className="ph-chip__dot" />
            {text}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(92vw,480px)] max-h-[70vh] overflow-y-auto p-0">
          <Detail entries={entries} title={title} />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <div className="rounded-[13px] border border-[#f6d6a8] bg-[#fff4e5] px-[11px] py-[9px] text-[#a35a0c]">
      <button
        type="button"
        className="flex w-full items-start gap-1.5 text-left text-[12px] font-bold"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="mt-[5px] h-[7px] w-[7px] shrink-0 rounded-full bg-[#e0911f]" />
        <span>{text}</span>
      </button>
      <div className="mt-1 text-[11.5px]">{POST_LOCK_HOW_TO_ADD}.</div>
      {open && (
        <div className="mt-2 -mx-[11px] -mb-[9px] rounded-b-[13px] border-t bg-white text-foreground">
          <PostLockList entries={entries} />
        </div>
      )}
    </div>
  );
}
