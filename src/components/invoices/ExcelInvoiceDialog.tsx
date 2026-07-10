import { useEffect, useMemo, useState } from 'react';
import { format, addMonths, endOfMonth, startOfMonth, parse } from 'date-fns';
import { Table as TableIcon, Download, Loader2, Pencil, RotateCcw } from 'lucide-react';
import { DiscountNoteTrigger } from './DiscountNoteTrigger';
import { calcProratedDays, prorateAmount } from '@/lib/prorateCalculation';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { formatCurrency } from '@/lib/utils';
// Phase 9C: transform thuần (có characterization test) + fetch/submit tách hook.
import {
  buildExcelRows,
  computeExcelRowTotal,
  reresolveRowPricing,
  resolveBuildingDefaults,
  type ExcelRowData as RowData,
  type SubmitContext,
} from '@/lib/excelInvoiceRows';
import {
  fetchExcelInvoiceSource,
  fetchPreviousDebtForContract,
  useSubmitExcelInvoices,
} from '@/hooks/invoices/useExcelInvoiceData';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CurrencyInput } from '@/components/ui/currency-input';
import { NumberInput } from '@/components/ui/number-input';
import { DateInput } from '@/components/ui/date-input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useBuildings } from '@/hooks/useBuildings';
import { useBuildingServices } from '@/hooks/useBuildingServices';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// RowData = ExcelRowData (lib/excelInvoiceRows) — shape giữ nguyên bản cũ.

const fmt = (n: number) =>
  new Intl.NumberFormat('vi-VN').format(Math.round(n || 0));

