import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import {voucherFailureMessage} from '@/lib/voucherFeedback';
import { useRef } from 'react';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
// Sổ nhận tiền theo hình thức thu (đợt 1 sửa phiếu, 25/09/2026).
//
// Luật "hình thức nào vào sổ nào" nay ở MÁY CHỦ (thay cho src/lib/cashAccount.ts):
//   TM  = sổ tiền mặt riêng của NGƯỜI THU (app_private.personal_cash_books)
//   TK/TT = sổ mặc định của toà + sổ phụ, giao với sổ người thu đang giữ/biết
// Màn thu tiền đọc danh sách qua get_receiving_cashbooks_v1; máy chủ chặn sổ ngoài
// danh sách lúc thu (record_invoice_collection_v5) và lúc đổi hình thức thu.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import { rpcNullable } from "@/lib/rpcNullable";

export type ReceivingMethod = "TM" | "TK" | "TT";

const bookSchema = z.object({ id: z.string(), name: z.string(), isDefault: z.boolean().optional() });
export type ReceivingBook = z.infer<typeof bookSchema>;

export const receivingCashbooksSchema = z.object({
  collectorUserId: z.string(),
  personalCashBook: z.object({ id: z.string(), name: z.string() }).nullable(),
  TK: z.array(bookSchema),
  TT: z.array(bookSchema),
});
export type ReceivingCashbooks = z.infer<typeof receivingCashbooksSchema>;

/** Danh sách sổ được nhận cho một hình thức (TM = [sổ riêng]). Mặc định đứng đầu. */
export function receivingBooksFor(data: ReceivingCashbooks | undefined, method: ReceivingMethod): ReceivingBook[] {
  if (!data) return [];
  if (method === "TM") return data.personalCashBook ? [{ ...data.personalCashBook, isDefault: true }] : [];
  return data[method];
}

/** Sổ chọn sẵn cho một hình thức: sổ mặc định (đứng đầu danh sách). */
export function defaultReceivingBookId(data: ReceivingCashbooks | undefined, method: ReceivingMethod): string | null {
  return receivingBooksFor(data, method)[0]?.id ?? null;
}

/**
 * Câu báo khi hình thức không còn sổ nào để chọn (máy chủ cũng chặn).
 *
 * TK/TT rỗng có HAI nguyên nhân mà danh sách máy chủ trả về không phân biệt được:
 * toà chưa cài sổ, HOẶC người thu không giữ/biết sổ nào trong danh sách của toà
 * (đo production 25/09: tài khoản chủ công ty không giữ sổ nào nên 102LVT đã cài
 * MBHIEP vẫn ra rỗng). Câu phải nêu cả hai, đừng đổ cho "toà chưa cài".
 */
export function missingReceivingBookMessage(method: ReceivingMethod, buildingName?: string | null): string {
  if (method === "TM") return "Người thu chưa có sổ tiền mặt riêng — nhờ chủ công ty cài ở Sổ nhận tiền.";
  const ht = method === "TK" ? "Chuyển khoản" : "Thanh toán";
  return (
    `Người thu chưa dùng được sổ nhận ${ht} nào của toà ${buildingName || "này"}: toà chưa cài sổ, ` +
    `hoặc người thu chưa được giao giữ/biết sổ đó — nhờ chủ công ty kiểm ở Sổ quỹ → Sổ nhận tiền.`
  );
}

export function useReceivingCashbooks(
  organizationId: string | null | undefined,
  buildingId: string | null | undefined,
  collectorUserId?: string | null,
) {
  return useQuery({
    queryKey: ["receiving-cashbooks", organizationId, buildingId ?? null, collectorUserId ?? null],
    enabled: !!organizationId,
    staleTime: 60_000,
    queryFn: async (): Promise<ReceivingCashbooks> => {
      const { data, error } = await supabase.rpc("get_receiving_cashbooks_v1", {
        p_organization_id: organizationId as string,
        p_building_id: buildingId ?? undefined,
        p_collector_user_id: collectorUserId ?? undefined,
      });
      if (error) throw error;
      return receivingCashbooksSchema.parse(data);
    },
  });
}

