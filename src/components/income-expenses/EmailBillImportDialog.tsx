import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Loader2, Mail } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useEmailBillImport } from '@/hooks/useEmailBillImport';
import { useIncomeExpenseTypes } from '@/hooks/useIncomeExpenseTypes';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { pickableIeTypes, sortIeTypesForPicker } from '@/lib/ieTypeCatalog';
import { emailBillKey } from '@/lib/emailBills/importRpc';
import type { EmailBill } from '@/lib/emailBills/types';
import { fmtFull, todayISO } from '@/lib/collect';
import { isValidBillDate } from '@/lib/emailBills/parser';
import { monthToEndDate } from '@/lib/monthPeriod';
import IncomeExpenseForm from './IncomeExpenseForm';

interface Props { organizationId: string; userId: string; onClose: () => void }

export default function EmailBillImportDialog({ organizationId, userId, onClose }: Props) {
  const reader = useEmailBillImport(organizationId, userId);
  const types = useIncomeExpenseTypes('expense');
  const { data: permissions } = useMyPermissions();
  const choices = sortIeTypesForPicker(pickableIeTypes((types.data ?? []).filter(type => type.organization_id === organizationId && type.type === 'expense'), {
    canPickRestricted: canUse(permissions, 'income_expenses', 'restricted_create'),
  }));
  const today = todayISO();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [selected, setSelected] = useState<EmailBill | null>(null);
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  useEffect(() => { setSelected(null); setFormOpen(false); }, [reader.mailbox]);
  const choice = choices.find(type => type.id === category);
  const choiceId = choice?.id;
  const choiceName = choice?.name;
  const money = /^\d+$/.test(amount) ? Number(amount) : 0;
  const already = selected ? reader.imported.has(emailBillKey(selected.source)) : false;
  const canContinue = !!selected && !selected.blocked && !!selected.source.receipt_id && !already && !!choice && !types.isError &&
    Number.isSafeInteger(money) && money > 0 && money <= 1_000_000_000_000 && isValidBillDate(date) && name.trim().length > 0;
  const prefill = useMemo(() => ({
    name: name.trim(), voucher_date: date,
    items: choiceId && choiceName ? [{ income_expense_type_id: choiceId, type_name: choiceName, quantity: 1, unit_price: money, description: selected?.source.receipt_id ?? '' }] : [],
    period: isValidBillDate(date) ? { start_date: `${date.slice(0, 7)}-01`, end_date: monthToEndDate(date.slice(0, 7)) } : undefined,
  }), [name, date, choiceId, choiceName, money, selected?.source.receipt_id]);
  function select(bill: EmailBill) {
    setSelected(bill); setCategory(''); setAmount(bill.amount === null ? '' : String(bill.amount)); setDate(bill.date ?? ''); setName(bill.description);
  }
  if (formOpen && selected) return <IncomeExpenseForm open defaultType="EXPENSE" defaultPrefill={prefill}
    emailBillSource={selected.source}
    onOpenChange={setFormOpen}
    onSaved={() => { reader.markImported(selected.source); setSelected(null); setFormOpen(false); }} />;

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Lấy hóa đơn Gmail</DialogTitle>
        <DialogDescription>Chọn hóa đơn Grab hoặc Shopee để điền sẵn phiếu chi. Bạn kiểm tra và bấm lưu ở bước cuối.</DialogDescription>
      </DialogHeader>
      {!reader.configured ? <p role="status">Tính năng kết nối Gmail chưa được bật. Nhờ quản trị viên thiết lập kết nối Google cho ứng dụng.</p> : <>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void reader.connect()} disabled={!reader.authReady || reader.busy}>
            <Mail className="mr-2 h-4 w-4" />{reader.connected ? 'Đổi tài khoản Gmail' : 'Kết nối Gmail'}
          </Button>
          {reader.mailbox && <span className="text-sm text-muted-foreground">{reader.mailbox}</span>}
        </div>
        <p className="text-xs text-muted-foreground">Google sẽ xin quyền đọc hộp thư. Ứng dụng chỉ tìm thư Grab/Shopee khi bạn bấm tìm; đóng màn hình sẽ kết thúc phiên đọc này.</p>
        {reader.connected && <div className="flex flex-wrap items-end gap-3">
          <div><Label htmlFor="gmail-from">Từ ngày</Label><Input id="gmail-from" type="date" value={from} onChange={event => setFrom(event.target.value)} disabled={reader.busy} /></div>
          <div><Label htmlFor="gmail-to">Đến ngày</Label><Input id="gmail-to" type="date" value={to} onChange={event => setTo(event.target.value)} disabled={reader.busy} /></div>
          <Button onClick={() => { setSelected(null); void reader.search({ from, to }); }} disabled={reader.busy || !from || !to || from > to}>Tìm hóa đơn</Button>
        </div>}
        {reader.busy && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Đang đọc hóa đơn…</p>}
        {reader.failedCount > 0 && <p role="alert" className="text-sm text-amber-700">Có {reader.failedCount} thư chưa đọc được. Hãy tìm lại để kiểm tra đủ hóa đơn.</p>}
        {reader.searched && reader.bills.length === 0 && <p role="status">Chưa tìm thấy hóa đơn phù hợp trong khoảng ngày này.</p>}
        <div className="space-y-2">
          {reader.bills.map(bill => <div key={bill.source.message_id} className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0"><p className="truncate font-medium">{bill.subject}</p>
              <p className="text-sm text-muted-foreground">{bill.date ?? 'Cần kiểm tra ngày'} · {bill.amount === null ? 'Cần kiểm tra số tiền' : fmtFull(bill.amount)}</p>
              {reader.imported.has(emailBillKey(bill.source)) && <p className="text-sm text-emerald-700">Đã nhập vào thu chi</p>}
              {bill.blocked && <p className="text-sm text-amber-700">Cần kiểm tra thư gốc</p>}
            </div>
            <Button variant="outline" size="sm" onClick={() => select(bill)}>Xem hóa đơn</Button>
          </div>)}
        </div>
        {reader.nextPageToken && <Button variant="outline" disabled={reader.busy} onClick={() => void reader.search({ from, to }, true)}>Tải thêm thư</Button>}
        {selected && <section className="space-y-3 rounded-lg border p-4" aria-label="Kiểm tra hóa đơn">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Kiểm tra hóa đơn</h3>
            <a className="flex items-center gap-1 text-sm text-primary underline" href={`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(selected.source.mailbox)}#all/${encodeURIComponent(selected.source.message_id)}`} target="_blank" rel="noopener noreferrer">Mở thư gốc<ExternalLink className="h-3 w-3" /></a>
          </div>
          <p className="text-sm">Mã đơn/chuyến: {selected.source.receipt_id || 'Chưa xác định được'}</p>
          {selected.warnings.map((warning, index) => <p key={index} className="text-sm text-amber-700">{warning}</p>)}
          {already && <p role="status">Hóa đơn này đã được nhập. Kiểm tra phiếu hiện có trong Thu chi.</p>}
          {selected.blocked && <p role="alert" className="text-sm text-amber-700">Thư này chưa đủ thông tin để điền tự động. Mở thư gốc để đối chiếu; bạn có thể dùng Thêm phiếu trong Thu chi để nhập thủ công.</p>}
          <details><summary className="cursor-pointer text-sm">Nội dung email</summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 font-sans text-xs">{selected.text}</pre></details>
          <div><Label htmlFor="gmail-description">Nội dung chi</Label><Input id="gmail-description" value={name} maxLength={300} onChange={event => setName(event.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="gmail-date">Ngày chi</Label><Input id="gmail-date" type="date" value={date} onChange={event => setDate(event.target.value)} /></div>
            <div><Label htmlFor="gmail-amount">Số tiền (đồng)</Label><Input id="gmail-amount" inputMode="numeric" value={amount} onChange={event => setAmount(event.target.value)} placeholder="Ví dụ: 85000" /></div>
          </div>
          <div><Label htmlFor="gmail-category">Hạng mục chi</Label><select id="gmail-category" className="flex h-10 w-full rounded-md border bg-background px-3 text-sm" value={category} onChange={event => setCategory(event.target.value)} disabled={types.isLoading || types.isError}>
            <option value="">Chọn hạng mục</option>{choices.map(type => <option key={type.id} value={type.id}>{type.name}</option>)}
          </select>{types.isError && <p role="alert" className="text-sm text-destructive">Chưa tải được hạng mục chi. Đóng màn hình rồi thử lại.</p>}</div>
          <p className="text-xs text-muted-foreground">Kiểm tra tổng tiền đã thanh toán, phí và giảm giá trong thư gốc. Bill chỉ nằm trong file PDF/ảnh cần được đối chiếu và nhập thủ công.</p>
          <Button disabled={!canContinue} onClick={() => setFormOpen(true)}>Điền vào phiếu chi</Button>
        </section>}
      </>}
      {reader.error && <p role="alert" className="text-sm text-destructive">{reader.error}</p>}
    </DialogContent>
  </Dialog>;
}
