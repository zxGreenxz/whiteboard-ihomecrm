import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

import { invoiceAmountPartsSchema } from "@/lib/invoiceAmountParts";

const amount = z.number().finite();
const entry = z.object({
  bucket: z.enum(["booked_income","pending_income","unpaid","unbilled","booked_cost","pending_cost","fixed_cost","utility_cost"]),
  label: z.string().min(1), room: z.string().nullish(), code: z.string().nullish(), day: z.string().nullish(),
  description: z.string().nullish(), amount, parts: invoiceAmountPartsSchema.optional(),
});
export type ForecastEntry = z.infer<typeof entry>;
const house = z.object({
  id: z.string().uuid(), name: z.string().min(1), locked: z.boolean(),
  total_rooms: z.number().int().nonnegative(), occupied_rooms: z.number().int().nonnegative(),
  revenue: amount.nullable(), expense: amount.nullable(), profit: amount, salary: amount,
  adjustment: amount, booked_income: amount.nullable(), booked_cost: amount.nullable(), detail_lines: z.array(entry).nullable(),
  pending_income: amount, pending_cost: amount, unpaid: amount, unbilled: amount,
  fixed_cost: amount, utility_cost: amount, unknown_fees: z.array(z.string()), share: amount, pool: amount,
});
const report = z.object({
  organization_id: z.string().uuid(), shareholder_id: z.string().uuid(), name: z.string().min(1),
  own: z.boolean(), month: z.string(), as_of: z.string().datetime({ offset: true }),
  choices: z.array(z.object({ id: z.string().uuid(), name: z.string() })), houses: z.array(house),
});
export type ForecastHouse = z.infer<typeof house>;

export function useShareholderForecast(org: string | null, period: string, subject: string | null) {
  const actor = useAuth().data?.id;
  return useQuery({
    queryKey: ["shareholder-forecast", org, actor, period, subject],
    enabled: Boolean(org && actor),
    // Một số sự kiện thay đổi tỷ lệ/chốt kỳ không được phát tới cổ đông qua RLS.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      if (!org || !actor) throw new Error("Chưa chọn công ty hoặc tài khoản");
      const { data, error } = await supabase.rpc("shareholder_month_forecast_v1", {
        p_organization_id: org, p_month: period + "-01", ...(subject ? { p_shareholder_id: subject } : {}),
      }).abortSignal(signal);
      if (error) throw error;
      const value = report.parse(data);
      if (value.organization_id !== org || value.month !== period + "-01" || (subject && value.shareholder_id !== subject)) {
        throw new Error("Báo cáo trả về khác công ty, cổ đông hoặc kỳ đang chọn");
      }
      return value;
    },
  });
}
