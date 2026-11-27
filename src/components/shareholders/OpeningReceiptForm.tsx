import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRecordOpeningReceipts, type SharedFundState } from '@/hooks/profit-ledger/useSharedFund';
import { formatVND } from '@/lib/utils';

const newRow = () => ({ key: crypto.randomUUID(), month: '', amount: '', profit: '', evidence: '', sources: '' });

export default function OpeningReceiptForm({ org, opening }: { org: string; opening: SharedFundState['openings'][number] }) {
  const [rows, setRows] = useState(() => [newRow()]);
  const [sourceError, setSourceError] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const write = useRecordOpeningReceipts(org, opening.shareholder_id, opening.opening_id);
  const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
  const edit = (key: string, field: 'month' | 'amount' | 'profit' | 'evidence' | 'sources', value: string) =>
    setRows(list => list.map(r => r.key === key ? { ...r, [field]: value } : r));
  const error = write.error && typeof write.error === 'object' && 'message' in write.error ? String(write.error.message) : '';
  if (opening.historical_count || write.isSuccess) return <p>Đã ghi {opening.historical_count || rows.length} phiếu tạm ứng lịch sử.</p>;
  return <details className="mt-3 rounded-md border p-3">
    <summary className="cursor-pointer font-medium">Bổ sung phiếu tạm ứng theo kỳ</summary>
    <form className="mt-2 grid gap-3" onSubmit={event => {
      event.preventDefault();
      const records = rows.map(r => {
        const refs = r.sources.split(';').map(s => s.trim()).filter(Boolean).map(item => {
          const [code, date, value, ...rest] = item.split('|').map(s => s.trim());
          if (rest.length || !code || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !value || !/^\d+$/.test(value)) return null;
          const amount = Number(value);
          return Number.isSafeInteger(amount) && amount > 0 ? { code, date, amount } : null;
        });
        return {row:r, refs};
      });
      if (records.some(record => record.refs.includes(null))) { setSourceError(true); return; }
      setSourceError(false);
      if (!reviewing) { setReviewing(true); return; }
      write.mutate(records.map(({row:r,refs}) => ({ period_month: r.month + '-01', amount: Number(r.amount),
        external_profit: r.profit === '' ? null : Number(r.profit), evidence: r.evidence.trim(), source_refs: refs.filter(ref => ref !== null) })));
    }}>
      <p className="text-sm text-muted-foreground">Nhập các kỳ còn thiếu phiếu trong mốc này. Chỉ điền lợi nhuận ngoài sổ cho kỳ chưa có phân bổ CRM.</p>
      <fieldset disabled={reviewing || write.isPending} className="grid gap-3">
        {rows.map((r,i) => <div key={r.key} className="grid gap-2 rounded-md bg-muted/30 p-3 sm:grid-cols-3">
          <label>Kỳ lợi nhuận<Input type="month" required max={opening.through_month.slice(0,7)} value={r.month} onChange={e=>edit(r.key,'month',e.target.value)}/></label>
          <label>Tạm ứng (đ)<Input type="number" required min="1" max="9999999999999" step="1" value={r.amount} onChange={e=>edit(r.key,'amount',e.target.value)}/></label>
          <label>Lợi nhuận ngoài sổ (đ)<Input type="number" step="1" value={r.profit} onChange={e=>edit(r.key,'profit',e.target.value)}/></label>
          <label>Phiếu tiền gốc (mã | ngày | số tiền)<Input value={r.sources} onChange={e=>edit(r.key,'sources',e.target.value)} placeholder="PC… | YYYY-MM-DD | 1000000" /></label>
          <label className="sm:col-span-2">Căn cứ đối chiếu<Input required minLength={8} maxLength={1000} value={r.evidence} onChange={e=>edit(r.key,'evidence',e.target.value)}/></label>
          {rows.length > 1 && <Button type="button" variant="ghost" className="self-end" aria-label={'Bỏ dòng ' + (i+1)} onClick={()=>setRows(list=>list.filter(item=>item.key!==r.key))}>Bỏ dòng</Button>}
        </div>)}
        <Button type="button" variant="outline" onClick={()=>setRows(list=>[...list,newRow()])}>Thêm kỳ</Button>
      </fieldset>
      {reviewing && <p role="status">{rows.length} phiếu · {formatVND(total)}. Các phiếu giải trình số đã tính trong mốc.</p>}
      {sourceError && <p role="alert" className="text-destructive">Nhập mã | ngày YYYY-MM-DD | số tiền nguyên đồng. Nếu có nhiều phiếu, ngăn cách bằng dấu chấm phẩy.</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={write.isPending}>{reviewing ? 'Ghi phiếu lịch sử' : 'Kiểm tra trước khi ghi'}</Button>
        {reviewing && <Button variant="outline" type="button" disabled={write.isPending} onClick={()=>setReviewing(false)}>Sửa thông tin</Button>}
      </div>
    </form>
  </details>;
}
