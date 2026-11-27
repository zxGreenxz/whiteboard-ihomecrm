import {financialReadRows,financialReadNumber} from '@/lib/financialReadValidation';
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { loadIncomeExpenseDetails } from "@/lib/incomeExpenseDetailRpc";
import { withDetailReadDeadline } from "@/hooks/income-expenses/detailRead";

// Đợt 11: đã xoá useDecideApproval / useWithdrawApproval (không còn nơi gọi). Tệp còn các hook ĐỌC hộp duyệt (Hermes
// chép vùng pending-approvals, xem infra/hermes-broker/web-parity.json).

// Một yêu cầu duyệt đang chờ CHÍNH TÔI xử lý — khớp cột của
// public.list_my_pending_approvals_v1() (server đã lọc theo auth.uid(), client
// không truyền tham số nào).
export interface PendingApproval {
  is_maker?: boolean;
  request_id: string;
  submission_no: number;
  submitted_at: string;
  amount: number;
  voucher_id: string;
  voucher_code: string | null;
  voucher_name: string | null;
  voucher_type: string | null;
  maker_name: string | null;
  step_no: number;
  request_version: number;
  // Finance V2 (route-aware §9.6): các cột dưới do server bổ sung dần vào RPC —
  // khi RPC chưa trả thì null/1 ⇒ org resolve LEGACY, inbox giữ nguyên flow
  // decide_financial_request_v2 hiện tại (fail-safe, không đoán CANONICAL).
  organization_id: string | null;
  approval_version: number;
  posting_version: number;
  // Badge "Do AI nộp" (G4, 2026-09-03): RPC hiện KHÔNG chiếu cột này ra
  // (xem AiSubmittedBadge.tsx) — luôn null trên production hôm nay, giữ field
  // để UI tự sáng lên ngay khi RPC được nới thêm cột, không cần đổi FE nữa.
  system_source: string | null;
}

/**
 * Nhịp làm tươi hộp duyệt khi KHÔNG có realtime phủ (21/10/2026, RT-HUB-4).
 *
 * Từ chối và duyệt bước giữa chỉ ghi approval_requests / approval_request_steps.
 * Hai bảng đó không đưa vào publication được: cả hai chỉ có policy RESTRICTIVE
 * (ranh giới công ty, ẩn sandbox), KHÔNG có policy SELECT cho phép nào, nên
 * Realtime — vốn chỉ giao event cho dòng người nghe SELECT được — sẽ không giao
 * gì cho ai (đọc thật đi qua RPC SECURITY DEFINER list_my_pending_approvals_v1).
 * Hub chỉ phủ lúc nộp và bước cuối (qua income_expenses). Phần còn lại: poll
 * 60s khi tab đang hiện + tải lại lúc quay về tab.
 */
export const PENDING_APPROVALS_POLL_MS = 60_000;

// Danh sách yêu cầu chờ tôi duyệt. numeric/bigint của Postgres về JS dưới dạng
// string qua PostgREST → ép Number ngay để UI khỏi cộng chuỗi.
export const usePendingApprovals = () => {
  return useQuery({
    queryKey: ["pending-approvals"],
    meta: {errorDisplay:"inline",label:"yêu cầu chờ duyệt"},
    refetchInterval: PENDING_APPROVALS_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<PendingApproval[]> => {
      // hermes-parity:begin pending-approvals — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
      const { data, error } = await supabase.rpc("list_my_pending_approvals_v1");
      // hermes-parity:end pending-approvals
      if (error) throw error;

      return financialReadRows(data as any[]).map((r) => ({
        request_id: r.request_id,
        submission_no: Number(r.submission_no ?? 0),
        submitted_at: r.submitted_at,
        amount: financialReadNumber(r.amount),
        voucher_id: r.voucher_id,
        voucher_code: r.voucher_code ?? null,
        voucher_name: r.voucher_name ?? null,
        voucher_type: r.voucher_type ?? null,
        maker_name: r.maker_name ?? null,
        is_maker: r.is_maker === true,
        step_no: Number(r.step_no ?? 0),
        request_version: Number(r.request_version ?? 0),
        organization_id: r.organization_id ?? null,
        approval_version: Number(r.approval_version ?? 1),
        posting_version: Number(r.posting_version ?? 1),
        system_source: r.system_source ?? null,
      }));
    },
  });
};

/** Nguồn + sổ quỹ của phiếu đứng sau một yêu cầu chờ duyệt. */
export interface PendingVoucherSource {
  system_source: string | null;
  account_id: string | null;
}

/** Chi tiết phiếu tối thiểu mà phần đọc nguồn cần (đường thật: read_income_expense_details_v1). */
export interface PendingVoucherDetail {
  id: string;
  organization_id: string | null;
  system_source?: string | null;
  account_id?: string | null;
}

