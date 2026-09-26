import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { AlertTriangle, RefreshCw, Pencil, Plus, Trash2, CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useIncomeExpenseTypes } from '@/hooks/useIncomeExpenseTypes';
import {
  SPEND_FEE_KEYS, SPEND_FEE_LABEL, SPEND_MODE_LABEL, SPEND_REASON_LABEL, SPEND_WRITER_LABEL,
  useMySpendOrganizations, useSpendEngineStatus, useSpendCommitments, useSetSpendCommitment,
  useSpendSwitches, useSetSpendSwitch, useSpendShadowReport, useSelfApprovedVouchers,
  useSetTypeSpendRule,
  type SpendFeeKey, type SpendMode, type SpendCommitmentRow,
} from '@/hooks/useSpendEngine';

const fmt = (n: number | null | undefined) =>
  n == null ? '—' : Math.round(n).toLocaleString('vi-VN') + 'đ';

const parseAmount = (s: string): number | null => {
  const digits = s.replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
};

const pad = (n: number) => String(n).padStart(2, '0');
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return isoDay(d); };

/** Cam kết dưới mức này gần như chắc là số sót (vd phí công an 7.000đ). */
const SO_NHO_BAT_THUONG = 50_000;

const ROUTE_LABEL: Record<string, { text: string; tone: 'secondary' | 'default' | 'destructive' | 'outline' }> = {
  LEGACY: { text: 'Đang tắt', tone: 'outline' },
  SHADOW: { text: 'Đang chạy thử — chưa đổi cách duyệt', tone: 'secondary' },
  CANONICAL: { text: 'Đang áp dụng', tone: 'default' },
  FROZEN: { text: 'Tạm đóng băng — đi luật cũ', tone: 'destructive' },
};

const STATUS_LABEL: Record<string, string> = {
  APPROVED: 'Đã duyệt', UNAPPROVED: 'Chờ duyệt', CANCELLED: 'Đã huỷ',
};

function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : 'Lỗi không xác định';
  const chiChu = /Chỉ chủ công ty|42501/.test(msg);
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangle className="h-4 w-4" />
        {chiChu ? 'Trang này chỉ dành cho chủ công ty hoặc quản trị hệ thống' : 'Không đọc được dữ liệu'}
      </div>
      {!chiChu && <p className="mt-1 text-muted-foreground">{msg}</p>}
    </div>
  );
}

// ─────────────────────────────── Cam kết tháng ───────────────────────────────
interface EditCommit { buildingId: string; buildingName: string; fee: SpendFeeKey; month: string; amount: string; note: string; current: SpendCommitmentRow | null }

