import { supabase } from "@/integrations/supabase/client";
import { readIncomeExpenseDetails } from "./incomeExpenseDetailRead";

/** Typed transport plus the validated voucher snapshot boundary. */
export const loadIncomeExpenseDetails = (organizationId: string, ids: string[]) =>
  readIncomeExpenseDetails(
    (_name, args) => supabase.rpc("read_income_expense_details_v1", args),
    organizationId,
    ids,
  );
