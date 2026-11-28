import { SkeletonBar } from '@/components/loading/LoadingState';
import {QueryRegion} from '@/components/errors/QueryRegion';
import {useOperationFormFeedback} from '@/hooks/useOperationFormFeedback';
import {SPEND_ERROR_RULES,parseCommitmentAmount,validateSpendSwitch} from '@/lib/spendFeedback';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Plus, Trash2, CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useExpenseBuildings, useOrgExpenseRules } from '@/hooks/useBuildingExpenseDirectory';
import {
  SPEND_FEE_KEYS, SPEND_FEE_LABEL, SPEND_MODE_LABEL, SPEND_REASON_LABEL, SPEND_WRITER_LABEL,
  useSpendEngineStatus, useSpendCommitments, useSetSpendCommitment,
  useSpendSwitches, useSetSpendSwitch, useSpendShadowReport, useSelfApprovedVouchers,
  useSetTypeSpendRule,
  type SpendFeeKey, type SpendMode, type SpendCommitmentRow,
} from '@/hooks/useSpendEngine';

const fmt = (n: number | null | undefined) =>
  n == null ? '—' : Math.round(n).toLocaleString('vi-VN') + 'đ';

const pad = (n: number) => String(n).padStart(2, '0');
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return isoDay(d); };

export interface SpendCell {
  orgId: string;
  buildingId: string;
  buildingName: string;
  fee: SpendFeeKey;
  month: string;
}

const ROUTE_LABEL: Record<string, { text: string; tone: 'secondary' | 'default' | 'destructive' | 'outline' }> = {
  LEGACY: { text: 'Đang tắt', tone: 'outline' },
  SHADOW: { text: 'Đang chạy thử — chưa đổi cách duyệt', tone: 'secondary' },
  CANONICAL: { text: 'Đang áp dụng', tone: 'default' },
  FROZEN: { text: 'Tạm đóng băng — đi luật cũ', tone: 'destructive' },
};

const STATUS_LABEL: Record<string, string> = {
  APPROVED: 'Đã duyệt', UNAPPROVED: 'Chờ duyệt', CANCELLED: 'Đã huỷ',
};

// ─────────────────────────────── Cam kết tháng ───────────────────────────────
interface EditCommit { buildingId: string; buildingName: string; fee: SpendFeeKey; month: string; amount: string; note: string; current: SpendCommitmentRow | null }

