import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { can, type PermissionsMap } from '@/hooks/useMyPermissions';

export interface PersonalFinancePermissions {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}

/** Personal records belong to auth.uid(), not the selected company. The legacy
 * RPC can read account permissions without choosing a company, but its union
 * and owner sentinel must NEVER escape this personal-only projection. */
export async function fetchPersonalFinancePermissions(ownerId: string): Promise<PersonalFinancePermissions> {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session || session.user.id !== ownerId) throw new Error('Phiên đăng nhập đã thay đổi.');
  const { data, error } = await supabase.rpc('get_my_permissions')
    .setHeader('Authorization', `Bearer ${session.access_token}`);
  if (error) throw error;
  const map: PermissionsMap = data && typeof data === 'object' && !Array.isArray(data) ? data as PermissionsMap : {};
  return {
    view: can(map, 'personal_finance', 'view'),
    create: can(map, 'personal_finance', 'create'),
    edit: can(map, 'personal_finance', 'edit'),
    delete: can(map, 'personal_finance', 'delete'),
  };
}

export function usePersonalFinancePermissions() {
  const auth = useAuth();
  const ownerId = auth.data?.id ?? null;
  const query = useQuery({
    queryKey: ['personal-finance-permissions', ownerId],
    enabled: !!ownerId,
    queryFn: () => fetchPersonalFinancePermissions(ownerId!),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const error = auth.error ?? query.error;
  return { ...query, data: error ? undefined : query.data, error, isError: !!error, isPending: auth.isLoading || query.isPending };
}