function CommitmentsTab({ orgId }: { orgId: string }) {
  const [month, setMonth] = useState(thisMonth());
  const q = useSpendCommitments(orgId, month, month);
  const save = useSetSpendCommitment();
  const [edit, setEdit] = useState<EditCommit | null>(null);
  const buildings = useQuery({
    queryKey: ['spend-engine', 'buildings', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('buildings').select('id, name')
        .eq('organization_id', orgId).is('deleted_at', null).order('name');
      if (error) throw new Error(error.message);
      return (data ?? []) as { id: string; name: string }[];
    },
    staleTime: 10 * 60_000,
  });

  const byCell = useMemo(() => {
    const m = new Map<string, SpendCommitmentRow>();
    for (const r of q.data ?? []) m.set(`${r.building_id}:${r.fee_category}`, r);
    return m;
  }, [q.data]);
  const rows = useMemo(() => {
    const withData = new Set((q.data ?? []).map((r) => r.building_id));
    return (buildings.data ?? []).filter((b) => withData.has(b.id) || (q.data ?? []).length === 0);
  }, [buildings.data, q.data]);
  const tong = useMemo(() => (q.data ?? []).filter((r) => r.fee_category === 'tien_nha')
    .reduce((s, r) => s + r.amount, 0), [q.data]);

  const onSave = async () => {
    if (!edit) return;
    try {
      const amount = parseAmount(edit.amount);
      await save.mutateAsync({ buildingId: edit.buildingId, feeCategory: edit.fee, month: edit.month, amount, note: edit.note || undefined });
      toast.success(amount ? 'Đã lưu cam kết' : 'Đã thu hồi cam kết tháng này');
      setEdit(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Không lưu được');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="ck-thang">Tháng</Label>
          <Input id="ck-thang" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" />
        </div>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Mỗi ô là số tiền bạn <strong>ký trước</strong> cho toà × hạng mục trong tháng. Phiếu chi nằm trong phần
          còn lại thì máy duyệt; vượt thì chờ bạn duyệt và cam kết <strong>không tự nới</strong>. Tháng đã có khoản
          chi thì không sửa được nữa (không hồi tố). Tổng tiền nhà tháng này: <strong>{fmt(tong)}</strong>.
        </p>
      </div>
      {q.isError && <ErrorBox error={q.error} />}
      {q.isLoading || buildings.isLoading ? <Skeleton className="h-64 w-full" /> : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background">Toà</TableHead>
                {SPEND_FEE_KEYS.map((k) => (
                  <TableHead key={k} className="text-right whitespace-nowrap">
                    {SPEND_FEE_LABEL[k]}{(k === 'dien' || k === 'nuoc') && <span className="block text-[10px] font-normal text-muted-foreground">đi theo trần</span>}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="sticky left-0 bg-background font-medium whitespace-nowrap">{b.name}</TableCell>
                  {SPEND_FEE_KEYS.map((k) => {
                    const c = byCell.get(`${b.id}:${k}`) ?? null;
                    const nho = c != null && c.amount < SO_NHO_BAT_THUONG;
                    const vuot = c != null && c.remaining < 0;
                    return (
                      <TableCell key={k} className="text-right align-top">
                        <button
                          type="button"
                          className="w-full text-right rounded px-1 py-0.5 hover:bg-muted"
                          onClick={() => setEdit({ buildingId: b.id, buildingName: b.name, fee: k, month, amount: c ? String(Math.round(c.amount)) : '', note: c?.note ?? '', current: c })}
                          title="Bấm để sửa cam kết"
                        >
                          {c ? (
                            <>
                              <span className={`font-medium ${nho ? 'text-amber-600' : ''}`}>{fmt(c.amount)}</span>
                              {nho && <AlertTriangle className="inline h-3 w-3 ml-1 text-amber-600" aria-label="Số nhỏ bất thường" />}
                              <span className={`block text-xs whitespace-nowrap ${vuot ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                                còn {fmt(c.remaining)}
                              </span>
                            </>
                          ) : <span className="text-muted-foreground">—</span>}
                        </button>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        <AlertTriangle className="inline h-3 w-3 mr-1 text-amber-600" />
        Ô vàng: số dưới {fmt(SO_NHO_BAT_THUONG)} — thường là số sót từ lần đóng cũ; nên kiểm lại trước khi bật áp dụng.
      </p>

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent>
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
                <Input id="ck-tien" inputMode="numeric" value={edit.amount}
                  onChange={(e) => setEdit({ ...edit, amount: e.target.value })} placeholder="vd 26.000.000" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ck-ghichu">Ghi chú</Label>
                <Input id="ck-ghichu" value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)}>Huỷ</Button>
            <Button onClick={onSave} disabled={save.isPending}>Lưu</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────────────────── Luật hạng mục ───────────────────────────────
interface TypeRow { id: string; name: string; fee_category?: string | null; spend_mode?: string | null; force_approval?: boolean | null; organization_id?: string | null }

function RulesTab({ orgId }: { orgId: string }) {
  const types = useIncomeExpenseTypes('expense');
  const setRule = useSetTypeSpendRule();
  const [chiCoLuat, setChiCoLuat] = useState(true);
  const list = useMemo(() => {
    const rows = ((types.data ?? []) as unknown as TypeRow[]).filter((t) => !t.organization_id || t.organization_id === orgId);
    const shown = chiCoLuat ? rows.filter((t) => t.fee_category || (t.spend_mode && t.spend_mode !== 'TUNG_PHIEU')) : rows;
    return [...shown].sort((a, b) => Number(!!b.fee_category) - Number(!!a.fee_category) || a.name.localeCompare(b.name, 'vi'));
  }, [types.data, orgId, chiCoLuat]);

  const change = async (t: TypeRow, mode: SpendMode) => {
    try {
      await setRule.mutateAsync({ typeId: t.id, mode });
      toast.success(`${t.name}: ${SPEND_MODE_LABEL[mode]}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Không đổi được luật');
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground max-w-3xl">
        Luật chi khai <strong>trên hạng mục</strong>: <strong>Theo cam kết</strong> (tiền nhà, internet, quản lý…) —
        so với số đã ký của tháng; <strong>Theo trần</strong> (điện, nước) — so với trần đã công bố;
        <strong> Từng phiếu</strong> — như cũ: người có quyền duyệt tự duyệt, còn lại từ 600.000đ thì chờ duyệt.
        Hạng mục mới mặc định Từng phiếu (chặt nhất). Chỉ chủ công ty đổi được.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={chiCoLuat} onCheckedChange={(v) => setChiCoLuat(v === true)} />
        Chỉ hiện hạng mục đã gắn khoá phí hoặc có luật riêng
      </label>
      {types.isError && <ErrorBox error={types.error} />}
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
              {list.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell>{t.fee_category ? SPEND_FEE_LABEL[t.fee_category as SpendFeeKey] ?? t.fee_category : '—'}</TableCell>
                  <TableCell>
                    <Select value={(t.spend_mode as SpendMode) ?? 'TUNG_PHIEU'} onValueChange={(v) => change(t, v as SpendMode)} disabled={setRule.isPending}>
                      <SelectTrigger className="w-40 h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(['CAM_KET', 'TRAN', 'TUNG_PHIEU'] as SpendMode[]).map((m) => (
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
    </div>
  );
}

// ─────────────────────────────── Bật áp dụng ───────────────────────────────
function SwitchesTab({ orgId, route }: { orgId: string; route: string | undefined }) {
  const q = useSpendSwitches(orgId);
  const set = useSetSpendSwitch();
  const [fee, setFee] = useState<SpendFeeKey>('tien_nha');
  const [from, setFrom] = useState(thisMonth());
  const [to, setTo] = useState('');
  const [building, setBuilding] = useState<string>('ALL');
  const buildings = useQuery({
    queryKey: ['spend-engine', 'buildings', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('buildings').select('id, name')
        .eq('organization_id', orgId).is('deleted_at', null).order('name');
      if (error) throw new Error(error.message);
      return (data ?? []) as { id: string; name: string }[];
    },
    staleTime: 10 * 60_000,
  });

  const add = async () => {
    try {
      const r = await set.mutateAsync({ orgId, feeCategory: fee, fromMonth: from, toMonth: to || null,
        buildingId: building === 'ALL' ? null : building, on: true });
      const thieu = (r?.toa_chua_co_cam_ket as string[] | undefined) ?? [];
      toast.success('Đã bật công tắc' + (thieu.length ? ` — lưu ý ${thieu.length} toà chưa ký cam kết sẽ về chờ duyệt` : ''));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Không bật được');
    }
  };
  const off = async (s: { fee_category: SpendFeeKey; building_id: string | null; period_from: string }) => {
    try {
      await set.mutateAsync({ orgId, feeCategory: s.fee_category, fromMonth: s.period_from.slice(0, 7), buildingId: s.building_id, on: false });
      toast.success('Đã tắt công tắc — hạng mục này đi luật cũ ngay');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Không tắt được');
    }
  };

  return (
    <div className="space-y-3">
      <div className={`rounded-md border p-3 text-sm ${route === 'CANONICAL' ? 'border-primary/40 bg-primary/5' : 'bg-muted/40'}`}>
        {route === 'CANONICAL'
          ? <>Bộ máy <strong>đang áp dụng</strong>: hạng mục × toà × tháng nào có công tắc dưới đây thì phiếu chi được máy quyết theo luật; còn lại đi như cũ.</>
          : <>Bộ máy <strong>đang chạy thử</strong>: mọi phiếu vẫn duyệt như cũ, máy chỉ ghi lại nó <em>sẽ</em> quyết thế nào (thẻ “Máy chấm thử”).
              Công tắc dưới đây chỉ có hiệu lực khi bộ máy chuyển sang áp dụng — theo plan đã chốt, sau ít nhất 14 ngày chạy thử (định kỳ: 30 ngày) và bạn xem thấy đúng.</>}
      </div>
      <div className="flex flex-wrap items-end gap-3 rounded-md border p-3">
        <div className="space-y-1">
          <Label>Hạng mục</Label>
          <Select value={fee} onValueChange={(v) => setFee(v as SpendFeeKey)}>
            <SelectTrigger className="w-40 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>{SPEND_FEE_KEYS.map((k) => <SelectItem key={k} value={k}>{SPEND_FEE_LABEL[k]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Toà</Label>
          <Select value={building} onValueChange={setBuilding}>
            <SelectTrigger className="w-48 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Tất cả toà</SelectItem>
              {(buildings.data ?? []).map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="sw-tu">Từ tháng</Label>
          <Input id="sw-tu" type="month" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="sw-toi">Tới tháng (bỏ trống = không hạn)</Label>
          <Input id="sw-toi" type="month" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </div>
        <Button onClick={add} disabled={set.isPending}><Plus className="h-4 w-4 mr-1" />Bật</Button>
      </div>
      {q.isError && <ErrorBox error={q.error} />}
      {q.isLoading ? <Skeleton className="h-24 w-full" /> : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow><TableHead>Hạng mục</TableHead><TableHead>Toà</TableHead><TableHead>Từ</TableHead><TableHead>Tới</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {(q.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Chưa bật công tắc nào — mọi phiếu đi luật cũ.</TableCell></TableRow>
              )}
              {(q.data ?? []).map((s) => (
                <TableRow key={s.switch_id}>
                  <TableCell>{SPEND_FEE_LABEL[s.fee_category] ?? s.fee_category}</TableCell>
                  <TableCell>{s.building_name ?? 'Tất cả toà'}</TableCell>
                  <TableCell>{s.period_from.slice(0, 7)}</TableCell>
                  <TableCell>{s.period_to ? s.period_to.slice(0, 7) : 'không hạn'}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => off(s)} disabled={set.isPending}><Trash2 className="h-4 w-4 mr-1" />Tắt</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── Máy chấm thử ───────────────────────────────
function ShadowTab({ orgId }: { orgId: string }) {
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
        <div className="text-sm pb-2 text-muted-foreground">{tong} phiếu · <span className={lech ? 'text-amber-600 font-medium' : ''}>{lech} lệch</span> · {canhBaoSo} cảnh báo sổ</div>
      </div>
      {q.isError && <ErrorBox error={q.error} />}
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
    </div>
  );
}

// ─────────────────────────────── Tự duyệt ───────────────────────────────
function SelfApprovedTab({ orgId }: { orgId: string }) {
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
        <div className="text-sm pb-2 text-muted-foreground">{q.data?.length ?? 0} phiếu · {fmt(tong)}</div>
      </div>
      {q.isError && <ErrorBox error={q.error} />}
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
    </div>
  );
}

// ─────────────────────────────── Trang ───────────────────────────────
export default function SpendEnginePage() {
  const orgs = useMySpendOrganizations();
  const [chosen, setChosen] = useState<string | null>(null);
  const orgId = chosen ?? orgs.data?.[0]?.id ?? null;
  const status = useSpendEngineStatus(orgId);
  const route = status.data?.route;
  const r = ROUTE_LABEL[route ?? ''] ?? null;

  return (
    <MainLayout>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Cam kết chi — một bộ máy duyệt chi</h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
              Mọi cửa chi (Thu chi, Thanh toán, điện nước, phiếu định kỳ, sinh phí hàng loạt) hỏi <strong>cùng một luật</strong>,
              và luật nằm <strong>trên hạng mục</strong>. Bạn ký trước số tiền mỗi tháng; chi trong cam kết thì máy duyệt,
              vượt thì chờ bạn duyệt.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(orgs.data?.length ?? 0) > 1 && (
              <Select value={orgId ?? ''} onValueChange={setChosen}>
                <SelectTrigger className="w-52 h-9"><SelectValue placeholder="Chọn công ty" /></SelectTrigger>
                <SelectContent>{(orgs.data ?? []).map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</SelectContent>
              </Select>
            )}
            <Button variant="outline" size="sm" onClick={() => status.refetch()} disabled={status.isFetching}>
              <RefreshCw className={`h-4 w-4 mr-2 ${status.isFetching ? 'animate-spin' : ''}`} />Tải lại
            </Button>
          </div>
        </div>

        {orgs.isError && <ErrorBox error={orgs.error} />}
        {status.isError && <ErrorBox error={status.error} />}
        {status.data && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border p-3 text-sm">
            <div className="flex items-center gap-2">Bộ máy: {r ? <Badge variant={r.tone}>{r.text}</Badge> : route}</div>
            <div>Chạy thử từ: <strong>{status.data.shadow_since ? status.data.shadow_since.slice(0, 10) : 'chưa có phiếu'}</strong></div>
            <div>30 ngày: <strong>{status.data.decisions_30d}</strong> phiếu chấm, <strong className={status.data.mismatches_30d ? 'text-amber-600' : ''}>{status.data.mismatches_30d}</strong> lệch, {status.data.enforced_30d} đã áp</div>
            <div>Cảnh báo sổ: <strong>{status.data.cashbook_warn_30d}</strong></div>
            <div>Công tắc bật: <strong>{status.data.switches_on}</strong></div>
            {status.data.errors_7d > 0 && <div className="text-destructive">Lỗi máy 7 ngày: {status.data.errors_7d}</div>}
          </div>
        )}

        {orgId && !status.isError && (
          <Tabs defaultValue="cam-ket">
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="cam-ket"><Pencil className="h-4 w-4 mr-1" />Cam kết tháng</TabsTrigger>
              <TabsTrigger value="luat">Luật hạng mục</TabsTrigger>
              <TabsTrigger value="cong-tac">Bật áp dụng</TabsTrigger>
              <TabsTrigger value="bong">Máy chấm thử</TabsTrigger>
              <TabsTrigger value="tu-duyet">Tự duyệt</TabsTrigger>
            </TabsList>
            <TabsContent value="cam-ket"><CommitmentsTab orgId={orgId} /></TabsContent>
            <TabsContent value="luat"><RulesTab orgId={orgId} /></TabsContent>
            <TabsContent value="cong-tac"><SwitchesTab orgId={orgId} route={route} /></TabsContent>
            <TabsContent value="bong"><ShadowTab orgId={orgId} /></TabsContent>
            <TabsContent value="tu-duyet"><SelfApprovedTab orgId={orgId} /></TabsContent>
          </Tabs>
        )}
      </div>
    </MainLayout>
  );
}
