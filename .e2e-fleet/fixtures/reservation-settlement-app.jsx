// Dev-server test entry only; production app routes never import this file.
// Uses real components, hooks and transport. The runner forwards REST to an
// isolated PostgreSQL/PostgREST fixture and never permits shared-server writes.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ReservationSettlementDialog } from '../../src/components/deposits/ReservationSettlementDialog';
import { ReservationRefundDialog } from '../../src/components/deposits/ReservationRefundDialog';
import { ReservationSettlementStatus } from '../../src/components/deposits/ReservationSettlementStatus';
import { useReservationSettlementForVoucher } from '../../src/hooks/useReservationSettlement';
import '../../src/index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Fixture() {
  const source = new URLSearchParams(location.search).get('voucher');
  const [open, setOpen] = useState(true);
  const [refundOpen, setRefundOpen] = useState(false);
  const settlement = useReservationSettlementForVoucher(source);
  return <><Toaster /><button onClick={() => setOpen(true)}>Mở xử lý</button>
    <ReservationSettlementDialog voucherId={source} open={open} onOpenChange={setOpen} />
    {settlement.error && <p role="alert">{settlement.error.message}</p>}
    {settlement.data && <><ReservationSettlementStatus settlement={settlement.data} />
      {settlement.data.refundRemaining > 0 && <button onClick={() => setRefundOpen(true)}>Hoàn tiền</button>}
      <ReservationRefundDialog settlementId={settlement.data.id} amount={settlement.data.refundRemaining} open={refundOpen} onOpenChange={setRefundOpen} />
    </>}
  </>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={queryClient}><Fixture /></QueryClientProvider>);
