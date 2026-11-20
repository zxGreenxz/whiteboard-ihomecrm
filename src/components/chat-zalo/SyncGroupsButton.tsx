import { RefreshCw } from 'lucide-react';
import { useSyncZaloGroups, useZaloOrgId } from '@/hooks/useZaloChat';
import type { ZaloAccount } from './types';

export default function SyncGroupsButton({ account }: { account: ZaloAccount }) {
  const org = useZaloOrgId();
  const sync = useSyncZaloGroups(account);
  const online = account.kind === 'personal' && account.status === 'connected';
  return <button type="button" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
    title={online ? `Lấy danh sách nhóm từ ${account.name}` : 'Kết nối nick Zalo để đồng bộ nhóm'}
    disabled={!org || !online || sync.isPending} onClick={() => sync.mutate()}>
    <RefreshCw size={13} className={sync.isPending ? 'animate-spin' : undefined} />
    {sync.isPending ? 'Đang đồng bộ…' : 'Đồng bộ nhóm'}
  </button>;
}
