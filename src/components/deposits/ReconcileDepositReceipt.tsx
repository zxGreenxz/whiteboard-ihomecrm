import { useState } from 'react';
import type { ReservationDepositRow } from '@/hooks/useDeposits';
import { useReconcileDepositReceipt } from '@/hooks/useRoomReservations';
import { reservationErrorMessage, type RoomReservation } from '@/lib/reservationIdentityRpc';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function ReconcileDepositReceipt({hold, rows, paid}: {
  hold: RoomReservation; rows: ReservationDepositRow[]; paid: number;
}) {
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState('');
  const mutation = useReconcileDepositReceipt();
  const row = rows.find(item => item.id === selected);
  async function reconcile() {
    if (!row?.received_amount) return;
    try {
      await mutation.mutateAsync({holdId:hold.id, revision:hold.revision, paid,
        voucherId:row.id, amount:row.received_amount});
      setSelected('');
      setMessage('Đã nối phiếu đã thu vào đúng lượt.');
    } catch (error) {
      setMessage(reservationErrorMessage(error));
    }
  }
  return <fieldset className="space-y-2" disabled={mutation.isPending}>
    <label className="grid gap-1">Đối chiếu phiếu đã thu cho lượt này
      <select className="rounded border p-2" value={selected} onChange={event => {setSelected(event.target.value);setMessage('');}}>
        <option value="">Chọn phiếu đã xác minh cùng lượt</option>
        {rows.map(item => <option key={item.id} value={item.id}>{item.code} · {item.voucher_date} · {item.payer_name} · {formatCurrency(item.received_amount!)}</option>)}
      </select>
    </label>
    {row && <div className="space-y-2">
      <p>Tiền cọc {hold.status==='CONVERTED'?'hợp đồng':'lượt giữ chỗ'} sau khi nối {row.code}: {formatCurrency(paid)} → {formatCurrency(paid+row.received_amount!)}. Sổ quỹ giữ nguyên.</p>
      <Button type="button" variant="outline" size="sm" onClick={()=>void reconcile()}>Xác nhận nối phiếu {row.code}</Button>
    </div>}
    {message && <p role="status">{message}</p>}
  </fieldset>;
}
