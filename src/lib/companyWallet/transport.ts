import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';
import { CompanyWalletError, type CompanyWalletRpcClient } from './service';

/** Typed, JWT-pinned PostgREST boundary until the generated catalog includes the forward migration. */
export function createCompanyWalletTransport(ownerId: string, organizationId: string, currentScope: () => { ownerId: string | null; organizationId: string | null }): CompanyWalletRpcClient {
 return { async rpc(name, args) {
  const checkScope = (outcomeUnknown = false) => {
   const scope = currentScope();
   if (scope.ownerId !== ownerId || scope.organizationId !== organizationId) throw new CompanyWalletError('permission', 'Tài khoản hoặc công ty đang chọn đã thay đổi.', undefined, outcomeUnknown);
  };
  checkScope();
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || session?.user.id !== ownerId) throw new CompanyWalletError('permission', 'Phiên đăng nhập đã thay đổi.', error);
  checkScope();
  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/${name}`, {
   method: 'POST', headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', 'Accept-Profile': 'public', 'Content-Profile': 'public', 'x-organization-id': organizationId },
   body: JSON.stringify(args),
  });
  const data: unknown = await response.json();
  checkScope(name !== 'company_wallet_snapshot');
  if ((await getSessionUser())?.id !== ownerId) throw new CompanyWalletError('permission', 'Phiên đăng nhập đã thay đổi.', undefined, true);
  checkScope(name !== 'company_wallet_snapshot');
  if (!response.ok) {
   if (typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string') {
    return { data: null, error: { message: data.message, status: response.status, ...('code' in data && typeof data.code === 'string' ? { code: data.code } : {}) } };
   }
   throw new CompanyWalletError('internal', 'Máy chủ chưa xác nhận kết quả ví Công ty.', data, name !== 'company_wallet_snapshot');
  }
  return { data, error: null };
 } };
}