export default function ExcelInvoiceDialog({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const { data: buildings } = useBuildings();
  const submitExcel = useSubmitExcelInvoices();

  const [buildingId, setBuildingId] = useState('');
  const [billingMonth, setBillingMonth] = useState(format(new Date(), 'yyyy-MM'));
  const [issueDate, setIssueDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [dueDate, setDueDate] = useState(format(addMonths(new Date(), 1), 'yyyy-MM-dd'));
  const [rows, setRows] = useState<RowData[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [prorateRowIdx, setProrateRowIdx] = useState<number | null>(null);

  const { data: bldSvc } = useBuildingServices(buildingId);

  // Đơn giá mặc định theo toà — logic trong lib (resolveBuildingDefaults),
  // chỉ xét dịch vụ đang BẬT, fallback hardcode khi toà chưa cấu hình.
  const defaults = useMemo(() => resolveBuildingDefaults(bldSvc), [bldSvc]);

  // Load rooms + active contracts + meters + last reading for the building.
  // Fetch nằm ở hook (fetchExcelInvoiceSource), transform ở lib (buildExcelRows).
  const handleLoad = async () => {
    if (!buildingId) return;
    setLoaded(false);
    try {
      const src = await fetchExcelInvoiceSource(buildingId);
      if (src.dupRoomNames.length > 0) {
        toast({
          variant: 'destructive',
          title: 'Phòng có nhiều hợp đồng hiệu lực',
          description: `Phòng ${src.dupRoomNames.join(', ')} đang có 2 hợp đồng hiệu lực — đã chọn HĐ mới nhất để lập hoá đơn. Vui lòng thanh lý hợp đồng cũ.`,
        });
      }
      setRows(buildExcelRows({ ...src, defaults }));
      setLoaded(true);
    } catch (err) {
      console.error(err);
      toast({
        variant: 'destructive',
        title: 'Lỗi tải dữ liệu',
        description: (err as Error)?.message || 'Không tải được danh sách phòng',
      });
    }
  };

  // Re-resolve đơn giá khi building_services load sau handleLoad. Re-resolve
  // theo từng dòng (HĐ có dịch vụ riêng giữ nguyên giá HĐ; HĐ legacy nhận giá
  // toà mới). Tôn trọng override tay của user.
  useEffect(() => {
    if (!loaded) return;
    setRows((prev) => prev.map((r) => reresolveRowPricing(r, defaults)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults.elec, defaults.water, defaults.pdv]);

  const updateRow = (idx: number, patch: Partial<RowData>) => {
    setRows((prev) => {
      const next = [...prev];
      const row = { ...next[idx], ...patch };
      // Auto-recompute electric_amount unless user manually overrode it.
      if (
        ('current_reading' in patch || 'prev_reading' in patch) &&
        !row.electric_overridden
      ) {
        const consumption = Math.max(
          0,
          (Number(row.current_reading) || 0) - (Number(row.prev_reading) || 0)
        );
        row.electric_amount = consumption * row.elec_rate;
      }
      // Auto-recompute water unless user overrode it. HĐ không đăng ký nước →
      // giữ 0.
      if ('occupants' in patch && !row.water_overridden) {
        row.water_amount = row.water_applicable
          ? (Number(row.occupants) || 0) * row.water_rate
          : 0;
      }
      next[idx] = row;
      return next;
    });
  };

  // Re-fetch nợ cũ cho 1 row (sau khi user bấm ↻), ghi đè giá trị đã chỉnh tay.
  const reloadPreviousDebt = async (idx: number) => {
    const row = rows[idx];
    if (!row) return;
    const { total, sources } = await fetchPreviousDebtForContract(row.contract_id);
    setRows((prev) => {
      const next = [...prev];
      if (!next[idx]) return prev;
      next[idx] = {
        ...next[idx],
        previous_debt: total,
        previous_debt_sources: sources,
        previous_debt_overridden: false,
      };
      return next;
    });
  };

  const computeRowTotal = computeExcelRowTotal;

  const totals = useMemo(() => {
    const sel = rows.filter((r) => r.selected);
    return {
      count: sel.length,
      total: sel.reduce((s, r) => s + computeRowTotal(r), 0),
      previousDebtSum: sel.reduce((s, r) => s + (r.previous_debt || 0), 0),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const allSelected = rows.length > 0 && rows.every((r) => r.selected);
  const toggleAll = () =>
    setRows((prev) => prev.map((r) => ({ ...r, selected: !allSelected })));

  const handleClose = () => {
    setRows([]);
    setLoaded(false);
    onOpenChange(false);
  };

  const handleSubmit = async () => {
    const selected = rows.filter((r) => r.selected);
    if (selected.length === 0) {
      toast({ variant: 'destructive', title: 'Chưa chọn phòng nào' });
      return;
    }
    setSubmitting(true);
    const periodStart = startOfMonth(parse(billingMonth + '-01', 'yyyy-MM-dd', new Date()));
    const periodEnd = endOfMonth(periodStart);
    const ctx: SubmitContext = {
      buildingId,
      billingMonth,
      issueDate,
      dueDate,
      periodStart,
      fromDate: format(periodStart, 'yyyy-MM-dd'),
      toDate: format(periodEnd, 'yyyy-MM-dd'),
    };
    // Chốt chỉ số điện + tạo hoá đơn từng phòng — orchestration ở hook, items
    // build ở lib (test chốt hành vi). Thứ tự + xử lý lỗi giữ y bản cũ.
    const { ok, fail, readingFails } = await submitExcel.submit(selected, ctx);
    setSubmitting(false);
    toast({
      title: 'Hoàn tất tạo hoá đơn',
      description: `Thành công: ${ok}${fail > 0 ? ` — Lỗi: ${fail}` : ''}`,
    });
    if (readingFails.length > 0) {
      toast({
        variant: 'destructive',
        title: 'Chưa lưu được chỉ số điện',
        description: `Đã tạo hoá đơn nhưng KHÔNG lưu được chỉ số điện cho phòng: ${readingFails.join(', ')}. Vui lòng kiểm tra lại.`,
      });
    }
    if (fail === 0) handleClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-[1400px] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TableIcon className="h-5 w-5 text-indigo-600" />
            Tạo nhanh hoá đơn — Mode Excel
          </DialogTitle>
          <DialogDescription>
            Chọn toà & kỳ → Tải dữ liệu → Nhập chỉ số cuối → Bấm "Tạo hoá đơn"
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-5 gap-3 py-2">
          <div className="space-y-1 col-span-2">
            <Label>Toà nhà *</Label>
            <Select value={buildingId} onValueChange={setBuildingId}>
              <SelectTrigger>
                <SelectValue placeholder="Chọn toà..." />
              </SelectTrigger>
              <SelectContent>
                {(buildings ?? []).map((b: any) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Kỳ thanh toán *</Label>
            <Input
              type="month"
              value={billingMonth}
              onChange={(e) => setBillingMonth(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Ngày phát hành</Label>
            <DateInput value={issueDate} onChange={setIssueDate} />
          </div>
          <div className="space-y-1">
            <Label>Hạn thanh toán</Label>
            <DateInput value={dueDate} onChange={setDueDate} />
          </div>
        </div>

        <div className="flex items-center gap-2 pb-2">
          <Button onClick={handleLoad} disabled={!buildingId}>
            <Download className="h-4 w-4 mr-2" />
            Tải dữ liệu
          </Button>
          {loaded && (
            <span className="text-sm text-muted-foreground">
              Đã tải {rows.length} phòng — đơn giá toà (mặc định): điện{' '}
              {fmt(defaults.elec)}đ/kWh, nước {fmt(defaults.water)}đ/người, PDV{' '}
              {fmt(defaults.pdv)}đ/phòng. HĐ có đăng ký dịch vụ riêng sẽ dùng giá HĐ.
            </span>
          )}
        </div>

        <div className="flex-1 overflow-auto border rounded-md">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-100 sticky top-0 z-10">
              <tr className="text-xs uppercase">
                <th className="p-2 border w-8">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                </th>
                <th className="p-2 border text-left">Phòng</th>
                <th className="p-2 border text-right">Giá Phòng</th>
                <th className="p-2 border text-right w-[70px]">Số người</th>
                <th className="p-2 border text-right w-[90px]">Chỉ số đầu</th>
                <th className="p-2 border text-right w-[100px]">Chỉ số cuối</th>
                <th className="p-2 border text-right">Tiền điện</th>
                <th className="p-2 border text-right">Nước</th>
                <th className="p-2 border text-right">Phí Dịch Vụ</th>
                <th className="p-2 border text-right">Giảm trừ</th>
                <th className="p-2 border text-right bg-red-50/60">Nợ cũ</th>
                <th className="p-2 border text-right bg-amber-50">Tổng</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={12} className="text-center p-8 text-muted-foreground">
                    {loaded ? 'Toà này không có hợp đồng đang hiệu lực.' : 'Chưa tải dữ liệu.'}
                  </td>
                </tr>
              )}
              {rows.map((r, i) => {
                const total = computeRowTotal(r);
                const rowDays = calcProratedDays(r.period_start_date, r.period_end_date);
                return (
                  <tr key={r.contract_id} className={r.selected ? '' : 'opacity-50'}>
                    <td className="p-1 border text-center">
                      <Checkbox
                        checked={r.selected}
                        onCheckedChange={(v) => updateRow(i, { selected: !!v })}
                      />
                    </td>
                    <td className="p-1 border font-medium">{r.room_name}</td>
                    <td className="p-1 border">
                      <CurrencyInput
                        className="h-7 text-right"
                        suffix={false}
                        value={r.rent_price}
                        onChange={(v) => updateRow(i, { rent_price: v })}
                      />
                    </td>
                    <td className="p-1 border">
                      <NumberInput
                        className="h-7 text-right"
                        value={r.occupants}
                        onChange={(v) => updateRow(i, { occupants: v })}
                      />
                    </td>
                    <td className="p-1 border">
                      {r.meter_id ? (
                        r.prev_reading_overridden ? (
                          <div className="relative">
                            <NumberInput
                              className="h-7 text-right pr-6"
                              allowDecimal
                              value={r.prev_reading}
                              onChange={(v) => updateRow(i, { prev_reading: v ?? 0 })}
                            />
                            <Pencil className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-amber-600 pointer-events-none" />
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1 pr-1">
                            <span className="text-slate-600 text-right tabular-nums">
                              {fmt(r.prev_reading)}
                            </span>
                            <button
                              type="button"
                              title="Sửa tay chỉ số đầu"
                              className="text-slate-400 hover:text-amber-600 p-0.5 rounded"
                              onClick={() => updateRow(i, { prev_reading_overridden: true })}
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          </div>
                        )
                      ) : (
                        <span className="text-slate-400 text-right block">—</span>
                      )}
                    </td>
                    <td className="p-1 border">
                      <NumberInput
                        className="h-7 text-right"
                        disabled={!r.meter_id}
                        allowDecimal
                        value={r.current_reading === '' ? null : r.current_reading}
                        onChange={(v) =>
                          updateRow(i, {
                            current_reading: v === 0 ? '' : v,
                          })
                        }
                      />
                    </td>
                    <td className="p-1 border">
                      <CurrencyInput
                        className="h-7 text-right"
                        suffix={false}
                        value={Math.round(r.electric_amount)}
                        onChange={(v) =>
                          updateRow(i, {
                            electric_amount: v,
                            electric_overridden: true,
                          })
                        }
                      />
                    </td>
                    <td className="p-1 border">
                      <CurrencyInput
                        className="h-7 text-right"
                        suffix={false}
                        value={Math.round(r.water_amount)}
                        onChange={(v) =>
                          updateRow(i, {
                            water_amount: v,
                            water_overridden: true,
                          })
                        }
                      />
                    </td>
                    <td className="p-1 border">
                      <CurrencyInput
                        className="h-7 text-right"
                        suffix={false}
                        value={r.pdv_amount}
                        onChange={(v) => updateRow(i, { pdv_amount: v, pdv_overridden: true })}
                      />
                    </td>
                    <td className="p-1 border">
                      <div className="relative">
                        <CurrencyInput
                          className="h-7 text-right pr-3"
                          suffix={false}
                          value={r.discount}
                          onChange={(v) => updateRow(i, { discount: v })}
                        />
                        <DiscountNoteTrigger
                          value={r.discount_notes}
                          onChange={(v) => updateRow(i, { discount_notes: v })}
                          disabled={r.discount <= 0}
                        />
                      </div>
                    </td>
                    <td className="p-1 border bg-red-50/30">
                      <HoverCard openDelay={0} closeDelay={100}>
                        <HoverCardTrigger asChild>
                          <div className="flex items-center gap-1">
                            <CurrencyInput
                              className={`h-7 text-right ${r.previous_debt > 0 ? 'text-red-600 font-medium' : ''}`}
                              suffix={false}
                              value={r.previous_debt}
                              onChange={(v) =>
                                updateRow(i, {
                                  previous_debt: v,
                                  previous_debt_overridden: true,
                                })
                              }
                            />
                            <button
                              type="button"
                              title="Tải lại nợ cũ tự động"
                              className="text-slate-400 hover:text-amber-600 p-0.5 rounded"
                              onClick={() => reloadPreviousDebt(i)}
                            >
                              <RotateCcw className="h-3 w-3" />
                            </button>
                          </div>
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80 text-xs" align="end">
                          <div className="font-semibold text-sm mb-2 text-red-700">
                            Nợ cũ phòng {r.room_name}: {formatCurrency(r.previous_debt || 0)}
                          </div>
                          {r.previous_debt_sources.length === 0 ? (
                            <p className="text-muted-foreground">
                              Không có nợ cũ (HĐ &lt; 10K được làm tròn bỏ qua).
                            </p>
                          ) : (
                            <ul className="space-y-1">
                              {r.previous_debt_sources.map((s, j) => (
                                <li key={j} className="flex justify-between gap-2 border-b border-dashed pb-1 last:border-0">
                                  <span className="truncate">
                                    {s.type === 'deposit' ? '🏠 ' : '📄 '}
                                    {s.label}
                                  </span>
                                  <span className="tabular-nums font-medium">{formatCurrency(s.amount)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {r.previous_debt_overridden && (
                            <p className="text-[10px] text-amber-700 mt-2">
                              ⚠ Đã chỉnh tay — bấm ↻ để tải lại tự động.
                            </p>
                          )}
                        </HoverCardContent>
                      </HoverCard>
                    </td>
                    <td className="p-1 border text-right font-semibold bg-amber-50">
                      <div className="flex items-center justify-end gap-1">
                        <div className="flex flex-col items-end leading-tight">
                          <span className="tabular-nums">{fmt(total)}</span>
                          {rowDays > 0 && (
                            <span className="text-[10px] font-normal text-emerald-700">
                              {rowDays}/30 ngày
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          title="Prorate theo ngày bắt đầu/kết thúc"
                          className={`p-0.5 rounded hover:bg-amber-100 ${
                            rowDays > 0
                              ? 'text-emerald-600'
                              : 'text-slate-400 hover:text-amber-700'
                          }`}
                          onClick={() => setProrateRowIdx(i)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="sticky bottom-0 bg-slate-100">
                <tr className="font-semibold">
                  <td colSpan={10} className="p-2 border text-right">
                    Tổng {totals.count} phòng đã chọn:
                  </td>
                  <td className="p-2 border text-right text-red-700 bg-red-50/40">
                    {fmt(totals.previousDebtSum)}đ
                  </td>
                  <td className="p-2 border text-right text-indigo-700 text-base">
                    {fmt(totals.total)}đ
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={handleClose}>
            Huỷ
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || totals.count === 0}
            className="bg-indigo-600 hover:bg-indigo-700"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Đang tạo...
              </>
            ) : (
              <>Tạo {totals.count} hoá đơn</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ProrateRowDialog
        row={prorateRowIdx != null ? rows[prorateRowIdx] : null}
        onClose={() => setProrateRowIdx(null)}
        onApply={(startDate, endDate) => {
          if (prorateRowIdx == null) return;
          updateRow(prorateRowIdx, {
            period_start_date: startDate,
            period_end_date: endDate,
          });
          setProrateRowIdx(null);
        }}
        onClear={() => {
          if (prorateRowIdx == null) return;
          updateRow(prorateRowIdx, {
            period_start_date: null,
            period_end_date: null,
          });
          setProrateRowIdx(null);
        }}
      />
    </Dialog>
  );
}

interface ProrateRowDialogProps {
  row: RowData | null;
  onClose: () => void;
  onApply: (startDate: string, endDate: string) => void;
  onClear: () => void;
}

function ProrateRowDialog({ row, onClose, onApply, onClear }: ProrateRowDialogProps) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  useEffect(() => {
    if (row) {
      setStart(row.period_start_date || '');
      setEnd(row.period_end_date || '');
    }
  }, [row]);

  const days = calcProratedDays(start, end);
  const open = row != null;
  const previewRent = row && days > 0 ? prorateAmount(row.rent_price, days) : row?.rent_price ?? 0;
  const previewWater = row && days > 0 ? prorateAmount(row.water_amount, days) : row?.water_amount ?? 0;
  const previewPDV = row && days > 0 ? prorateAmount(row.pdv_amount, days) : row?.pdv_amount ?? 0;
  const previewTotal =
    previewRent + (row?.electric_amount ?? 0) + previewWater + previewPDV - (row?.discount ?? 0);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Prorate phòng {row?.room_name || ''}
          </DialogTitle>
          <DialogDescription>
            Điền ngày bắt đầu và kết thúc thực tế → tiền phòng + nước + PDV sẽ chia tỉ lệ <code>/30 × số ngày</code>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Ngày bắt đầu</Label>
              <DateInput value={start} onChange={setStart} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Ngày kết thúc</Label>
              <DateInput value={end} onChange={setEnd} />
            </div>
          </div>

          {days > 0 ? (
            <div className="border rounded-md p-3 bg-emerald-50 text-sm space-y-1">
              <div className="font-medium text-emerald-800">
                {days}/30 ngày — đã prorate
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-slate-700">
                <div>Tiền phòng:</div>
                <div className="text-right tabular-nums">{fmt(previewRent)}đ</div>
                <div>Tiền điện:</div>
                <div className="text-right tabular-nums">{fmt(row?.electric_amount ?? 0)}đ <span className="text-slate-400">(không prorate)</span></div>
                <div>Nước:</div>
                <div className="text-right tabular-nums">{fmt(previewWater)}đ</div>
                <div>PDV:</div>
                <div className="text-right tabular-nums">{fmt(previewPDV)}đ</div>
                <div>Giảm trừ:</div>
                <div className="text-right tabular-nums">−{fmt(row?.discount ?? 0)}đ</div>
                <div className="font-semibold pt-1 border-t mt-1">Tổng:</div>
                <div className="text-right tabular-nums font-semibold pt-1 border-t mt-1">{fmt(previewTotal)}đ</div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Bỏ trống cả 2 ngày để không prorate (giữ giá full tháng).
            </p>
          )}
        </div>
        <DialogFooter className="gap-2">
          {(row?.period_start_date || row?.period_end_date) && (
            <Button type="button" variant="outline" onClick={onClear}>
              Xoá prorate
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            type="button"
            disabled={!start || !end || days <= 0}
            onClick={() => onApply(start, end)}
          >
            Áp dụng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
