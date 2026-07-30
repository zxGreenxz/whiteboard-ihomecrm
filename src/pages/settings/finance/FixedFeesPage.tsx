import { useMemo, useState } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { RefreshCw, Check, X, Pencil, Eraser, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import {
  FEE_KINDS, useFeeConfigMatrix, useSaveFeeConfig,
  type FeeConfigCell, type FeeKind,
} from '@/hooks/useFeeConfigMatrix';

const fmt = (n: number | null) =>
  n == null ? '—' : n.toLocaleString('vi-VN') + 'đ';

/** Bỏ mọi ký tự không phải số để người dùng dán được "1.500.000đ". */
const parseAmount = (s: string): number | null => {
  const digits = s.replace(/[^\d]/g, '');
  if (!digits) return null;
  return Number(digits);
};

interface EditState {
  buildingId: string;
  feeCategory: FeeKind;
  amount: string;
  providerCode: string;
  accountHolder: string;
}

export default function FixedFeesPage() {
  const { data, isLoading, isError, error, refetch, isFetching, byBuilding, summary } =
    useFeeConfigMatrix();
  const save = useSaveFeeConfig();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [onlyMissing, setOnlyMissing] = useState(false);

  const buildings = useMemo(() => {
    const list = [...byBuilding.entries()].map(([id, v]) => ({ id, name: v.name, cells: v.cells }));
    if (!onlyMissing) return list;
    return list.filter(({ cells }) =>
      [...cells.values()].some((c) => !c.notApplicable && (c.defaultAmount == null || c.defaultAmount <= 0)),
    );
  }, [byBuilding, onlyMissing]);

  const beginEdit = (c: FeeConfigCell) =>
    setEdit({
      buildingId: c.buildingId,
      feeCategory: c.feeCategory,
      amount: c.defaultAmount == null ? '' : String(c.defaultAmount),
      providerCode: c.providerCode,
      accountHolder: c.accountHolder,
    });

  const commit = async (clearAmount = false) => {
    if (!edit) return;
    const parsed = parseAmount(edit.amount);
    try {
      await save.mutateAsync({
        buildingId: edit.buildingId,
        feeCategory: edit.feeCategory,
        // null ⇒ RPC bật cờ xoá. undefined ⇒ không đụng.
        defaultAmount: clearAmount ? null : (parsed ?? undefined),
        providerCode: edit.providerCode.trim() === '' ? undefined : edit.providerCode.trim(),
        accountHolder: edit.accountHolder.trim() === '' ? undefined : edit.accountHolder.trim(),
      });
      toast.success(clearAmount ? 'Đã xoá giá mặc định' : 'Đã lưu cấu hình');
      setEdit(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Không lưu được');
    }
  };

  const toggleNotApplicable = async (c: FeeConfigCell) => {
    try {
      await save.mutateAsync({
        buildingId: c.buildingId,
        feeCategory: c.feeCategory,
        notApplicable: !c.notApplicable,
      });
      toast.success(!c.notApplicable
        ? `Đã tắt "${FEE_KINDS.find((k) => k.key === c.feeCategory)?.label}" cho toà này`
        : 'Đã bật lại hạng mục');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Không đổi được');
    }
  };

  return (
    <MainLayout>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Phí cố định theo toà</h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
              Giá mặc định của từng hạng mục cho từng toà. Trang Thanh toán dùng giá này để
              gợi ý số tiền mỗi kỳ — bạn vẫn sửa được số tiền và chọn sổ quỹ ở lúc đóng.
              Hệ thống cũng <strong>tự học</strong> giá này sau mỗi lần đóng, nên phần lớn ô sẽ
              tự điền dần.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
            Tải lại
          </Button>
        </div>

        {isError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-destructive">
              <AlertTriangle className="h-4 w-4" /> Không đọc được cấu hình
            </div>
            <p className="mt-1 text-muted-foreground">
              {error instanceof Error ? error.message : 'Lỗi không xác định'}
            </p>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Stat label="Ô cần khai" value={String(summary.total - summary.notApplicable)}
                    hint="Không tính ô đã tắt" />
              <Stat label="Đã có giá" value={String(summary.priced)} tone="ok" />
              <Stat label="Còn thiếu giá" value={String(summary.missing)}
                    tone={summary.missing > 0 ? 'warn' : 'ok'} />
              <Stat label="Đang chạy thật" value={String(summary.running)}
                    hint="Đã có phiếu chi đã duyệt" />
              <Stat label="Đã tắt" value={String(summary.notApplicable)}
                    hint="Không áp dụng cho toà đó" />
            </div>

            <label className="flex items-center gap-2 text-sm cursor-pointer w-fit">
              <Checkbox checked={onlyMissing}
                        onCheckedChange={(v) => setOnlyMissing(v === true)} />
              Chỉ hiện toà còn thiếu giá
            </label>

            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 bg-background z-10 min-w-[9rem]">Toà nhà</TableHead>
                    {FEE_KINDS.map((k) => (
                      <TableHead key={k.key} className="min-w-[8.5rem]">{k.label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {buildings.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={FEE_KINDS.length + 1}
                                 className="text-center text-sm text-muted-foreground py-8">
                        {onlyMissing ? 'Mọi toà đều đã có giá đủ.' : 'Chưa có toà nào bạn được cấu hình.'}
                      </TableCell>
                    </TableRow>
                  )}
                  {buildings.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="sticky left-0 bg-background z-10 font-medium">
                        {b.name}
                      </TableCell>
                      {FEE_KINDS.map((k) => {
                        const c = b.cells.get(k.key);
                        if (!c) return <TableCell key={k.key}>—</TableCell>;
                        const editing = edit?.buildingId === b.id && edit.feeCategory === k.key;
                        return (
                          <TableCell key={k.key} className="align-top">
                            {editing ? (
                              <div className="space-y-1.5 min-w-[8rem]">
                                <Input autoFocus inputMode="numeric" placeholder="Giá mỗi kỳ"
                                       value={edit.amount}
                                       onChange={(e) => setEdit({ ...edit, amount: e.target.value })}
                                       onKeyDown={(e) => {
                                         if (e.key === 'Enter') commit();
                                         if (e.key === 'Escape') setEdit(null);
                                       }}
                                       className="h-8 text-sm" />
                                <Input placeholder="Mã khách hàng" value={edit.providerCode}
                                       onChange={(e) => setEdit({ ...edit, providerCode: e.target.value })}
                                       className="h-8 text-xs" />
                                <Input placeholder="Chủ hộ" value={edit.accountHolder}
                                       onChange={(e) => setEdit({ ...edit, accountHolder: e.target.value })}
                                       className="h-8 text-xs" />
                                <div className="flex items-center gap-1">
                                  <Button size="sm" className="h-7 px-2" onClick={() => commit()}
                                          disabled={save.isPending}>
                                    <Check className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button size="sm" variant="ghost" className="h-7 px-2"
                                          onClick={() => setEdit(null)}>
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                  {c.defaultAmount != null && (
                                    <TooltipProvider>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Button size="sm" variant="ghost"
                                                  className="h-7 px-2 text-destructive"
                                                  onClick={() => commit(true)}
                                                  disabled={save.isPending}>
                                            <Eraser className="h-3.5 w-3.5" />
                                          </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Xoá giá mặc định</TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-1">
                                {c.notApplicable ? (
                                  <Badge variant="outline" className="text-muted-foreground">
                                    Không áp dụng
                                  </Badge>
                                ) : (
                                  <button type="button"
                                          onClick={() => beginEdit(c)}
                                          className="group flex items-center gap-1 text-sm hover:underline"
                                          aria-label={`Sửa ${k.label} của ${b.name}`}>
                                    <span className={c.defaultAmount == null ? 'text-muted-foreground italic' : 'font-medium tabular-nums'}>
                                      {c.defaultAmount == null ? 'chưa có giá' : fmt(c.defaultAmount)}
                                    </span>
                                    <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
                                  </button>
                                )}
                                {c.providerCode && (
                                  <div className="text-[11px] text-muted-foreground truncate max-w-[8rem]"
                                       title={c.providerCode}>
                                    {c.providerCode}
                                  </div>
                                )}
                                {c.voucherCount > 0 && (
                                  <div className="text-[11px] text-muted-foreground">
                                    {c.voucherCount} phiếu
                                    {c.lastVoucherDate ? ` · ${c.lastVoucherDate}` : ''}
                                  </div>
                                )}
                                <button type="button"
                                        onClick={() => toggleNotApplicable(c)}
                                        disabled={save.isPending}
                                        className="text-[11px] text-muted-foreground hover:text-foreground underline decoration-dotted">
                                  {c.notApplicable ? 'Bật lại' : 'Tắt hạng mục'}
                                </button>
                              </div>
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <p className="text-xs text-muted-foreground max-w-3xl">
              Bấm vào số tiền để sửa. Bỏ trống ô giá rồi lưu thì <strong>giữ nguyên giá cũ</strong> —
              muốn bỏ hẳn giá thì bấm nút xoá (biểu tượng cục tẩy). “Tắt hạng mục” dùng cho toà
              không phát sinh khoản đó; ô đã tắt sẽ không còn bị tính là còn thiếu.
            </p>
          </>
        )}
      </div>
    </MainLayout>
  );
}

function Stat({ label, value, hint, tone }: {
  label: string; value: string; hint?: string; tone?: 'ok' | 'warn';
}) {
  const toneCls =
    tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'warn' ? 'text-amber-600 dark:text-amber-400'
    : '';
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}
