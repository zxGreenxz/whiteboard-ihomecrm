import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';
import { executeBankEmailReview, type BankEmailReviewInput } from '@/lib/bankEmailReview';
import {
  BankEmailActualOutcomeError,
  bankEmailQueryKey,
  disconnectBankEmail,
  listBankEmail,
  listOwnedBankEmailConnections,
  setBankEmailEnabled,
  setupBankEmail,
  startBankEmailOAuth,
} from '@/lib/bankEmail';

const cashbookSchema = z.array(z.object({ id: z.string().uuid(), name: z.string().min(1) }));
const invoiceCandidateSchema = z.array(z.object({ id: z.string().uuid(), invoice_number: z.string().min(1), status: z.string() }));
const postedInvalidationKeys = ['bank-email', 'invoices', 'invoice', 'payments', 'income-expenses', 'income-expense', 'accounts-with-balance', 'cash-book-summary', 'invoice-statistics', 'unpaid-invoices'] as const;
type BankEmailReviewMutationInput = BankEmailReviewInput extends infer T
  ? T extends BankEmailReviewInput ? Omit<T, 'actorId'> : never
  : never;

export function useBankEmailInbox() {
  const { data: user } = useAuth();
  const { selectedOrganizationId } = useOrganization();
  return useInfiniteQuery({
    queryKey: bankEmailQueryKey(user?.id ?? null, selectedOrganizationId),
    enabled: !!user && !!selectedOrganizationId,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => listBankEmail(selectedOrganizationId!, pageParam),
    getNextPageParam: lastPage => lastPage.hasMore ? lastPage.transactions.at(-1)?.createdAt ?? undefined : undefined,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    meta: { feedback: 'inline' },
  });
}

export function useBankEmailCashbooks() {
  const { selectedOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ['bank-email-cashbooks', selectedOrganizationId],
    enabled: !!selectedOrganizationId,
    meta: { feedback: 'inline' },
    queryFn: async () => {
      const { data, error } = await supabase.from('accounts')
        .select('id,name')
        .eq('organization_id', selectedOrganizationId!)
        .eq('is_virtual', false)
        .is('deleted_at', null)
        .order('name');
      if (error) throw error;
      return cashbookSchema.parse(data);
    },
  });
}

export function useBankInvoiceCandidates(search: string) {
  const { selectedOrganizationId } = useOrganization();
  const normalizedSearch = search.trim();
  return useQuery({
    queryKey: ['bank-email-invoice-candidates', selectedOrganizationId, normalizedSearch],
    enabled: !!selectedOrganizationId && normalizedSearch.length >= 2,
    meta: { feedback: 'inline' },
    queryFn: async () => {
      const literal = normalizedSearch.replace(/[%,()]/g, ' ').trim();
      if (literal.length < 2) return [];
      const { data, error } = await supabase.from('invoices')
        .select('id,invoice_number,status')
        .eq('organization_id', selectedOrganizationId!)
        .is('deleted_at', null)
        .not('invoice_number', 'is', null)
        .neq('status', 'CANCELLED')
        .ilike('invoice_number', `%${literal}%`)
        .limit(10);
      if (error) throw error;
      return invoiceCandidateSchema.parse(data);
    },
  });
}

function useInvalidateBankEmail() {
  const queryClient = useQueryClient();
  return async () => queryClient.invalidateQueries({ queryKey: ['bank-email'] });
}

export function useSetupBankEmail() {
  const { selectedOrganizationId } = useOrganization();
  const invalidate = useInvalidateBankEmail();
  return useMutation({
    mutationFn: (input: { bankAccount: string; accountId: string }) => {
      if (!selectedOrganizationId) throw new Error('Chưa chọn tổ chức.');
      return setupBankEmail(selectedOrganizationId, input.bankAccount, input.accountId);
    },
    onSuccess: invalidate,
    meta: { handlesFeedback: true },
  });
}

export function useSetBankEmailEnabled() {
  const invalidate = useInvalidateBankEmail();
  return useMutation({
    mutationFn: (input: { connectionId: string; enabled: boolean }) => setBankEmailEnabled(input.connectionId, input.enabled),
    onSuccess: invalidate,
    meta: { handlesFeedback: true },
  });
}

export function useDisconnectBankEmail() {
  const invalidate = useInvalidateBankEmail();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: disconnectBankEmail,
    onSuccess: async () => {
      await Promise.all([invalidate(), queryClient.invalidateQueries({ queryKey: ['bank-email-owned-connections'] })]);
    },
    meta: { handlesFeedback: true },
  });
}

export function useOwnedBankEmailConnections() {
  const { data: user } = useAuth();
  return useQuery({
    queryKey: ['bank-email-owned-connections', user?.id ?? null],
    enabled: !!user,
    queryFn: listOwnedBankEmailConnections,
    meta: { feedback: 'inline' },
  });
}

export function useStartBankEmailOAuth() {
  return useMutation({
    mutationFn: startBankEmailOAuth,
    meta: { handlesFeedback: true },
  });
}

export function useReviewBankEmail() {
  const { selectedOrganizationId } = useOrganization();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: BankEmailReviewMutationInput) => {
      if (!selectedOrganizationId || selectedOrganizationId !== input.organizationId) throw new Error('Tổ chức đang chọn đã thay đổi. Tải lại giao dịch trước khi đối soát.');
      const user = await getSessionUser();
      if (!user) throw new Error('Phiên đăng nhập đã hết hạn.');
      return executeBankEmailReview({ ...input, actorId: user.id });
    },
    onSuccess: async receipt => {
      const keys = receipt.status === 'POSTED'
        ? postedInvalidationKeys
        : ['bank-email'];
      await Promise.all(keys.map(key => queryClient.invalidateQueries({ queryKey: [key] })));
    },
    onError: async error => {
      const keys = error instanceof BankEmailActualOutcomeError && error.actual.status === 'POSTED'
        ? postedInvalidationKeys
        : ['bank-email'];
      await Promise.all(keys.map(key => queryClient.invalidateQueries({ queryKey: [key] })));
    },
    meta: { handlesFeedback: true },
  });
}
