import { lazy, Suspense, useState } from 'react';
import { Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const SharedFundPanel = lazy(() => import('./SharedFundPanel'));

export function SharedFundEntry({
  organizationId,
  onSettle,
}: {
  organizationId: string;
  onSettle: (shareholderId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Wallet className="mr-2 size-4" />
        Quỹ chung
      </Button>
      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent className="max-h-[90dvh] w-[96vw] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Quỹ chung cổ đông</DialogTitle>
              <DialogDescription>
                Nguồn quỹ đã đối chiếu, phần chia cho từng người và lịch sử cấn ứng.
              </DialogDescription>
            </DialogHeader>
            <Suspense fallback={<p role="status">Đang tải sổ quỹ…</p>}>
              <SharedFundPanel
                key={organizationId}
                org={organizationId}
                onSettle={(id) => {
                  setOpen(false);
                  onSettle(id);
                }}
              />
            </Suspense>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
