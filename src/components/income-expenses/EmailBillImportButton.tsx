import { lazy, Suspense, useState } from 'react';
import { Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useAuth } from '@/hooks/useAuth';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';

const EmailBillImportDialog = lazy(() => import('./EmailBillImportDialog'));
export function EmailBillImportButton({ compact = false }: { compact?: boolean }) {
  const { selectedOrganizationId } = useOrganization();
  const { data: user } = useAuth();
  const [open, setOpen] = useState(false);
  const { data: permissions } = useMyPermissions();
  if (!canUse(permissions, 'income_expenses', 'create')) return null;
  return <>
    <Button variant="outline" size={compact ? 'sm' : 'default'} disabled={!selectedOrganizationId || !user} onClick={() => setOpen(true)} aria-label="Lấy hóa đơn Gmail">
      <Mail className="mr-2 h-4 w-4" />{compact ? 'Gmail' : 'Lấy hóa đơn Gmail'}
    </Button>
    {open && selectedOrganizationId && user && <Suspense fallback={<p role="status" className="text-sm">Đang mở kết nối Gmail…</p>}>
      <EmailBillImportDialog key={`${selectedOrganizationId}:${user.id}`} organizationId={selectedOrganizationId} userId={user.id} onClose={() => setOpen(false)} />
    </Suspense>}
  </>;
}
