// =============================================================================
// Ghi chú phiếu "Trả khách thanh lý" — từng dòng + khung TỔNG HỢP y như lúc bấm
// thanh lý (TerminateDialog §4), tính lại từ hồ sơ đã lưu (quyết định chủ
// 02/09/2026). Ghi chú gốc trong DB vẫn hiện bên dưới (đã xuống dòng) để không
// mất thông tin nào.
// =============================================================================

import { useTerminationRefundFacts } from "@/hooks/useTerminationRefundFacts";
import {
  buildTerminationCard,
  buildTerminationHeaderLines,
  type TerminationCard,
} from "@/lib/terminationRefundNote";
import { formatVND } from "@/lib/utils";

export const TERMINATION_REFUND_SOURCE = "termination.refund";

export interface TerminationVoucherRef {
  id: string;
  system_source?: string | null;
  contract_id?: string | null;
}

/** Phiếu chi hoàn khách thanh lý có HĐ — có hồ sơ để dựng ghi chú. */
export const laPhieuTraKhachThanhLy = (v: TerminationVoucherRef): boolean =>
  v.system_source === TERMINATION_REFUND_SOURCE && !!v.contract_id;

const toneCls = (tone: "red" | "green" | "muted") =>
  tone === "red" ? "text-red-600" : tone === "green" ? "text-emerald-600" : "text-muted-foreground";

function SettlementCard({ card }: { card: TerminationCard }) {
  return (
    <div className="rounded-xl border bg-muted/30 p-3 text-sm" data-testid="termination-settlement-card">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        Tổng hợp
      </div>
      {/* Số tiền KHÔNG được xuống dòng: trên màn 430px, nhãn dài ("Cọc cấn vào
          khấu trừ…") đẩy "618.000 đ" vỡ làm hai hàng, đọc như hai con số. Nhãn
          co lại (min-w-0), số giữ nguyên khối (shrink-0 + nowrap). */}
      <div className="space-y-1">
        {card.rows.map((r) => (
          <div key={r.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-muted-foreground">{r.label}</span>
              <span
                className={`shrink-0 whitespace-nowrap font-medium tabular-nums ${toneCls(r.tone)}`}
              >
                {formatVND(r.amount)}
              </span>
            </div>
            {r.sub?.map((s, i) => (
              <div
                key={i}
                className="flex items-baseline justify-between gap-3 pl-4 text-xs text-muted-foreground"
              >
                <span className="min-w-0">· {s.label}</span>
                <span className="shrink-0 whitespace-nowrap tabular-nums">{formatVND(s.amount)}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 border-t border-dashed pt-1">
          <span className="min-w-0 text-muted-foreground">
            Tổng khấu trừ <span className="text-xs">(công nợ + phạt + thu thêm)</span>
          </span>
          <span className="shrink-0 whitespace-nowrap font-medium tabular-nums text-red-600">
            −{formatVND(card.totalDeductions)}
          </span>
        </div>
      </div>
      <div
        className={`mt-2 flex items-center justify-between rounded-lg border px-3 py-2 ${
          card.net >= 0 ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"
        }`}
      >
        <div className="flex flex-col">
          <span className="font-semibold">{card.netLabel}</span>
          <span className="text-xs text-muted-foreground">Số tiền quyết toán</span>
        </div>
        <span className={`text-lg font-bold tabular-nums ${card.net >= 0 ? "text-emerald-700" : "text-red-700"}`}>
          {formatVND(Math.abs(card.net))}
        </span>
      </div>
      {card.warning ? (
        <div className="mt-2 text-xs text-amber-700">{card.warning}</div>
      ) : null}
    </div>
  );
}

interface Props {
  voucher: TerminationVoucherRef;
  /** income_expenses.notes — hiện bên dưới, đã xuống dòng. */
  fallbackNotes?: string | null;
  enabled?: boolean;
}

export function TerminationRefundNote({ voucher, fallbackNotes, enabled = true }: Props) {
  const ok = laPhieuTraKhachThanhLy(voucher);
  const { data: facts, isLoading, isError } = useTerminationRefundFacts(ok ? voucher.id : null, enabled);
  const notes = fallbackNotes?.trim() || null;

  if (!ok) {
    return notes ? <div className="whitespace-pre-line">{notes}</div> : null;
  }

  const header = facts ? buildTerminationHeaderLines(facts) : null;
  const card = facts ? buildTerminationCard(facts) : null;

  return (
    <div className="space-y-2">
      {isLoading ? (
        <div className="text-muted-foreground">Đang tính bản quyết toán…</div>
      ) : isError ? (
        <div className="text-muted-foreground">Không đọc được hồ sơ thanh lý.</div>
      ) : header ? (
        <div className="whitespace-pre-line" data-testid="termination-refund-note">
          {header.join("\n")}
        </div>
      ) : null}
      {card ? <SettlementCard card={card} /> : null}
      {notes ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Ghi chú gốc của phiếu</summary>
          <div className="whitespace-pre-line mt-1">{notes}</div>
        </details>
      ) : null}
    </div>
  );
}

export default TerminationRefundNote;
