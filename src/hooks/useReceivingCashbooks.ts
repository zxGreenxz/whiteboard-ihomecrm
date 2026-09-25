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
import { newRevisionIdempotencyKey } from "@/lib/incomeExpenseRevision";

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

/** Câu báo khi hình thức chưa có sổ nào (máy chủ cũng chặn với câu tương tự). */
export function missingReceivingBookMessage(method: ReceivingMethod, buildingName?: string | null): string {
  if (method === "TM") return "Người thu chưa có sổ tiền mặt riêng — nhờ chủ công ty cài ở Sổ nhận tiền.";
  const ht = method === "TK" ? "Chuyển khoản" : "Thanh toán";
  return `Toà ${buildingName || "này"} chưa cài sổ nhận tiền cho hình thức ${ht}.`;
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

export function useSetPersonalCashBook() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { membershipId: string; accountId: string | null }) => {
      const { data, error } = await supabase.rpc("set_personal_cash_book_v1", {
        p_membership_id: input.membershipId,
        p_account_id: rpcNullable(input.accountId),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await invalidateReceiving(client);
      toast.success("Đã lưu sổ tiền mặt riêng.");
    },
    onError: (error: { message?: string }) => {
      toast.error(error?.message || "Không lưu được sổ tiền mặt riêng.");
    },
  });
}

export function useSetBuildingReceivingCashbooks() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      buildingId: string;
      method: "TK" | "TT";
      defaultAccountId: string | null;
      extraAccountIds: string[];
    }) => {
      const { data, error } = await supabase.rpc("set_building_receiving_cashbooks_v1", {
        p_building_id: input.buildingId,
        p_method: input.method,
        p_default_account_id: rpcNullable(input.defaultAccountId),
        p_extra_account_ids: input.extraAccountIds,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await invalidateReceiving(client);
      toast.success("Đã lưu sổ nhận tiền của toà.");
    },
    onError: (error: { message?: string }) => {
      toast.error(error?.message || "Không lưu được sổ nhận tiền của toà.");
    },
  });
}

// ── Đổi hình thức thu của một dòng thu ──────────────────────────────────────

export const changeTenderMethodResultSchema = z.object({
  tenderId: z.string(),
  voucherId: z.string(),
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
  return useMutation({
    mutationFn: async (input: ChangeTenderMethodInput) => {
      const { data, error } = await supabase.rpc("change_collection_tender_method_v1", {
        p_tender_id: input.tenderId,
        p_new_method: input.method,
        p_new_account_id: input.accountId ?? undefined,
        p_reason: input.reason.trim(),
        p_idempotency_key: input.idempotencyKey ?? newRevisionIdempotencyKey("tender-method"),
      });
      if (error) throw error;
      return changeTenderMethodResultSchema.parse(data);
    },
    onSuccess: async () => {
      await Promise.all(
        [
          ["income-expenses"], ["voucher-with-batch"], ["income-expense-revisions"], ["ie-history"],
          ["invoices"], ["invoice"], ["payments"], ["invoice-payments"], ["accounts-with-balance"],
          ["cash-book"], ["cash-book-summary"],
        ].map((queryKey) => client.invalidateQueries({ queryKey })),
      );
      toast.success("Đã đổi hình thức thu.");
    },
    onError: (error: { message?: string }) => {
      toast.error((error?.message || "Không đổi được hình thức thu.").replace(/^\[[A-Z_]+\]\s*/, ""));
    },
  });
}
