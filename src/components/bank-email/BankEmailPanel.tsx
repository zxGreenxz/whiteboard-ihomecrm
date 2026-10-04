import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { MailCheck, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useOrganization } from '@/contexts/OrganizationContext';
import {
  useBankEmailCashbooks,
  useBankEmailInbox,
  useBankInvoiceCandidates,
  useDisconnectBankEmail,
  useReviewBankEmail,
  useSetBankEmailEnabled,
  useSetupBankEmail,
  useStartBankEmailOAuth,
} from '@/hooks/useBankEmail';
import { BankEmailActualOutcomeError, BankEmailReviewPendingError, bankEmailWorkerUrl, type BankEmailConnection, type BankEmailTransaction } from '@/lib/bankEmail';
import { friendlyError } from '@/lib/friendlyError';

const setupSchema = z.object({
  bankAccount: z.string().trim().regex(/^\d{6,30}$/, 'Nhập số tài khoản ACB gồm 6–30 chữ số.'),
  accountId: z.string().uuid('Chọn sổ nhận chuyển khoản.'),
});
type SetupValues = z.infer<typeof setupSchema>;

function displayError(error: unknown, operation: string): string {
  if (error instanceof BankEmailActualOutcomeError || error instanceof BankEmailReviewPendingError) return error.message;
  const feedback = friendlyError(error, `Chưa ${operation}`, { operation, financial: operation.includes('đối soát') });
  return `${feedback.title}. ${feedback.description}`;
}

function dateTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(value)) : 'Chưa có';
}

function money(value: number | null): string {
  return value === null ? 'Chưa xác định' : `${new Intl.NumberFormat('vi-VN').format(value)} ₫`;
}

function connectionStatus(connection: BankEmailConnection): string {
  switch (connection.status) {
    case 'CONNECTED': return 'Gmail đã kết nối';
    case 'AUTHORIZING': return 'Đang ủy quyền Gmail';
    case 'RECONNECT_REQUIRED': return 'Cần kết nối lại Gmail';
    default: return 'Chưa kết nối Gmail';
  }
}

function transactionStatus(transaction: BankEmailTransaction): string {
  switch (transaction.status) {
    case 'POSTED': return 'Đã ghi thu';
    case 'IGNORED': return 'Đã bỏ qua';
    default: return 'Chờ đối soát';
  }
}

function reasonText(reason: string | null): string | null {
  if (!reason) return null;
  const known: Record<string, string> = {
    NO_MATCH: 'Chưa tìm thấy đúng một mã hóa đơn.',
    MULTIPLE_MATCHES: 'Nội dung có nhiều mã hóa đơn.',
    INVOICE_NOT_UNIQUE: 'Không tìm thấy đúng một mã hóa đơn phù hợp.',
    AMOUNT_MISMATCH: 'Số tiền giao dịch khác số còn phải thu.',
    INVALID_SIGNATURE: 'Chưa xác minh được chữ ký email.',
    UNVERIFIED: 'Email chưa được xác minh.',
    DEBIT: 'Đây là giao dịch ghi nợ.',
    OLD_MESSAGE: 'Giao dịch có trước mốc bật tự ghi.',
    AUTO_DISABLED_OR_OLD: 'Tự ghi đang tắt hoặc giao dịch có trước mốc bật.',
    UNSAFE_TRANSACTION: 'Thông tin giao dịch chưa đủ an toàn để ghi thu.',
    PARSE_ERROR: 'Không đọc được đầy đủ thông tin trong email ACB.',
    PERMISSION_REQUIRED: 'Người kết nối cần được cấp lại quyền thu vào sổ.',
    WRITER_REJECTED: 'Khoản thu chưa vượt qua kiểm tra ghi sổ; cần đối chiếu.',
    USER_IGNORED: 'Người dùng đã bỏ qua giao dịch.',
  };
  return known[reason] ?? 'Giao dịch cần được kiểm tra thủ công.';
}

