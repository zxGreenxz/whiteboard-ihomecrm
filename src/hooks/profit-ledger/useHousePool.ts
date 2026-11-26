import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { persistentFinancialWorkflow } from "@/lib/persistentFinancialWorkflow";
import {
  financialPending,
  isAttemptRunning,
  pendingHasSettled,
} from "@/lib/financialPending";
import { invalidateProfitLedgerQueries } from "./useProfitLedgerMutations";

const money = z.number().int().safe();
const share = z.object({
  shareholder_id: z.string().uuid(),
  name: z.string(),
  contributed: money,
  reserved: money,
  paid: money,
  available: money,
  amount: money,
});
const state = z.object({
  min_date: z.string().nullable(),
  opening: z
    .object({
      id: z.string().uuid(),
      date: z.string(),
      reference: z.string(),
      amount: money,
      linked: z.boolean(),
    })
    .nullable(),
  baselines: z.array(
    z.object({ building_id: z.string().uuid(), id: z.string().uuid() }),
  ),
  quote: z.object({
    lines: z.array(share),
    eligible: z.boolean(),
    total: money,
    hash: z.string(),
  }),
  rules: z.array(
    z.object({
      building_id: z.string().uuid(),
      name: z.string(),
      share_percent: z.number(),
      retained_percent: z.number(),
      from_month: z.string(),
    }),
  ),
  history: z.array(
    z.object({
      id: money,
      building: z.string(),
      month: z.string(),
      reason: z.string(),
      each: money,
      retained: z.number(),
    }),
  ),
  expenses: z
    .array(
      z.object({
        id: z.string().uuid(),
        code: z.string().nullable(),
        date: z.string(),
        amount: money,
        live: z.boolean(),
      }),
    )
    .optional(),
  batches: z.array(
    z.object({
      id: z.string().uuid(),
      rate: money,
      state: z.enum(["PAID", "RESERVED", "RELEASED"]),
      date: z.string(),
      total: money,
      voucher_id: z.string().uuid(),
      code: z.string().nullable(),
      lines: z.array(z.object({ name: z.string(), amount: money })),
    }),
  ),
});
const receipt = z.object({
  id: z.string().uuid(),
  voucher_id: z.string().uuid(),
  total: money,
});
export type HousePoolWrite =
  | {
      kind: "activate";
      partner: string;
      opening: string | null;
      rules: {
        building_id: string;
        share_percent: number;
        retained_percent: number;
        baseline_revision: string;
      }[];
    }
  | {
      kind: "return";
      rate: number;
      account: string;
      date: string;
      hash: string;
      total: number;
    };

type HousePoolRpc = (
  name:
    | "house_pool_state_v1"
    | "house_pool_activate_v1"
    | "house_pool_return_v1"
    | "house_pool_receipt_v1"
    | "house_pool_link_expenses_v1",
  args: Record<string, unknown>,
) => PromiseLike<{
  data: unknown;
  error: { code: string; message: string } | null;
}>;
const rpc: HousePoolRpc = (name, args) =>
  (supabase.rpc as unknown as HousePoolRpc)(name, args);

const storedReceipt = z.object({
  voucher: z.string().uuid().nullable(),
  imported: z.number().int().nonnegative().nullable(),
});
async function readReceipt(
  org: string,
  kind: HousePoolWrite["kind"],
  key: string,
) {
  const { data, error } = await rpc("house_pool_receipt_v1", {
    p_organization_id: org,
    p_kind: kind,
    p_request_key: key,
  });
  if (error) throw error;
  return storedReceipt.nullable().parse(data);
}

const expenseItem = z.object({
  id: z.string().uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  code: z.string().min(1),
  amount: money.positive(),
});
export type PoolExpenseItem = z.infer<typeof expenseItem>;

export async function readPoolExpenseCsv(
  file: File,
): Promise<PoolExpenseItem[]> {
  if (file.size > 2_000_000) throw new Error("Tệp vượt quá 2 MB.");
  const { read, utils } = await import("xlsx");
  const workbook = read((await file.text()).replace(/^\uFEFF/, ""), {
    type: "string",
    raw: true,
  });
  const rows = utils.sheet_to_json<Record<string, string>>(
    workbook.Sheets[workbook.SheetNames[0]],
  );
  const items = rows.map((row) =>
    expenseItem.parse({
      id: row["ID phiếu"],
      day: row["Ngày"],
      code: row["Mã phiếu"],
      amount: Number(row["Số tiền (đ)"]),
    }),
  );
  if (
    !items.length ||
    items.length > 500 ||
    new Set(items.map((x) => x.id)).size !== items.length
  )
    throw new Error("Tệp phải có từ 1 đến 500 ID phiếu khác nhau.");
  return items;
}
export function usePoolExpenseLink(org: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (op: {
      items: PoolExpenseItem[];
      before: number;
      apply: boolean;
    }) => {
      const { data, error } = await rpc("house_pool_link_expenses_v1", {
        p_org: org,
        p_items: op.items,
        p_expected_before: op.before,
        p_apply: op.apply,
      });
      if (error) throw error;
      return z
        .object({
          linked: z.boolean(),
          count: money,
          amount: money,
          after: money,
        })
        .parse(data);
    },
    onSuccess: (result) => {
      if (result.linked) {
        void client.invalidateQueries({ queryKey: ["house-pool", org] });
        invalidateProfitLedgerQueries(client);
      }
    },
  });
}

