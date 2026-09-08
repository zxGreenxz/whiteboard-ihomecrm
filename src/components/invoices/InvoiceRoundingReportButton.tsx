import { lazy, Suspense, useState } from 'react';
import { ReceiptText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';

const InvoiceRoundingReportDialog = lazy(() => import('./InvoiceRoundingReportDialog'));

export default function InvoiceRoundingReportButton({ billingMonth, buildingId, className }: {
  billingMonth?: string; buildingId?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: permissions } = useMyPermissions();
  if (!canUse(permissions, 'thu_tien', 'report')) return null;
  return <>
    <Button type="button" variant="outline" size="sm" className={className} onClick={() => setOpen(true)}><ReceiptText className="mr-2 h-4 w-4" />Khoản bỏ qua</Button>
    {open && <Suspense fallback={<p role="status" className="p-2 text-sm">Đang mở báo cáo…</p>}><InvoiceRoundingReportDialog open onOpenChange={setOpen} billingMonth={billingMonth} buildingId={buildingId} /></Suspense>}
  </>;
}