/** Đọc chi tiết một lô phiếu của MỘT công ty; ném khi lô không đọc trọn (thiếu phiếu, mất mạng, hết giờ). */
export type PendingVoucherDetailReader = (organizationId: string, voucherIds: string[]) => Promise<readonly PendingVoucherDetail[]>;

const readPendingVoucherDetails: PendingVoucherDetailReader = (organizationId, voucherIds) =>
  withDetailReadDeadline(loadIncomeExpenseDetails(organizationId, voucherIds));

/**
 * Nguồn phiếu theo từng công ty, cô lập lỗi: lô của các công ty đọc SONG SONG; lô nào lỗi (một phiếu không
 * đọc được làm `readIncomeExpenseDetails` ném cả lô — vd phiếu DEMO người duyệt không xem được chi tiết)
 * thì đọc LẺ từng phiếu của đúng công ty đó, cũng song song (Promise.allSettled — không chờ hết giờ nối
 * tiếp), để các phiếu khác vẫn rõ loại. Phiếu vẫn không đọc được thì VẮNG trong kết quả — màn hình báo
 * "chưa rõ loại" đúng dòng đó. Chỉ khi không đọc được phiếu nào (vd mất mạng) mới ném lỗi đầu tiên, để màn
 * hình giữ câu báo chung + "Thử lại".
 */
export async function readPendingVoucherSources(
  groups: ReadonlyArray<readonly [string, readonly string[]]>,
  read: PendingVoucherDetailReader = readPendingVoucherDetails,
): Promise<Record<string, PendingVoucherSource>> {
  const result: Record<string, PendingVoucherSource> = {};
  const failures: unknown[] = [];
  const take = (org: string, ids: readonly string[], details: readonly PendingVoucherDetail[]) => {
    for (const detail of details) {
      if (detail.organization_id !== org || !ids.includes(detail.id)) continue;
      result[detail.id] = { system_source: detail.system_source ?? null, account_id: detail.account_id ?? null };
    }
  };
  const batches = await Promise.allSettled(groups.map(([org, ids]) => read(org, [...ids])));
  const singles: Promise<void>[] = [];
  groups.forEach(([org, ids], index) => {
    const batch = batches[index];
    if (batch?.status === "fulfilled") {
      take(org, ids, batch.value);
      return;
    }
    // allSettled trả đúng một kết quả cho mỗi lô; thiếu (không thể xảy ra) thì coi như lô lỗi.
    const reason: unknown = batch ? batch.reason : new Error("Thiếu kết quả đọc lô phiếu chờ duyệt");
    // Lô một phiếu: lỗi của lô chính là lỗi của phiếu đó, không đọc lại.
    if (ids.length <= 1) {
      failures.push(reason);
      return;
    }
    singles.push(
      Promise.allSettled(ids.map(async (id) => ({ id, details: await read(org, [id]) }))).then((outcomes) => {
        for (const outcome of outcomes) {
          if (outcome.status === "fulfilled") take(org, [outcome.value.id], outcome.value.details);
          else failures.push(outcome.reason);
        }
      }),
    );
  });
  await Promise.all(singles);
  if (failures.length > 0 && Object.keys(result).length === 0) throw failures[0];
  return result;
}

/**
 * Nguồn phiếu của các yêu cầu đang chờ (list_my_pending_approvals_v1 KHÔNG chiếu system_source — cột cùng
 * tên ở trên luôn null). Đọc qua read_income_expense_details_v1 — cùng đường hộp "Duyệt và Thu/Chi…" đang
 * dùng, không bị RLS che như đọc thẳng bảng — gom theo công ty, lỗi cô lập theo công ty/phiếu
 * (readPendingVoucherSources). Phiếu không đọc được thì vắng trong kết quả: màn hình coi là "chưa rõ loại"
 * (duyệt như phiếu thường, nói rõ máy chủ sẽ chặn phiếu chi lợi nhuận).
 * Khoá dưới gốc "pending-approvals" nên mọi lần làm mới hộp thư cũng làm mới phần này.
 */
export const usePendingApprovalSources = (rows: readonly PendingApproval[]) => {
  const groups = useMemo(() => {
    const byOrg = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.organization_id || !row.voucher_id) continue;
      const ids = byOrg.get(row.organization_id) ?? new Set<string>();
      ids.add(row.voucher_id);
      byOrg.set(row.organization_id, ids);
    }
    return [...byOrg.entries()]
      .map(([org, ids]) => [org, [...ids].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);
  return useQuery({
    queryKey: ["pending-approvals", "voucher-sources", groups],
    enabled: groups.length > 0,
    // Danh sách chờ đổi (duyệt xong một dòng) ⇒ khoá mới: giữ câu trả lời cũ cho các dòng đã biết trong lúc
    // đọc lại (isPlaceholderData), dòng mới coi là "đang kiểm tra".
    placeholderData: keepPreviousData,
    meta: { errorDisplay: "inline", label: "loại phiếu chờ duyệt" },
    queryFn: (): Promise<Record<string, PendingVoucherSource>> => readPendingVoucherSources(groups),
  });
};
