// =============================================================
// Bộ gom TOÀN CỤC của hub realtime — một cụm sự kiện xuyên bảng, một lượt
// invalidate. (21/10/2026, plan realtime + thông báo, mục A4 / RT-HUB-7.)
//
// VẤN ĐỀ ĐO ĐƯỢC
//   Bản trước gom THEO TỪNG BẢNG: mỗi bảng một timer, cộng một timer cho nhóm
//   báo cáo và một bộ gom riêng cho nhóm quyết toán. Một giao dịch chạm nhiều
//   bảng (create_contract_v2 chạm 5 bảng; duyệt phiếu chạm income_expenses +
//   items + accounts) nhả 2–4 lượt cách nhau vài chục ms. Mỗi lượt sau gọi
//   refetchQueries với cancelRefetch=true ⇒ query đang fetch bị huỷ rồi gọi
//   lại, mà request cũ vẫn chạy trên server (queryFn không nhận signal). Cùng
//   một danh sách/thống kê nặng bị tải 2–4 lần cho một thao tác.
//
// CÁCH GOM
//   Một timer cho cả cụm, giữ nguyên nhịp DEBOUNCE_MS / MAX_WAIT_MS (hubDebounce).
//   Khi nhả: hợp tập key của mọi bảng trong cụm (bỏ trùng theo nội dung) rồi
//   invalidate MỖI KEY MỘT LẦN; nhóm báo cáo một lượt theo hợp luật; nhóm quyết
//   toán một lượt; prefetch mỗi domain một lần. Gốc key trong descriptor là tiền
//   tố một-phần-tử nên một query khớp tối đa một lời gọi ⇒ refetch một lần.
//
// TIẾNG VỌNG (localWriteEcho) — giữ nguyên ngữ nghĩa VÀ
//   Cờ tiếng vọng tính THEO BẢNG và nhân VÀ qua mọi event của bảng đó trong cụm:
//   một event ngoài cửa sổ 3s có thể đến từ máy khác nên kéo cả bảng về đường
//   đầy đủ. Key của bảng tiếng vọng gộp về MỘT lời gọi (chỉ query active), bỏ
//   những key đã nằm trong tập đầy đủ, và không prefetch.
// =============================================================

import type { QueryClient } from "@tanstack/react-query";
import {
  BUSINESS_PERFORMANCE_INVALIDATION_RULES,
  type BusinessPerformanceInvalidationRule,
  type SyncEntry,
} from "@/hooks/realtime";
import { flushSettlementInvalidation, isSettlementQueryKey } from "@/hooks/realtime/settlementInvalidation";
import type { PrefetchDomain } from "@/lib/prefetchPages";
import { delayConTrongTran } from "@/lib/realtime/hubDebounce";
import { laTiengVongNoiBo, locTiengVongNoiBo } from "@/lib/realtime/localWriteEcho";
import { nenPrefetchTuHub } from "@/lib/realtime/prefetchGate";
import type { SyncTable } from "@/lib/realtime/syncTables";

const GOC_BAO_CAO = "business-performance";

function laKeyThuong(key: readonly unknown[]): boolean {
  return key[0] !== GOC_BAO_CAO && !isSettlementQueryKey(key);
}

function rulesOf(table: SyncTable): readonly BusinessPerformanceInvalidationRule[] {
  return BUSINESS_PERFORMANCE_INVALIDATION_RULES[
    table as keyof typeof BUSINESS_PERFORMANCE_INVALIDATION_RULES
  ] ?? [];
}

/** Query báo cáo có khớp một trong các luật không — subtype ở vị trí [2], basis ở [4]. */
export function khopLuatBaoCao(
  queryKey: readonly unknown[],
  rules: readonly BusinessPerformanceInvalidationRule[],
): boolean {
  const subtype = queryKey[2];
  return rules.some((rule) => {
    if (rule.subtype !== subtype) return false;
    return rule.subtype !== "pnl" || !rule.basis || queryKey[4] === rule.basis;
  });
}

interface BangCho {
  entry: SyncEntry;
  tiengVong: boolean;
}

function nhaCum(qc: QueryClient, cum: readonly BangCho[]): void {
  const dayDu = new Map<string, readonly unknown[]>();
  const vong = new Map<string, readonly unknown[]>();
  const domains = new Set<PrefetchDomain>();
  for (const { entry, tiengVong } of cum) {
    for (const key of entry.keys) {
      if (!laKeyThuong(key)) continue;
      (tiengVong ? vong : dayDu).set(JSON.stringify(key), key);
    }
    if (entry.domain && !tiengVong) domains.add(entry.domain);
  }

  for (const key of dayDu.values()) qc.invalidateQueries({ queryKey: key as unknown[] });
  for (const id of dayDu.keys()) vong.delete(id);
  if (vong.size > 0) qc.invalidateQueries(locTiengVongNoiBo([...vong.values()]));

  const rules = cum.flatMap(({ entry }) => rulesOf(entry.table));
  if (rules.length > 0) {
    qc.invalidateQueries({
      queryKey: [GOC_BAO_CAO],
      predicate: (query) => khopLuatBaoCao(query.queryKey, rules),
    });
  }

  flushSettlementInvalidation(qc, cum.map(({ entry }) => entry.table));

  // Hâm lại cache prefetch — chỉ khi tab đang mở (nền thì thôi, mở lại tab sẽ
  // theo staleTime tự lo) và qua được các cửa ở prefetchGate.ts. Quyền xem
  // domain kiểm bên trong prefetchPages (RT-HUB-13), vì bảng quyền nằm ở đó và
  // module đó vốn nạp động — kéo nó vào đây là phồng chunk đầu.
  if (domains.size === 0) return;
  if (typeof document === "undefined" || document.visibilityState !== "visible") return;
  for (const domain of domains) {
    if (!nenPrefetchTuHub(domain)) continue;
    import("@/lib/prefetchPages")
      .then((m) => m.prefetchDomainTuHub(qc, domain))
      .catch(() => {});
  }
}

/**
 * Bộ gom một cụm cho hub. `enqueue` gọi cho MỖI event (payload bỏ qua); `dispose`
 * huỷ cụm đang chờ — teardown chủ động không nhả gì (hub sắp chết thì không còn
 * ai để làm tươi, và user đổi thì cache của user cũ không phải việc của hub mới).
 */
export function createHubInvalidationCollector(qc: QueryClient) {
  const pending = new Map<SyncTable, BangCho>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let mocDauCum = 0;

  const flush = () => {
    timer = undefined;
    const cum = [...pending.values()];
    pending.clear();
    nhaCum(qc, cum);
  };

  return {
    enqueue(entry: SyncEntry, bayGio: number) {
      const prev = pending.get(entry.table);
      // Chỉ VÀ mới đúng: event nằm ngoài cửa sổ có thể đến từ máy khác, nên cả
      // bảng chứa nó phải đi đường đầy đủ.
      const tiengVong = (prev?.tiengVong ?? true) && laTiengVongNoiBo(entry.table, bayGio);
      pending.set(entry.table, { entry, tiengVong });
      if (timer !== undefined) clearTimeout(timer);
      else mocDauCum = bayGio;
      timer = setTimeout(flush, delayConTrongTran(mocDauCum, bayGio));
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}
