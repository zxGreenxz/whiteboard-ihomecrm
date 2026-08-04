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
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RefreshCw, Check, X, Pencil, Eraser, AlertTriangle, BadgeCheck } from 'lucide-react';
import { toast } from 'sonner';
import {
  FEE_KINDS, useFeeConfigMatrix, useSaveFeeConfig,
  type FeeConfigCell, type FeeKind,
} from '@/hooks/useFeeConfigMatrix';
import { useSpecialFeePrices, useSetSpecialFeePrice } from '@/hooks/useSpecialFeePrices';

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

/** Hộp thoại công bố giá — chỉ chủ tổ chức thấy. */
interface PublishState {
  buildingId: string;
  buildingName: string;
  feeCategory: FeeKind;
  feeLabel: string;
  amount: string;
  month: string;           // 'YYYY-MM'
  currentAmount: number | null;
}

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export default function FixedFeesPage() {
  const { data, isLoading, isError, error, refetch, isFetching, byBuilding, summary } =
    useFeeConfigMatrix();
  const save = useSaveFeeConfig();
  const prices = useSpecialFeePrices();
  const setPrice = useSetSpecialFeePrice();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [publish, setPublish] = useState<PublishState | null>(null);
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

  const commitPublish = async () => {
    if (!publish) return;
    const parsed = parseAmount(publish.amount);
    if (!parsed || parsed <= 0) {
      toast.error('Nhập giá lớn hơn 0');
      return;
    }
    try {
      const res = await setPrice.mutateAsync({
        buildingId: publish.buildingId,
        feeCategory: publish.feeCategory,
        amount: parsed,
        effectiveFromMonth: publish.month,
      });
      toast.success(res?.note ?? 'Đã công bố giá');
      setPublish(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Không công bố được');
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
              Mỗi ô có <strong>hai con số</strong>, đừng nhầm:{' '}
              <strong className="text-foreground">Giá công bố</strong> là mức phí bạn chốt —
              ai đóng đúng mức này thì phiếu <strong>tự duyệt và vào sổ ngay</strong>, đóng lệch
              thì phiếu chờ bạn duyệt.{' '}
              <span className="text-foreground">Gợi ý</span> chỉ là số điền sẵn cho nhanh, lấy
              từ lần đóng gần nhất — nó <em>không</em> quyết định gì.
              Ô chưa công bố giá thì mọi thứ chạy y như trước.
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
              <Stat label="Đã công bố giá" value={String(prices.publishedCount)} tone="ok"
                    hint="Ô đóng đúng giá sẽ tự duyệt" />
              <Stat label="Chưa công bố"
                    value={String(Math.max(0, (summary.total - summary.notApplicable) - prices.publishedCount))}
                    tone={prices.publishedCount === 0 ? 'warn' : undefined}
                    hint="Vẫn chạy như trước" />
              <Stat label="Đang chạy thật" value={String(summary.running)}
                    hint="Đã có phiếu chi đã duyệt" />
              <Stat label="Đã tắt" value={String(summary.notApplicable)}
                    hint="Không áp dụng cho toà đó" />
            </div>

            {!prices.canEditAny && !prices.isLoading && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                Bạn xem được giá công bố nhưng không đổi được — chỉ <strong>chủ tổ chức</strong> mới
                công bố giá, vì con số này quyết định phiếu nào được tự duyệt.
              </div>
            )}

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
                              // Enter/Escape gắn ở CẢ BA ô, không chỉ ô giá: luồng tự nhiên là
                              // gõ giá → tab sang mã khách hàng → Enter, và lúc đó con trỏ
                              // không còn ở ô giá nên Enter sẽ không làm gì (đã tự cắn khi test).
                              <div className="space-y-1.5 min-w-[8rem]"
                                   onKeyDown={(e) => {
                                     if (e.key === 'Enter') { e.preventDefault(); commit(); }
                                     if (e.key === 'Escape') { e.preventDefault(); setEdit(null); }
                                   }}>
                                <Input autoFocus inputMode="numeric" placeholder="Giá mỗi kỳ"
                                       value={edit.amount}
                                       onChange={(e) => setEdit({ ...edit, amount: e.target.value })}
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
                                ) : (() => {
                                  const p = prices.byCell.get(`${b.id}:${k.key}`);
                                  return (
                                    <>
                                      {/* Giá CÔNG BỐ — con số quyết định tự duyệt. */}
                                      {p?.amount != null ? (
                                        <div className="flex items-baseline gap-1">
                                          <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                          <span className="font-semibold tabular-nums text-sm">
                                            {fmt(p.amount)}
                                          </span>
                                          {p.effectiveFrom && (
                                            <span className="text-[11px] text-muted-foreground">
                                              từ {p.effectiveFrom.slice(5)}/{p.effectiveFrom.slice(0, 4)}
                                            </span>
                                          )}
                                        </div>
                                      ) : (
                                        <div className="text-[11px] text-muted-foreground italic">
                                          chưa công bố giá
                                        </div>
                                      )}

                                      {/* Giá GỢI Ý — chỉ để điền sẵn. */}
                                      <button type="button"
                                              onClick={() => beginEdit(c)}
                                              className="group flex items-center gap-1 text-[11px] text-muted-foreground hover:underline"
                                              aria-label={`Sửa gợi ý ${k.label} của ${b.name}`}>
                                        <span className="tabular-nums">
                                          Gợi ý: {c.defaultAmount == null ? '—' : fmt(c.defaultAmount)}
                                        </span>
                                        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
                                      </button>

                                      {p?.canEdit && (
                                        <button type="button"
                                                onClick={() => setPublish({
                                                  buildingId: b.id,
                                                  buildingName: b.name,
                                                  feeCategory: k.key,
                                                  feeLabel: k.label,
                                                  amount: p.amount != null ? String(p.amount)
                                                        : (c.defaultAmount != null ? String(c.defaultAmount) : ''),
                                                  month: thisMonth(),
                                                  currentAmount: p.amount,
                                                })}
                                                className="block text-[11px] text-primary hover:underline">
                                          {p.amount == null ? 'Công bố giá' : 'Đổi giá'}
                                        </button>
                                      )}
                                    </>
                                  );
                                })()}
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
              Bấm “Gợi ý” để sửa số điền sẵn. Bỏ trống ô rồi lưu thì{' '}
              <strong>giữ nguyên số cũ</strong> — muốn bỏ hẳn thì bấm cục tẩy.
              “Tắt hạng mục” dùng cho toà không phát sinh khoản đó.
              Đổi <strong>giá công bố</strong> không làm thay đổi phiếu của các tháng trước:
              mỗi lần công bố bạn chọn “áp dụng từ tháng nào”, tháng cũ vẫn đối chiếu theo giá cũ.
            </p>
          </>
        )}

        {/* ── Công bố giá ─────────────────────────────────────────────── */}
        <Dialog open={publish !== null} onOpenChange={(o) => !o && setPublish(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {publish?.currentAmount == null ? 'Công bố giá' : 'Đổi giá công bố'}
              </DialogTitle>
              <DialogDescription>
                {publish?.feeLabel} — {publish?.buildingName}
              </DialogDescription>
            </DialogHeader>

            {publish && (
              <div className="space-y-4"
                   onKeyDown={(e) => {
                     if (e.key === 'Enter') { e.preventDefault(); commitPublish(); }
                   }}>
                <div className="space-y-1.5">
                  <Label htmlFor="sfp-amount">Mức phí mỗi tháng</Label>
                  <Input id="sfp-amount" autoFocus inputMode="numeric"
                         placeholder="Ví dụ: 1.500.000"
                         value={publish.amount}
                         onChange={(e) => setPublish({ ...publish, amount: e.target.value })} />
                  {publish.currentAmount != null && (
                    <p className="text-[11px] text-muted-foreground">
                      Đang công bố: {fmt(publish.currentAmount)}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="sfp-month">Áp dụng từ tháng</Label>
                  <Input id="sfp-month" type="month" value={publish.month}
                         onChange={(e) => setPublish({ ...publish, month: e.target.value })} />
                  <p className="text-[11px] text-muted-foreground">
                    Phiếu của các tháng <strong>trước</strong> tháng này giữ nguyên giá cũ —
                    không có gì bị tính lại.
                  </p>
                </div>

                <div className="rounded-md border bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
                  Sau khi công bố: ai đóng <strong>đúng</strong> mức này cho hạng mục và toà trên
                  thì phiếu tự duyệt và vào sổ ngay. Đóng <strong>lệch</strong> mức thì phiếu vẫn
                  tạo được nhưng nằm chờ bạn duyệt.
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="ghost" onClick={() => setPublish(null)}>Huỷ</Button>
              <Button onClick={() => commitPublish()} disabled={setPrice.isPending}>
                {setPrice.isPending ? 'Đang lưu…' : 'Công bố'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
