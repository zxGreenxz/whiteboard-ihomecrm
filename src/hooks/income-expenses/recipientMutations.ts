import { useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { updateIncomeExpenseRecipient, type RecipientUpdateInput, type RecipientWriter } from '@/lib/incomeExpenseRecipient';

/** The shared controller owns selection, preflight, refresh and uncertain-result handling. */
export function useUpdateIncomeExpenseRecipient() {
  return useMutation({ retry: false, mutationFn: (input: RecipientUpdateInput) =>
    updateIncomeExpenseRecipient(input, (name, args) => (supabase.rpc as unknown as RecipientWriter)(name, args)) });
}