function BankEmailTransactionCard({ transaction, connection }: { transaction: BankEmailTransaction; connection?: BankEmailConnection }) {
  const [search, setSearch] = useState('');
  const [selectedInvoice, setSelectedInvoice] = useState<{ id: string; number: string } | null>(null);
  const [feedback, setFeedback] = useState<{ message: string; actualInvoiceId: string | null } | null>(null);
  const candidates = useBankInvoiceCandidates(search);
  const review = useReviewBankEmail();
  const eligible = transaction.verified && transaction.direction === 'CREDIT' && transaction.currency === 'VND' && transaction.account === connection?.bankAccount && transaction.amount !== null && Number.isSafeInteger(transaction.amount) && transaction.amount > 0;

  async function submit(action: 'post' | 'ignore') {
    setFeedback(null);
    try {
      if (!connection) throw new Error('Không xác định được kết nối của giao dịch.');
      const receipt = await review.mutateAsync(action === 'post'
        ? { transactionId: transaction.id, organizationId: connection.organizationId, action, invoiceNumber: selectedInvoice?.number ?? '', expectedInvoiceId: selectedInvoice?.id ?? '', expectedAmount: transaction.amount ?? 0 }
        : { transactionId: transaction.id, organizationId: connection.organizationId, action });
      if (receipt.status === 'POSTED') toast.success('Đã ghi thu và đối chiếu hóa đơn.');
      else toast.success('Đã bỏ qua giao dịch.');
    } catch (error) {
      setFeedback({
        message: displayError(error, 'đối soát giao dịch ACB'),
        actualInvoiceId: error instanceof BankEmailActualOutcomeError && error.actual.status === 'POSTED' ? error.actual.invoiceId : null,
      });
    }
  }

  return <article className="rounded-lg border p-4 space-y-3" aria-label={`Giao dịch ${transaction.bankReference ?? transaction.id}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="font-medium">{transaction.bankReference ? `Mã GD ${transaction.bankReference}` : 'Giao dịch chưa có mã ngân hàng'}</p>
        <p className="text-sm text-muted-foreground">{dateTime(transaction.occurredAt ?? transaction.internalDate)} · {connection?.bankAccount ?? transaction.account ?? 'Chưa rõ tài khoản'}</p>
      </div>
      <Badge variant={transaction.status === 'POSTED' ? 'default' : 'secondary'}>{transactionStatus(transaction)}</Badge>
    </div>
    <div className="grid gap-2 sm:grid-cols-2 text-sm">
      <p><span className="text-muted-foreground">Số tiền giao dịch:</span> <strong>{money(transaction.amount)}</strong></p>
      <p><span className="text-muted-foreground">Số dư sau giao dịch:</span> {money(transaction.balance)}</p>
    </div>
    {transaction.description && <p className="text-sm break-words">{transaction.description}</p>}
    {reasonText(transaction.reason) && <p className="text-sm text-amber-700 dark:text-amber-300">{reasonText(transaction.reason)}</p>}
    {transaction.status === 'PENDING' && <div className="space-y-3 border-t pt-3">
      {!eligible && <p className="text-sm text-muted-foreground">Giao dịch này chưa đủ điều kiện ghi thu. Có thể bỏ qua hoặc chờ kiểm tra nguồn.</p>}
      {eligible && <div className="space-y-2">
        <Label htmlFor={`bank-invoice-${transaction.id}`}>Mã hóa đơn cho giao dịch {transaction.bankReference ?? transaction.id}</Label>
        <Input id={`bank-invoice-${transaction.id}`} value={search} placeholder="Tìm mã hóa đơn chính xác" onChange={event => { setSearch(event.target.value); setSelectedInvoice(null); }} />
        {candidates.isError && <p role="alert" className="text-sm text-destructive">Chưa tìm được hóa đơn. Kiểm tra quyền và thử lại.</p>}
        {candidates.data && candidates.data.length > 0 && <div className="flex flex-wrap gap-2" aria-label="Hóa đơn tìm thấy">
          {candidates.data.map(invoice => <Button key={invoice.id} size="sm" type="button" variant={selectedInvoice?.id === invoice.id ? 'default' : 'outline'} onClick={() => { setSelectedInvoice({ id: invoice.id, number: invoice.invoice_number }); setSearch(invoice.invoice_number); }}>
            {invoice.invoice_number}
          </Button>)}
        </div>}
        {selectedInvoice && <p className="text-xs text-muted-foreground">Đã chọn hóa đơn {selectedInvoice.number}. Máy chủ sẽ kiểm lại số còn phải thu và quyền trước khi ghi.</p>}
      </div>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!eligible || !selectedInvoice || review.isPending} onClick={() => void submit('post')}>Xác nhận thu</Button>
        <Button type="button" size="sm" variant="outline" disabled={!connection || review.isPending} onClick={() => void submit('ignore')}>Bỏ qua giao dịch</Button>
      </div>
    </div>}
    {feedback && <div role="alert" className="space-y-1 text-sm text-destructive">
      <p>{feedback.message}</p>
      {feedback.actualInvoiceId && <a className="inline-block underline" href={`/invoices/${feedback.actualInvoiceId}`}>Xem hóa đơn đã ghi thu</a>}
    </div>}
  </article>;
}

export function BankEmailPanel() {
  const { selectedOrganizationId } = useOrganization();
  const inbox = useBankEmailInbox();
  const cashbooks = useBankEmailCashbooks();
  const setup = useSetupBankEmail();
  const enabled = useSetBankEmailEnabled();
  const disconnect = useDisconnectBankEmail();
  const oauth = useStartBankEmailOAuth();
  const workerUrl = bankEmailWorkerUrl();
  const [feedback, setFeedback] = useState('');
  const form = useForm<SetupValues>({ resolver: zodResolver(setupSchema), defaultValues: { bankAccount: '', accountId: '' } });
  const connections = inbox.data?.pages[0]?.connections ?? [];
  const transactions = useMemo(() => {
    const seen = new Set<string>();
    return (inbox.data?.pages.flatMap(page => page.transactions) ?? []).filter(transaction => {
      if (seen.has(transaction.id)) return false;
      seen.add(transaction.id);
      return true;
    });
  }, [inbox.data]);
  const byId = new Map(connections.map(connection => [connection.id, connection]));
  const cashbookNames = new Map((cashbooks.data ?? []).map(book => [book.id, book.name]));

  async function save(values: SetupValues) {
    setFeedback('');
    try {
      await setup.mutateAsync({ bankAccount: values.bankAccount ?? '', accountId: values.accountId ?? '' });
      form.reset();
      toast.success('Đã lưu cấu hình tài khoản ACB. Kết nối Gmail để bắt đầu nhận thư.');
    } catch (error) {
      setFeedback(displayError(error, 'lưu cấu hình ACB'));
    }
  }

  async function connect(connectionId: string) {
    setFeedback('');
    try {
      const url = await oauth.mutateAsync(connectionId);
      window.location.assign(url);
    } catch (error) {
      setFeedback(displayError(error, 'kết nối Gmail'));
    }
  }

  async function toggle(connectionId: string, desired: boolean) {
    setFeedback('');
    try {
      await enabled.mutateAsync({ connectionId, enabled: desired });
      toast.success(desired ? 'Đã bật tự ghi thu cho giao dịch mới.' : 'Đã tắt tự ghi thu.');
    } catch (error) {
      setFeedback(displayError(error, 'đổi chế độ tự ghi thu'));
    }
  }

  async function stop(connectionId: string) {
    setFeedback('');
    try {
      await disconnect.mutateAsync(connectionId);
      toast.success('Đã ngắt kết nối Gmail và dừng tự ghi thu.');
    } catch (error) {
      setFeedback(displayError(error, 'ngắt kết nối Gmail'));
    }
  }

  return <div className="space-y-5" aria-label="Email ACB">
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2"><MailCheck className="h-5 w-5" /><CardTitle>Email ACB</CardTitle></div>
        <CardDescription>Nhận thông báo ACB qua Gmail, đối soát hóa đơn và chỉ tự ghi thu giao dịch mới khi khớp chính xác tài khoản, mã hóa đơn và số còn phải thu.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!workerUrl && <p role="status" className="rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">Máy chủ kết nối Gmail chưa được cấu hình. Chưa thể kết nối hoặc bật tự ghi thu.</p>}
        {!selectedOrganizationId && <p role="status">Chọn tổ chức để xem giao dịch ACB.</p>}
        {inbox.isPending && selectedOrganizationId && <p>Đang tải hộp giao dịch ACB…</p>}
        {inbox.isError && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{(inbox.error as { code?: string } | null)?.code === 'PGRST202' ? 'Tính năng Email ACB chưa được cài trên máy chủ dữ liệu.' : 'Chưa tải được hộp giao dịch ACB. Kiểm tra quyền hoặc thử lại.'}</p><Button type="button" variant="outline" onClick={() => void inbox.refetch()}>Tải lại</Button></div>}
        {!inbox.isError && selectedOrganizationId && <>
          {connections.length === 0 && !inbox.isPending && <p className="text-sm text-muted-foreground">Chưa có kết nối ACB. Chọn số tài khoản và sổ nhận chuyển khoản bên dưới.</p>}
          {connections.map(connection => <div key={connection.id} className="rounded-lg border p-4 space-y-3">
            <div className="flex flex-wrap justify-between gap-2">
              <div><p className="font-medium">Tài khoản ACB {connection.bankAccount}</p><p className="text-sm text-muted-foreground">Sổ nhận: {cashbookNames.get(connection.accountId) ?? connection.accountId}</p></div>
              <Badge variant={connection.status === 'CONNECTED' && workerUrl ? 'default' : 'secondary'}>{connectionStatus(connection)}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">Gmail: {connection.email ?? 'Chưa kết nối'} · Đồng bộ gần nhất: {dateTime(connection.lastSyncedAt)}</p>
            {connection.lastError && <p role="alert" className="text-sm text-destructive">Đồng bộ gặp lỗi ({connection.lastError}). Kiểm tra kết nối Gmail.</p>}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" disabled={!workerUrl || oauth.isPending} onClick={() => void connect(connection.id)}>{connection.status === 'RECONNECT_REQUIRED' ? 'Kết nối lại Gmail' : 'Kết nối Gmail'}</Button>
              {connection.status !== 'DISCONNECTED' && <Button type="button" variant="ghost" disabled={disconnect.isPending} onClick={() => void stop(connection.id)}>Ngắt kết nối</Button>}
            </div>
            <div className="flex items-start gap-3 rounded-md bg-muted/40 p-3">
              <Switch checked={connection.enabled} disabled={!workerUrl || connection.status !== 'CONNECTED' || enabled.isPending} onCheckedChange={value => void toggle(connection.id, value)} aria-label={`Tự ghi thu tài khoản ${connection.bankAccount}`} />
              <div><p className="text-sm font-medium">Tự ghi thu khi khớp chính xác</p><p className="text-xs text-muted-foreground">Chỉ giao dịch từ lúc bật trở đi được tự ghi. Giao dịch không khớp vẫn chờ đối soát.</p>{connection.autoEnabledAt && <p className="text-xs text-muted-foreground">Mốc bật gần nhất: {dateTime(connection.autoEnabledAt)}</p>}</div>
            </div>
          </div>)}
          <form onSubmit={form.handleSubmit(values => void save(setupSchema.parse(values)))} className="rounded-lg border p-4 space-y-3">
            <p className="font-medium">Thêm tài khoản ACB</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1"><Label htmlFor="bank-email-account">Số tài khoản ACB</Label><Input id="bank-email-account" inputMode="numeric" autoComplete="off" {...form.register('bankAccount')} aria-invalid={!!form.formState.errors.bankAccount} />{form.formState.errors.bankAccount && <p role="alert" className="text-xs text-destructive">{form.formState.errors.bankAccount.message}</p>}</div>
              <div className="space-y-1"><Label htmlFor="bank-email-cashbook">Sổ nhận chuyển khoản</Label><select id="bank-email-cashbook" {...form.register('accountId')} className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">Chọn sổ nhận</option>{cashbooks.data?.map(book => <option key={book.id} value={book.id}>{book.name}</option>)}</select>{form.formState.errors.accountId && <p role="alert" className="text-xs text-destructive">{form.formState.errors.accountId.message}</p>}</div>
            </div>
            {cashbooks.isError && <p role="alert" className="text-sm text-destructive">Chưa tải được danh sách sổ nhận tiền.</p>}
            <Button type="submit" disabled={setup.isPending || cashbooks.isError || !cashbooks.data?.length}>Lưu tài khoản ACB</Button>
            <p className="text-xs text-muted-foreground">Sổ được kiểm quyền và khả năng nhận chuyển khoản khi lưu và mỗi lần ghi thu.</p>
          </form>
        </>}
        {feedback && <p role="alert" className="text-sm text-destructive">{feedback}</p>}
      </CardContent>
    </Card>

    <Card>
      <CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><div><CardTitle>Hộp giao dịch ACB</CardTitle><CardDescription>Thư đến Gmail có thể trễ so với thời điểm ngân hàng ghi nhận.</CardDescription></div><Button type="button" size="sm" variant="outline" onClick={() => void inbox.refetch()} disabled={inbox.isPending}><RefreshCw className="mr-1 h-4 w-4" />Tải lại</Button></div></CardHeader>
      <CardContent className="space-y-3">
        {!inbox.isPending && !inbox.isError && transactions.length === 0 && <p className="text-sm text-muted-foreground">Chưa có giao dịch ACB trong hộp thư.</p>}
        {transactions.map(transaction => <BankEmailTransactionCard key={transaction.id} transaction={transaction} connection={byId.get(transaction.connectionId)} />)}
        {inbox.hasNextPage && <Button type="button" variant="outline" disabled={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()}>{inbox.isFetchingNextPage ? 'Đang tải…' : 'Xem thêm giao dịch'}</Button>}
      </CardContent>
    </Card>
  </div>;
}
