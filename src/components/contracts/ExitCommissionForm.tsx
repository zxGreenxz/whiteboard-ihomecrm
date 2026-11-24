import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAccounts } from '@/hooks/useAccounts';
import { useContractExitEarlyTerms, useCreateContractExitCommission } from '@/hooks/contracts/useContractExitEarlyTerms';
import { contractNumberLabel, hasLiveExitCommission, newContractDepositFull } from '@/lib/contractExitEarlyTerms';

const vnd = (value: number) => new Intl.NumberFormat('vi-VN').format(value);

/**
 * Phiếu hoa hồng môi giới của ca "nhờ sale tìm khách sang phòng": lập trên hợp đồng khách nhận, bằng đúng phí đã quyết
 * toán ở hồ sơ cũ, người nhận là tên sale đã ghi. Chỉ lập được khi khách nhận đã nộp đủ cọc (máy chủ kiểm lại).
 */
export function ExitCommissionForm({ exitCaseId, onDone, laterLabel = 'Để sau' }: {
  exitCaseId: string; onDone: () => void; laterLabel?: string;
}) {
  const id = useId();
  const query = useContractExitEarlyTerms({ exitCaseId });
  const create = useCreateContractExitCommission();
  const { data: accounts = [] } = useAccounts();
  const terms = query.data?.[0];
  const realAccounts = useMemo(() => accounts.filter(account => !account.is_virtual), [accounts]);
  const defaultAccount = useMemo(() => {
    const name = terms?.building_name?.trim().toLowerCase();
    const same = name ? realAccounts.filter(account => account.name?.trim().toLowerCase() === name) : [];
    return (same.find(account => account.is_default) ?? same[0] ?? realAccounts.find(account => account.is_default))?.id ?? '';
  }, [realAccounts, terms?.building_name]);
  const [accountId, setAccountId] = useState('');
  const [bank, setBank] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const requestIds = useRef(new Map<string, string>());
  useEffect(() => { if (!accountId && defaultAccount) setAccountId(defaultAccount); }, [accountId, defaultAccount]);

  if (query.isLoading) return <div className="h-24 animate-pulse rounded-md bg-muted" aria-label="Đang đọc hồ sơ hoa hồng" />;
  if (query.isError || !terms) return <div className="space-y-2 text-sm">
    <p role="alert" className="text-destructive">Không tải được hồ sơ trả phòng để lập phiếu hoa hồng.</p>
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => void query.refetch()}>Thử lại</Button>
      <Button variant="ghost" onClick={onDone}>{laterLabel}</Button></div>
  </div>;
  if (hasLiveExitCommission(terms)) return <div className="space-y-2 text-sm">
    <p role="status">Đã có phiếu hoa hồng môi giới <strong>{terms.commission_code ?? ''}</strong> cho sale {terms.sale_name}.</p>
    <div className="flex justify-end"><Button onClick={onDone}>Đóng</Button></div>
  </div>;
  if (!(terms.broker_fee > 0)) return <div className="space-y-2 text-sm">
    <p role="status">Phí môi giới bằng 0 đồng: không phát sinh phiếu hoa hồng môi giới.</p>
    <div className="flex justify-end"><Button onClick={onDone}>Đóng</Button></div>
  </div>;
  const depositFull = newContractDepositFull(terms);
  const submit = async () => {
    const intent = JSON.stringify({ case: exitCaseId, version: terms.version, accountId, bank: bank.trim(), accountNo: accountNo.trim() });
    let requestId = requestIds.current.get(intent);
    if (!requestId) { requestId = crypto.randomUUID(); requestIds.current.set(intent, requestId); }
    try {
      await create.mutateAsync({ caseId: exitCaseId, expectedVersion: terms.version, requestId,
        accountId: accountId || null, recipientBank: bank.trim() || null, recipientAccount: accountNo.trim() || null });
      onDone();
    } catch { /* Hook đã báo lỗi (quyền / dữ liệu / phiên bản); giữ form để thử lại. */ }
  };
  return <div className="space-y-3 text-sm">
    <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 rounded-md bg-muted/40 p-3">
      <dt className="text-muted-foreground">Người nhận</dt><dd className="font-medium">{terms.sale_name}</dd>
      <dt className="text-muted-foreground">Số tiền</dt><dd className="font-medium">{vnd(terms.broker_fee)} đ (đúng phí môi giới đã quyết toán)</dd>
      <dt className="text-muted-foreground">Hợp đồng</dt><dd>Khách nhận {contractNumberLabel(terms.new_contract_number)} · khách cũ {contractNumberLabel(terms.old_contract_number)}</dd>
    </dl>
    {terms.commission_voucher_id && <p role="status" className="text-muted-foreground">
      Phiếu cũ {terms.commission_code ?? ''} đã huỷ hoặc xoá; lập phiếu mới thay thế.
    </p>}
    {!depositFull && <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900">
      Khách nhận phòng chưa nộp đủ cọc ({vnd(terms.new_contract_deposit_paid ?? 0)} / {vnd(terms.new_contract_total_deposit ?? 0)} đ).
      Phiếu hoa hồng chỉ lập được khi đã thu đủ cọc; hồ sơ trả phòng sẽ tiếp tục nhắc.
    </p>}
    <div className="space-y-1">
      <Label htmlFor={`${id}-account`}>Sổ quỹ chi</Label>
      <Select value={accountId} onValueChange={setAccountId} disabled={create.isPending}>
        <SelectTrigger id={`${id}-account`}><SelectValue placeholder="Chọn sổ quỹ (để trống: chọn khi duyệt)" /></SelectTrigger>
        <SelectContent>{realAccounts.map(account => <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1"><Label htmlFor={`${id}-bank`}>Ngân hàng người nhận</Label>
        <Input id={`${id}-bank`} value={bank} maxLength={200} disabled={create.isPending} onChange={event => setBank(event.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor={`${id}-number`}>Số tài khoản</Label>
        <Input id={`${id}-number`} value={accountNo} maxLength={200} inputMode="numeric" disabled={create.isPending}
          onChange={event => setAccountNo(event.target.value)} /></div>
    </div>
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button type="button" variant="ghost" disabled={create.isPending} onClick={onDone}>{laterLabel}</Button>
      <Button type="button" disabled={!depositFull || create.isPending} onClick={() => void submit()}>
        {create.isPending ? 'Đang lập phiếu…' : 'Lập phiếu hoa hồng'}
      </Button>
    </div>
  </div>;
}

export function ExitCommissionDialog({ exitCaseId, open, onOpenChange }: { exitCaseId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Phiếu hoa hồng môi giới sang nhượng phòng</DialogTitle>
        <DialogDescription>Lập trên hợp đồng khách nhận, bằng đúng phí môi giới đã quyết toán ở hồ sơ trả phòng cũ.</DialogDescription>
      </DialogHeader>
      {open && <ExitCommissionForm exitCaseId={exitCaseId} onDone={() => onOpenChange(false)} />}
    </DialogContent>
  </Dialog>;
}