// ── Màn cài "Sổ nhận tiền" (chủ công ty) ────────────────────────────────────

export const receivingSettingsSchema = z.object({
  members: z.array(
    z.object({
      membershipId: z.string(),
      userId: z.string(),
      name: z.string().nullable(),
      memberType: z.string().nullable(),
      personalCashBook: z.object({ id: z.string(), name: z.string() }).nullable(),
    }),
  ),
  buildings: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      TK: z.object({ defaultAccountId: z.string().nullable(), extraAccountIds: z.array(z.string()) }),
      TT: z.object({ defaultAccountId: z.string().nullable(), extraAccountIds: z.array(z.string()) }),
    }),
  ),
  accounts: z.array(
    z.object({ id: z.string(), name: z.string(), custodianMembershipIds: z.array(z.string()) }),
  ),
});
export type ReceivingSettings = z.infer<typeof receivingSettingsSchema>;

export function useReceivingCashbookSettings(organizationId: string | null | undefined, enabled = true) {
  return useQuery({
    meta: {feedback:"inline"},
    queryKey: ["receiving-cashbook-settings", organizationId],
    enabled: enabled && !!organizationId,
    queryFn: async (): Promise<ReceivingSettings> => {
      const { data, error } = await supabase.rpc("list_receiving_cashbook_settings_v1", {
        p_organization_id: organizationId as string,
      });
      if (error) throw error;
      return receivingSettingsSchema.parse(data);
    },
  });
}

function invalidateReceiving(client: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    client.invalidateQueries({ queryKey: ["receiving-cashbook-settings"] }),
    client.invalidateQueries({ queryKey: ["receiving-cashbooks"] }),
    client.invalidateQueries({ queryKey: ["buildings"] }),
  ]);
}

export function useSetPersonalCashBook(memberName?: string) {
  const client = useQueryClient();
  const guard = useRef(persistentFinancialWorkflow('receiving-personal',{scope:'actor'}));
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (input: { membershipId: string; accountId: string | null }) => guard.current.run(input.membershipId, "lưu sổ tiền mặt riêng", async () => {
      const { data, error } = await supabase.rpc("set_personal_cash_book_v1", {
        p_membership_id: input.membershipId,
        p_account_id: rpcNullable(input.accountId),
      });
      if (error) throw error;
      const parsed = z.object({membershipId:z.string().min(1),personalCashBook:z.object({id:z.string().min(1),name:z.string()}).nullable()}).safeParse(data);
      if (!parsed.success || parsed.data.membershipId !== input.membershipId || (parsed.data.personalCashBook === null ? null : parsed.data.personalCashBook.id) !== input.accountId) throw new FinancialWorkflowError('Chưa xác nhận được sổ tiền mặt riêng đã lưu. Tải lại cấu hình để đối chiếu trước khi đổi tiếp.', 'unknown', []);
      return data;
    }),
    onSuccess: async () => {
      await invalidateReceiving(client);
      toast.success("Đã lưu sổ tiền mặt riêng" + (memberName ? " của " + memberName : "") + ".");
    },
  });
}

