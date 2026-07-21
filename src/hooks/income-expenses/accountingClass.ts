import { supabase } from "@/integrations/supabase/client";

export type IncomeExpenseItemAccountingClass = "PNL" | "DEPOSIT";

export const loadIncomeExpenseAccountingClassResolver = async (
  typeIds: string[],
): Promise<(typeId: string) => IncomeExpenseItemAccountingClass> => {
  const uniqueTypeIds = [...new Set(typeIds)];
  const { data, error } = await supabase
    .from("income_expense_types")
    .select("id, is_deposit")
    .in("id", uniqueTypeIds);

  if (error) throw error;

  const classes = new Map<string, IncomeExpenseItemAccountingClass>(
    (data ?? []).map((type) => [
      type.id,
      type.is_deposit ? "DEPOSIT" : "PNL",
    ]),
  );

  return (typeId) => {
    const accountingClass = classes.get(typeId);
    if (!accountingClass) {
      throw new Error(`Không tìm thấy hạng mục thu/chi ${typeId}`);
    }
    return accountingClass;
  };
};
