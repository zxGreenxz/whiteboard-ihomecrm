import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { createCompanyWalletService, CompanyWalletError, type CreateCompanyWalletVoucherInput } from '@/lib/companyWallet/service';
import { createCompanyWalletTransport } from '@/lib/companyWallet/transport';
import type { CompanyWalletMutation } from '@/lib/companyWallet/contract';

const COMPANY_WALLET_KEY = ['company-wallets'] as const;
export const companyWalletKey = (ownerId: string | null, organizationId: string | null) => [...COMPANY_WALLET_KEY, ownerId, organizationId] as const;
function useCompanyWalletService(organizationId: string | null) {
 const auth = useAuth(), ownerId = auth.data?.id ?? null;
 const scope = useRef({ ownerId, organizationId }); scope.current = { ownerId, organizationId };
 const service = () => {
  if (!ownerId || !organizationId) throw new CompanyWalletError('permission', 'Vui lòng đăng nhập và chọn công ty.');
  return createCompanyWalletService(createCompanyWalletTransport(ownerId, organizationId, () => scope.current), ownerId, organizationId);
 };
 return { auth, ownerId, service };
}
export function useCompanyWallets(organizationId: string | null, enabled = true) {
 const { auth, ownerId, service } = useCompanyWalletService(organizationId), qc = useQueryClient();
 useEffect(() => {
  const predicate = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] === 'company-wallets' && (q.queryKey[1] !== ownerId || q.queryKey[2] !== organizationId);
  void qc.cancelQueries({ predicate }); qc.removeQueries({ predicate });
 }, [qc, ownerId, organizationId]);
 const query = useQuery({ queryKey: companyWalletKey(ownerId, organizationId), enabled: enabled && !!ownerId && !!organizationId, queryFn: () => service().snapshot(), retry: false });
 return { ...query, ownerId, isLoading: enabled && (auth.isLoading || !!ownerId && !!organizationId && query.isLoading), error: auth.error ?? query.error,
  data: query.data?.owner_id === ownerId && query.data?.organization_id === organizationId ? query.data : undefined };
}
export function useCompanyWalletMutation(organizationId: string | null) {
 const { ownerId, service } = useCompanyWalletService(organizationId), qc = useQueryClient();
 return useMutation({ retry: false, mutationFn: (request: CompanyWalletMutation) => service().mutate(request),
  onSettled: () => qc.invalidateQueries({ queryKey: companyWalletKey(ownerId, organizationId) }),
 });
}
export function useCreateCompanyWalletVoucher(organizationId: string | null) {
 const { ownerId, service } = useCompanyWalletService(organizationId), qc = useQueryClient();
 return useMutation({ retry: false, mutationFn: (request: CreateCompanyWalletVoucherInput) => service().createVoucher(request),
  onSettled: async () => {
   await Promise.all([qc.invalidateQueries({ queryKey: companyWalletKey(ownerId, organizationId) }), qc.invalidateQueries({ queryKey: ['income-expenses'] }), qc.invalidateQueries({ queryKey: ['accounts-with-balance'] })]);
  },
 });
}