export function useSetBuildingReceivingCashbooks(buildingName?: string) {
  const client = useQueryClient();
  const guard = useRef(persistentFinancialWorkflow('receiving-building',{scope:'actor'}));
  return useMutation({
    meta: {handlesFeedback:true},
    mutationFn: async (input: {
      buildingId: string;
      method: "TK" | "TT";
      defaultAccountId: string | null;
      extraAccountIds: string[];
    }) => guard.current.run(input.buildingId + input.method, "lưu sổ nhận tiền của tòa", async () => {
      const { data, error } = await supabase.rpc("set_building_receiving_cashbooks_v1", {
        p_building_id: input.buildingId,
        p_method: input.method,
        p_default_account_id: rpcNullable(input.defaultAccountId),
        p_extra_account_ids: input.extraAccountIds,
      });
      if (error) throw error;
      const value = data as {buildingId?:string;method?:string;defaultAccountId?:string|null;extraAccountIds?:unknown} | null;
      if (!value || value.buildingId !== input.buildingId || value.method !== input.method || value.defaultAccountId !== input.defaultAccountId || !Array.isArray(value.extraAccountIds) || [...value.extraAccountIds].sort().join('|') !== [...new Set(input.extraAccountIds)].filter(id => id !== input.defaultAccountId).sort().join('|')) throw new FinancialWorkflowError('Chưa xác nhận được cấu hình sổ nhận tiền đã lưu. Tải lại cấu hình của tòa để đối chiếu trước khi đổi tiếp.', 'unknown', []);
      return data;
    }),
    onSuccess: async () => {
      await invalidateReceiving(client);
      toast.success("Đã lưu cấu hình sổ nhận tiền của tòa" + (buildingName ? " " + buildingName : "") + ".");
    },
  });
}

// ── Đổi hình thức thu của một dòng thu ──────────────────────────────────────

export const changeTenderMethodResultSchema = z.object({
  tenderId: z.string().min(1),
  voucherId: z.string().min(1),
  changed: z.boolean(),
  replayed: z.boolean().optional(),
  revisionNo: z.number().optional(),
  from: z.object({ method: z.string(), accountId: z.string().nullable(), accountName: z.string().nullable() }).optional(),
  to: z.object({ method: z.string(), accountId: z.string().nullable(), accountName: z.string().nullable() }).optional(),
});

export interface ChangeTenderMethodInput {
  tenderId: string;
  method: ReceivingMethod;
  /** null = sổ mặc định của hình thức mới. */
  accountId: string | null;
  reason: string;
  idempotencyKey?: string;
}

export function useChangeCollectionTenderMethod() {
  const client = useQueryClient();
  const guard=useRef(persistentFinancialWorkflow('collection-tender-method',{scope:'actor'}));
  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async (input: ChangeTenderMethodInput) => guard.current.run(input.tenderId,"đổi hình thức thu",async progress=>{
      const { data, error } = await supabase.rpc("change_collection_tender_method_v1", {
        p_tender_id: input.tenderId,
        p_new_method: input.method,
        p_new_account_id: input.accountId ?? undefined,
        p_reason: input.reason.trim(),
        p_idempotency_key: progress.requestKey,
      });
      if (error) throw error;
      const parsed=changeTenderMethodResultSchema.safeParse(data);
      if(!parsed.success) throw new TypeError("Chưa xác nhận được kết quả đổi hình thức thu.");
      const result=parsed.data;
      if(result.tenderId!==input.tenderId || (result.changed && !result.replayed && (!result.to || result.to.method!==input.method || (input.accountId!==null && result.to.accountId!==input.accountId))))throw new TypeError("Chưa xác nhận được đúng khoản thu và sổ nhận sau thay đổi.");
      progress.completed.push({id:result.voucherId,label:`Phiếu thu đã đối chiếu: ${result.voucherId}`});
      return result;
    }),
    onSuccess: async (result) => {
      await Promise.all(
        [
          ["income-expenses"], ["voucher-with-batch"], ["income-expense-revisions"], ["ie-history"],
          ["invoices"], ["invoice"], ["payments"], ["invoice-payments"], ["accounts-with-balance"],
          ["cash-book"], ["cash-book-summary"],
        ].map((queryKey) => client.invalidateQueries({ queryKey })),
      );
      if(result.changed) toast.success("Đã đổi hình thức thu"+(result.to?.accountName?` vào sổ ${result.to.accountName}`:"")+".");
      else toast.info("Hình thức thu và sổ nhận không thay đổi.");
    },
    onError: (error: { message?: string }) => {
      toast.error(voucherFailureMessage(error,"đổi hình thức thu"));
    },
  });
}