export function CommitmentEditor({ orgId, buildingId, buildingName, fee, month }: SpendCell) {
  const q = useSpendCommitments(orgId, month, month, buildingId);
  const save = useSetSpendCommitment();
  const feedback = useOperationFormFeedback("lưu cam kết chi", {rules: SPEND_ERROR_RULES});
  const [edit, setEdit] = useState<EditCommit | null>(null);
  const current = q.data?.find(r => r.building_id === buildingId && r.fee_category === fee) ?? null;

  const onSave = async () => {
    if (!edit) return;
    let amount:number|null=null;let amountError:string|undefined;
    try{amount=parseCommitmentAmount(edit.amount);}catch(error){amountError=(error as Error).message;}
    await feedback.run(async()=>{
      const result=await save.mutateAsync({ buildingId:edit.buildingId,feeCategory:edit.fee,month:edit.month,amount,note:edit.note||undefined });
      const context=`${SPEND_FEE_LABEL[edit.fee]} — ${edit.buildingName}, tháng ${edit.month}`;
      toast[result.changed?'success':'info'](amount ? `Đã lưu cam kết ${context}.` : result.changed ? `Đã thu hồi cam kết ${context}.` : `${context}: không có cam kết để thu hồi; không thay đổi dữ liệu.`);
    },()=>setEdit(null),{amount:amountError});
  };

  return (
    <div className="space-y-3">
      <QueryRegion label="cam kết chi" queries={[q]} skeleton="lines">
        {current && <p className="text-sm">Cam kết tháng {month} <strong>{fmt(current.amount)}</strong> · còn {fmt(current.remaining)}</p>}
        <Button size="sm" variant="outline" title="Bấm để sửa cam kết" disabled={q.isError || !q.data || feedback.blocked}
          onClick={() => setEdit({ buildingId, buildingName, fee, month, current,
            amount: current ? String(current.amount) : '', note: current?.note ?? '' })}>
          {current ? 'Sửa cam kết' : 'Ký cam kết tháng'}
        </Button>
        {current && current.amount < 50_000 && <p className="text-sm text-amber-700">Cam kết dưới 50.000đ. Kiểm tra lại số đã ký.</p>}
      </QueryRegion>

      <Dialog open={!!edit} onOpenChange={(o) => !o && feedback.close(()=>setEdit(null))}>
        <DialogContent ref={feedback.root}>
          <DialogHeader>
            <DialogTitle>Cam kết {edit ? SPEND_FEE_LABEL[edit.fee] : ''} — {edit?.buildingName}</DialogTitle>
            <DialogDescription>
              Tháng {edit?.month}. Bỏ trống số tiền để thu hồi cam kết tháng này.
              {edit?.current && <> Hiện tại {fmt(edit.current.amount)}, còn lại {fmt(edit.current.remaining)}.</>}
            </DialogDescription>
          </DialogHeader>
          {edit && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="ck-tien">Số tiền cam kết</Label>
                <Input {...feedback.field("amount")} id="ck-tien" inputMode="numeric" value={edit.amount}
                  onChange={(e) => setEdit({ ...edit, amount: e.target.value })} placeholder="vd 26.000.000" />{feedback.issue("amount")}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ck-ghichu">Ghi chú</Label>
                <Input id="ck-ghichu" value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
              </div>
            </div>
          )}
          {feedback.notice}
          <DialogFooter>
            <Button variant="outline" onClick={() => feedback.close(()=>setEdit(null))}>Huỷ</Button>
            <Button onClick={onSave} disabled={save.isPending||feedback.saving||feedback.blocked||q.isError}>Lưu</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────────────────── Luật hạng mục ───────────────────────────────
interface TypeRow { id: string; name: string; fee_category?: string | null; spend_mode?: string | null; force_approval?: boolean | null; organization_id?: string | null }

export function RulesTab({ orgId, fee }: { orgId: string; fee?: SpendFeeKey }) {
  const types = useOrgExpenseRules(orgId);
  const setRule = useSetTypeSpendRule();
  const feedback=useOperationFormFeedback("đổi quy tắc duyệt chi",{rules:SPEND_ERROR_RULES});
  const [chiCoLuat, setChiCoLuat] = useState(true);
  const list = useMemo(() => {
    const rows = types.data ?? [];
    const shown = fee ? rows.filter(t => t.fee_category === fee) : chiCoLuat ? rows.filter((t) => t.fee_category || (t.spend_mode && t.spend_mode !== 'TUNG_PHIEU')) : rows;
    return [...shown].sort((a, b) => Number(!!b.fee_category) - Number(!!a.fee_category) || a.name.localeCompare(b.name, 'vi'));
  }, [types.data, chiCoLuat, fee]);

  const change = async (t:TypeRow,mode:SpendMode)=>{
    if(t.spend_mode===mode)return;
    await feedback.run(()=>setRule.mutateAsync({typeId:t.id,mode}),()=>toast.success(`Đã lưu ${t.name}: ${SPEND_MODE_LABEL[mode]}.`));
  };

  return (
    <div ref={feedback.root} className="space-y-3">{feedback.notice}
      <p className="text-sm text-muted-foreground max-w-3xl">
        Luật chi của hạng mục áp dụng <strong>cho toàn công ty</strong>: <strong>Theo cam kết</strong> (tiền nhà, internet, quản lý…) —
        so với số đã ký của tháng; <strong>Theo trần</strong> (điện, nước) — so với trần đã công bố;
        <strong> Từng phiếu</strong> — như cũ: người có quyền duyệt tự duyệt, còn lại từ ngưỡng tự duyệt của công ty thì chờ duyệt.
        Hạng mục mới mặc định Từng phiếu (chặt nhất). Chỉ chủ công ty đổi được.
      </p>
      {!fee && <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={chiCoLuat} onCheckedChange={(v) => setChiCoLuat(v === true)} />
        Chỉ hiện hạng mục đã gắn khoá phí hoặc có luật riêng
      </label>}
      {/* Mô tả + bộ lọc hiện ngay; chỉ bảng hạng mục chờ dữ liệu (chủ chốt 02/10/2026). */}
      <QueryRegion label="quy tắc hạng mục chi" queries={[types]} skeleton="table" rows={6}>
      {types.isLoading ? <Skeleton className="h-48 w-full" /> : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hạng mục chi</TableHead>
                <TableHead>Khoá phí</TableHead>
                <TableHead>Kiểu chi</TableHead>
                <TableHead>Bắt buộc duyệt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.length === 0 && <TableRow><TableCell colSpan={4}>Chưa có hạng mục chi phù hợp.</TableCell></TableRow>}
              {list.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell>{t.fee_category ? SPEND_FEE_LABEL[t.fee_category as SpendFeeKey] ?? t.fee_category : '—'}</TableCell>
                  <TableCell>
                    <Select value={(t.spend_mode as SpendMode) ?? 'TUNG_PHIEU'} onValueChange={(v) => change(t, v as SpendMode)} disabled={setRule.isPending||feedback.saving||feedback.blocked||types.isError}>
                      <SelectTrigger className="w-40 h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(['CAM_KET', 'TRAN', 'TUNG_PHIEU'] as SpendMode[]).filter(m => m === 'TUNG_PHIEU' || (m === 'CAM_KET' ? !!t.fee_category : ['dien','nuoc'].includes(t.fee_category ?? ''))).map((m) => (
                          <SelectItem key={m} value={m}>{SPEND_MODE_LABEL[m]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>{t.force_approval ? <Badge variant="outline">Có</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      </QueryRegion>
    </div>
  );
}

// ─────────────────────────────── Bật áp dụng ───────────────────────────────
export function SwitchesTab({ orgId, route, cell }: { orgId: string; route?: string; cell?: SpendCell }) {
  const q = useSpendSwitches(orgId, cell?.buildingId);
  const set = useSetSpendSwitch();
  const feedback=useOperationFormFeedback("lưu phạm vi áp dụng quy tắc chi",{rules:SPEND_ERROR_RULES});
  const [fee, setFee] = useState<SpendFeeKey>(cell?.fee ?? 'tien_nha');
  const [from, setFrom] = useState(cell?.month ?? thisMonth());
  const [to, setTo] = useState('');
  const [building, setBuilding] = useState<string>(cell?.buildingId ?? 'ALL');
  const buildings = useExpenseBuildings(orgId);

  const scopes = (q.data ?? []).filter(s => !cell || (s.fee_category === cell.fee &&
    (s.building_id === null || s.building_id === cell.buildingId)));

  const add=async()=>{
    await feedback.run(async()=>{
      const r=await set.mutateAsync({orgId,feeCategory:fee,fromMonth:from,toMonth:to||null,buildingId:building==='ALL'?null:building,on:true});
      const context=`${SPEND_FEE_LABEL[fee]}, từ tháng ${from}`;
      const message=r.active ? `Đã bật áp dụng quy tắc ${context}.` : `Đã lưu phạm vi ${context}. Chưa áp dụng vì quy tắc duyệt chi hiện chưa được bật.`;
      toast[r.missing.length?'warning':r.active?'success':'info'](message+(r.missing.length?` ${r.missing.length} tòa chưa ký cam kết; các phiếu thuộc phạm vi thiếu cam kết sẽ chờ duyệt.`:''));
    },()=>undefined,validateSpendSwitch(from,to));
  };
  const off=async(s:{fee_category:SpendFeeKey;building_id:string|null;period_from:string})=>{
    await feedback.run(async()=>{
      const r=await set.mutateAsync({orgId,feeCategory:s.fee_category,fromMonth:s.period_from.slice(0,7),buildingId:s.building_id,on:false});
      toast[r.changed?'success':'info'](r.changed?`Đã tắt ${r.count} phạm vi ${SPEND_FEE_LABEL[s.fee_category]} từ tháng ${s.period_from.slice(0,7)}. Các phạm vi khác còn bật vẫn giữ hiệu lực.`:'Phạm vi này đã tắt hoặc không còn tồn tại; không có thay đổi mới.');
    },()=>undefined);
  };

  return (
    <QueryRegion label="phạm vi áp dụng quy tắc chi" queries={[q,buildings]} skeleton="detail" rows={5}><div ref={feedback.root} className="space-y-3">{feedback.notice}
      <div className={`rounded-md border p-3 text-sm ${route === 'CANONICAL' ? 'border-primary/40 bg-primary/5' : 'bg-muted/40'}`}>
        {route === 'CANONICAL'
          ? <>Bộ máy <strong>đang áp dụng</strong>: hạng mục × toà × tháng nào có công tắc dưới đây thì phiếu chi được máy quyết theo luật; còn lại đi như cũ.</>
          : <>Trạng thái: <strong>{ROUTE_LABEL[route ?? '']?.text ?? 'Chưa xác định'}</strong>. Phạm vi đã lưu sẽ có hiệu lực khi bộ máy áp dụng.</>}
      </div>
      <div className="flex flex-wrap items-end gap-3 rounded-md border p-3">
        <div className="space-y-1">
          <Label>Hạng mục</Label>
          <Select disabled={!!cell} value={fee} onValueChange={(v) => setFee(v as SpendFeeKey)}>
            <SelectTrigger data-field-name="feeCategory" aria-invalid={!!feedback.issue("feeCategory")} className="w-40 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>{SPEND_FEE_KEYS.map((k) => <SelectItem key={k} value={k}>{SPEND_FEE_LABEL[k]}</SelectItem>)}</SelectContent>
          </Select>{feedback.issue("feeCategory")}
        </div>
        <div className="space-y-1">
          <Label>Toà</Label>
          <Select disabled={!!cell} value={building} onValueChange={setBuilding}>
            <SelectTrigger data-field-name="buildingId" aria-invalid={!!feedback.issue("buildingId")} className="w-48 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Tất cả toà</SelectItem>
              {(buildings.data ?? []).map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>{feedback.issue("buildingId")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="sw-tu">Từ tháng</Label>
          <Input {...feedback.field("fromMonth")} id="sw-tu" type="month" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-40" />{feedback.issue("fromMonth")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="sw-toi">Tới tháng (bỏ trống = không hạn)</Label>
          <Input {...feedback.field("toMonth")} id="sw-toi" type="month" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />{feedback.issue("toMonth")}
        </div>
        <Button onClick={add} disabled={set.isPending||feedback.saving||feedback.blocked||q.isError||buildings.isError}><Plus className="h-4 w-4 mr-1" />Bật</Button>
      </div>
      {q.isLoading ? <Skeleton className="h-24 w-full" /> : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow><TableHead>Hạng mục</TableHead><TableHead>Toà</TableHead><TableHead>Từ</TableHead><TableHead>Tới</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {scopes.length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Chưa có phạm vi nào đang bật ở đây.</TableCell></TableRow>
              )}
              {scopes.map((s) => (
                <TableRow key={s.switch_id}>
                  <TableCell>{SPEND_FEE_LABEL[s.fee_category] ?? s.fee_category}</TableCell>
                  <TableCell>{s.building_name ?? 'Tất cả toà'}</TableCell>
                  <TableCell>{s.period_from.slice(0, 7)}</TableCell>
                  <TableCell>{s.period_to ? s.period_to.slice(0, 7) : 'không hạn'}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => off(s)} disabled={(!!cell && s.building_id === null)||set.isPending||feedback.saving||feedback.blocked||q.isError||buildings.isError}><Trash2 className="h-4 w-4 mr-1" />Tắt</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div></QueryRegion>
  );
}

// ─────────────────────────────── Máy chấm thử ───────────────────────────────
export function ShadowTab({ orgId }: { orgId: string }) {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(isoDay(new Date()));
  const [chiLech, setChiLech] = useState(false);
  const q = useSpendShadowReport(orgId, from, to);
  const rows = useMemo(() => (q.data ?? []).filter((r) => !chiLech || !r.match || r.cashbook_ok === false), [q.data, chiLech]);
  const tong = q.data?.length ?? 0;
  const lech = (q.data ?? []).filter((r) => !r.match).length;
  const canhBaoSo = (q.data ?? []).filter((r) => r.cashbook_ok === false).length;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground max-w-3xl">
        Mỗi phiếu sinh ra, máy chấm ngay lúc đó: <strong>thực tế</strong> phiếu đã duyệt hay chờ, và <strong>máy</strong> sẽ
        quyết thế nào theo luật hạng mục. Lệch là chỗ cần xem: hoặc đó chính là thay đổi bạn muốn (vd quản lý trả tiền nhà
        trong cam kết thì máy duyệt), hoặc là máy sai. “Không giữ sổ”: người lập không giữ sổ đó để chi — khi bật kiểm sổ,
        phiếu này sẽ chờ duyệt.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1"><Label htmlFor="sh-tu">Từ ngày</Label><Input id="sh-tu" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-40" /></div>
        <div className="space-y-1"><Label htmlFor="sh-toi">Tới ngày</Label><Input id="sh-toi" type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-40" /></div>
        <label className="flex items-center gap-2 text-sm pb-2"><Checkbox checked={chiLech} onCheckedChange={(v) => setChiLech(v === true)} />Chỉ phiếu lệch / cảnh báo sổ</label>
        {q.data !== undefined ? (
          <div className="text-sm pb-2 text-muted-foreground">{tong} phiếu · <span className={lech ? 'text-amber-600 font-medium' : ''}>{lech} lệch</span> · {canhBaoSo} cảnh báo sổ</div>
        ) : q.isLoading ? <div className="pb-2"><SkeletonBar className="inline-block h-3.5 align-middle" style={{ width: '12rem' }} /></div> : null}
      </div>
      {/* Mô tả + bộ lọc ngày hiện ngay; chỉ bảng phiếu chờ dữ liệu (chủ chốt 02/10/2026). */}
      <QueryRegion label="kết quả đối chiếu duyệt chi" queries={[q]} skeleton="table" rows={6}>
      {q.isLoading ? <Skeleton className="h-48 w-full" /> : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ngày</TableHead><TableHead>Mã</TableHead><TableHead>Toà</TableHead><TableHead>Cửa</TableHead>
                <TableHead>Hạng mục</TableHead><TableHead className="text-right">Số tiền</TableHead>
                <TableHead>Thực tế</TableHead><TableHead>Máy quyết</TableHead><TableHead>Khớp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">Chưa có phiếu nào trong khoảng này.</TableCell></TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.voucher_id}>
                  <TableCell className="whitespace-nowrap">{r.voucher_date ?? r.decided_at.slice(0, 10)}</TableCell>
                  <TableCell className="whitespace-nowrap">{r.code ?? '—'}</TableCell>
                  <TableCell>{r.building_name ?? '—'}</TableCell>
                  <TableCell className="whitespace-nowrap">{SPEND_WRITER_LABEL[r.writer] ?? r.writer}</TableCell>
                  <TableCell>{r.fee_categories ? r.fee_categories.split(', ').map((k) => SPEND_FEE_LABEL[k as SpendFeeKey] ?? k).join(', ') : '—'}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{fmt(r.amount)}</TableCell>
                  <TableCell>{STATUS_LABEL[r.birth_status] ?? r.birth_status}</TableCell>
                  <TableCell>
                    {STATUS_LABEL[r.engine_status] ?? r.engine_status}
                    <span className="block text-xs text-muted-foreground">{SPEND_REASON_LABEL[r.engine_reason] ?? r.engine_reason}</span>
                    {r.cashbook_ok === false && <Badge variant="outline" className="mt-1 text-amber-700 border-amber-400">Không giữ sổ</Badge>}
                    {r.enforced && <Badge className="mt-1 ml-1">Đã áp</Badge>}
                  </TableCell>
                  <TableCell>{r.match ? <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="Khớp" /> : <XCircle className="h-4 w-4 text-amber-600" aria-label="Lệch" />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      </QueryRegion>
    </div>
  );
}

// ─────────────────────────────── Tự duyệt ───────────────────────────────
export function SelfApprovedTab({ orgId }: { orgId: string }) {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(isoDay(new Date()));
  const q = useSelfApprovedVouchers(orgId, from, to);
  const tong = (q.data ?? []).reduce((s, r) => s + r.amount, 0);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground max-w-3xl">
        Phiếu mà <strong>người lập có quyền duyệt</strong> nên được duyệt luôn (giữ nguyên, không thêm thao tác) — ở đây chỉ
        để bạn lọc và đếm được: tự duyệt lúc lập, hoặc người lập tự bấm duyệt phiếu của mình.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1"><Label htmlFor="td-tu">Từ ngày</Label><Input id="td-tu" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-40" /></div>
        <div className="space-y-1"><Label htmlFor="td-toi">Tới ngày</Label><Input id="td-toi" type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-40" /></div>
        {q.data !== undefined ? (
          <div className="text-sm pb-2 text-muted-foreground">{q.data.length} phiếu · {fmt(tong)}</div>
        ) : q.isLoading ? <div className="pb-2"><SkeletonBar className="inline-block h-3.5 align-middle" style={{ width: '10rem' }} /></div> : null}
      </div>
      {/* Mô tả + bộ lọc ngày hiện ngay; chỉ bảng phiếu chờ dữ liệu (chủ chốt 02/10/2026). */}
      <QueryRegion label="phiếu tự duyệt" queries={[q]} skeleton="table" rows={6}>
      {q.isLoading ? <Skeleton className="h-48 w-full" /> : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ngày</TableHead><TableHead>Mã</TableHead><TableHead>Toà</TableHead><TableHead>Loại</TableHead>
                <TableHead className="text-right">Số tiền</TableHead><TableHead>Người lập</TableHead><TableHead>Kiểu</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data ?? []).map((r) => (
                <TableRow key={r.voucher_id}>
                  <TableCell className="whitespace-nowrap">{r.voucher_date}</TableCell>
                  <TableCell className="whitespace-nowrap">{r.code ?? '—'}</TableCell>
                  <TableCell>{r.building_name ?? '—'}</TableCell>
                  <TableCell>{r.type === 'INCOME' ? 'Thu' : 'Chi'}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{fmt(r.amount)}</TableCell>
                  <TableCell>{r.maker_name ?? '—'}</TableCell>
                  <TableCell className="text-xs">{r.kind}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      </QueryRegion>
    </div>
  );
}

export function SpendStatus({ orgId }: { orgId: string }) {
  const status = useSpendEngineStatus(orgId);
  const r = ROUTE_LABEL[status.data?.route ?? ''];
  return <QueryRegion label="trạng thái quy tắc duyệt chi" queries={[status]}>
        {status.data && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border p-3 text-sm">
            <div className="flex items-center gap-2">Bộ máy: {r ? <Badge variant={r.tone}>{r.text}</Badge> : 'Chưa xác định trạng thái'}</div>
            <div>Chạy thử từ: <strong>{status.data.shadow_since ? status.data.shadow_since.slice(0, 10) : 'chưa có phiếu'}</strong></div>
            <div>30 ngày: <strong>{status.data.decisions_30d}</strong> phiếu chấm, <strong className={status.data.mismatches_30d ? 'text-amber-600' : ''}>{status.data.mismatches_30d}</strong> lệch, {status.data.enforced_30d} đã áp</div>
            <div>Cảnh báo sổ: <strong>{status.data.cashbook_warn_30d}</strong></div>
            <div>Công tắc bật: <strong>{status.data.switches_on}</strong></div>
            {status.data.errors_7d > 0 && <div className="text-destructive">Lỗi máy 7 ngày: {status.data.errors_7d}</div>}
          </div>
        )}

  </QueryRegion>;
}