export function useHousePoolRecovery(org: string) {
  const actor = useAuth().data?.id;
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!actor) throw new Error("Cần đăng nhập để đối chiếu đợt trước.");
      for (const kind of ["activate", "return"] as const) {
        const scope = {
          namespace: "shared-fund",
          userId: actor,
          organizationId: org,
          businessKey: "house-pool-" + kind,
        };
        const prior = financialPending.read(scope);
        if (!prior) continue;
        if (isAttemptRunning(prior.attemptId))
          throw new Error("Yêu cầu đang được xử lý.");
        const result = await readReceipt(
          org,
          kind,
          prior.requestKey ?? prior.attemptId,
        );
        if (!result && !pendingHasSettled(prior))
          throw new Error(
            "Chưa có biên nhận. Đối chiếu lại sau khi yêu cầu kết thúc.",
          );
        if (!financialPending.clearConfirmed(scope, prior.attemptId))
          throw new Error("Trạng thái yêu cầu đã đổi.");
        await client.invalidateQueries({ queryKey: ["house-pool", org] });
        return result;
      }
      return null;
    },
  });
}

export function useHousePool(org: string, rate: number) {
  const actor = useAuth().data?.id;
  return useQuery({
    queryKey: ["house-pool", org, actor, rate],
    enabled: !!actor && rate >= 1 && rate <= 10000,
    staleTime: 0,
    meta: { label: "quỹ góp theo nhà", errorDisplay: "inline" },
    queryFn: async () => {
      const { data, error } = await rpc("house_pool_state_v1", {
        p_organization_id: org,
        p_rate: rate,
      });
      if (error) throw error;
      return state.parse(data);
    },
  });
}

export function useHousePoolWrite(org: string) {
  const client = useQueryClient();
  const workflow = useRef(persistentFinancialWorkflow("shared-fund"));
  return useMutation({
    mutationFn: async (op: HousePoolWrite) => {
      const send = async (requestKey: string) => {
        if (op.kind === "activate") {
          const { data, error } = await rpc("house_pool_activate_v1", {
            p_organization_id: org,
            p_partner: op.partner,
            p_rules: op.rules,
            p_opening_id: op.opening,
            p_request_key: requestKey,
            p_history_from: "2026-05-01",
            p_automatic_from: "2026-11-01",
          });
          if (error) throw error;
          const result = z
            .object({
              imported: z.number().int().nonnegative(),
              shareholders: z.array(z.string().uuid()).length(2),
            })
            .parse(data);
          return { imported: result.imported, voucher: null as string | null };
        }
        const { data, error } = await rpc("house_pool_return_v1", {
          p_organization_id: org,
          p_rate: op.rate,
          p_account: op.account,
          p_voucher_date: op.date,
          p_expected_hash: op.hash,
          p_request_key: requestKey,
        });
        if (error) throw error;
        const result = receipt.parse(data);
        if (result.total !== op.total)
          throw new Error("Biên nhận không khớp tổng tiền của đợt hoàn.");
        return { imported: null, voucher: result.voucher_id };
      };
      return workflow.current.run<z.infer<typeof storedReceipt>>(
        "house-pool-" + op.kind,
        "ghi quỹ góp theo nhà",
        (progress) => send(progress.requestKey),
        async (prior, progress) => {
          const result = await readReceipt(org, op.kind, progress.requestKey);
          if (result) return { result };
          return pendingHasSettled(prior) ? { outcome: "not-written" } : null;
        },
        org,
      );
    },
    onSettled: async () => {
      invalidateProfitLedgerQueries(client);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["house-pool", org] }),
        client.invalidateQueries({ queryKey: ["profit-close-preview"] }),
        client.invalidateQueries({ queryKey: ["profit-close-state"] }),
      ]);
    },
  });
}
