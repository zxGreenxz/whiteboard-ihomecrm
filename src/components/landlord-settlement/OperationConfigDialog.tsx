// Cài đặt một toà vận hành cho chủ nhà: tên chủ nhà, % quản lý theo thoả thuận,
// tháng bắt đầu, và sổ quỹ nào là của chủ nhà. Server kiểm lại mọi thứ.
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CurrencyInput } from '@/components/ui/currency-input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MonthInput } from '@/components/ui/month-input';
import { NumberInput } from '@/components/ui/number-input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SkeletonBar } from '@/components/loading/LoadingState';
import { useLandlordOperationOptions, useUpsertLandlordOperation } from '@/hooks/useLandlordSettlement';
import {
  landlordErrorMessage,
  monthKey,
  monthToDate,
  type LandlordOperationsList,
} from '@/lib/landlordSettlement';
import { vnYmOf } from '@/lib/salaryPeriod';
import { formatVND } from '@/lib/utils';

interface Draft {
  landlordName: string;
  percent: number;
  month: string;
  accountIds: string[];
  note: string;
  isActive: boolean;
  openingBalance: number;
}

const EMPTY: Draft = { landlordName: '', percent: Number.NaN, month: '', accountIds: [], note: '', isActive: true, openingBalance: 0 };

export function OperationConfigDialog({
  open,
  onOpenChange,
  candidates,
  initialBuildingId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: LandlordOperationsList['candidate_buildings'];
  /** null = thêm toà mới (chọn trong hộp thoại). */
  initialBuildingId: string | null;
  onSaved?: (buildingId: string) => void;
}) {
  const [buildingId, setBuildingId] = useState<string | null>(initialBuildingId);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setBuildingId(initialBuildingId);
      setLoadedFor(null);
      setErrors({});
      setServerError(null);
    }
  }, [open, initialBuildingId]);

  const options = useLandlordOperationOptions(open ? buildingId : null);
  const save = useUpsertLandlordOperation();

  // Nạp cấu hình hiện có (hoặc mặc định) một lần cho mỗi toà được chọn.
  useEffect(() => {
    if (!buildingId || !options.data || loadedFor === buildingId) return;
    const cur = options.data.current;
    setDraft(cur
      ? {
          landlordName: cur.landlord_name,
          percent: cur.manager_percent,
          month: monthKey(cur.effective_from),
          accountIds: cur.landlord_account_ids,
          note: cur.note ?? '',
          isActive: cur.is_active,
          openingBalance: cur.opening_balance,
        }
      : { ...EMPTY, month: vnYmOf() });
    setLoadedFor(buildingId);
  }, [buildingId, options.data, loadedFor]);

  const buildingOptions = useMemo(
    () => candidates.map((c) => ({ value: c.building_id, label: c.configured ? `${c.building_name} (đã cài)` : c.building_name })),
    [candidates],
  );
  const suggestedId = options.data?.accounts.find((a) => a.income_count_120d > 0)?.id ?? null;

  const toggleAccount = (id: string, checked: boolean) =>
    setDraft((d) => ({ ...d, accountIds: checked ? [...d.accountIds, id] : d.accountIds.filter((x) => x !== id) }));

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!buildingId) e.building = 'Chọn toà.';
    const name = draft.landlordName.trim();
    if (!name) e.landlordName = 'Nhập tên chủ nhà.';
    else if (name.length > 120) e.landlordName = 'Tối đa 120 ký tự.';
    if (!Number.isFinite(draft.percent) || draft.percent < 0 || draft.percent > 100) e.percent = 'Nhập tỷ lệ từ 0 đến 100.';
    else if (Math.round(draft.percent * 100) !== draft.percent * 100) e.percent = 'Tối đa 2 chữ số thập phân.';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(draft.month)) e.month = 'Chọn tháng bắt đầu áp dụng.';
    if (draft.accountIds.length === 0) e.accounts = 'Chọn ít nhất một sổ quỹ của chủ nhà.';
    if (draft.note.trim().length > 500) e.note = 'Ghi chú tối đa 500 ký tự.';
    if (!Number.isFinite(draft.openingBalance) || !Number.isInteger(draft.openingBalance)) e.opening = 'Nhập số tiền nguyên đồng (âm nếu quản lý còn nợ chủ nhà).';
    return e;
  };

  const submit = async () => {
    const e = validate();
    setErrors(e);
    setServerError(null);
    if (Object.keys(e).length > 0 || !buildingId) return;
    try {
      await save.mutateAsync({
        buildingId,
        landlordName: draft.landlordName.trim(),
        managerPercent: draft.percent,
        effectiveFrom: monthToDate(draft.month),
        landlordAccountIds: draft.accountIds,
        note: draft.note.trim() || null,
        isActive: draft.isActive,
        openingBalance: draft.openingBalance,
      });
      toast.success('Đã lưu cài đặt toà vận hành');
      onSaved?.(buildingId);
      onOpenChange(false);
    } catch (err) {
      setServerError(landlordErrorMessage(err, 'Chưa lưu được cài đặt'));
    }
  };

  const loading = !!buildingId && (options.isLoading || loadedFor !== buildingId) && !options.isError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Cài đặt toà vận hành cho chủ nhà</DialogTitle>
          <DialogDescription>
            Quản lý nhận % lợi nhuận tháng theo thoả thuận (lỗ thì không tính). Phiếu ghi vào sổ của chủ nhà là tiền chủ nhà giữ; sổ khác là tiền quản lý giữ.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          <div className="space-y-1.5">
            <Label>Toà</Label>
            {initialBuildingId ? (
              <p className="text-sm font-medium">{candidates.find((c) => c.building_id === initialBuildingId)?.building_name ?? '—'}</p>
            ) : (
              <SearchableSelect
                value={buildingId ?? undefined}
                onValueChange={(v) => { setBuildingId(v); setLoadedFor(null); }}
                options={buildingOptions}
                placeholder="Chọn toà"
              />
            )}
            {errors.building && <p className="text-xs text-destructive">{errors.building}</p>}
          </div>

          {options.isError && (
            <p role="alert" className="text-sm text-destructive">{landlordErrorMessage(options.error, 'Chưa tải được cài đặt toà')}</p>
          )}

          {buildingId && loading && (
            <div className="space-y-2"><SkeletonBar className="h-9 w-full" /><SkeletonBar className="h-9 w-full" /><SkeletonBar className="h-24 w-full" /></div>
          )}

          {buildingId && !loading && options.data && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="lo-name">Tên chủ nhà</Label>
                <Input id="lo-name" value={draft.landlordName} maxLength={120}
                  onChange={(e) => setDraft((d) => ({ ...d, landlordName: e.target.value }))} />
                {errors.landlordName && <p className="text-xs text-destructive">{errors.landlordName}</p>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="lo-pct">Quản lý nhận (%)</Label>
                  <NumberInput id="lo-pct" allowDecimal min={0} max={100} value={Number.isFinite(draft.percent) ? draft.percent : null}
                    onChange={(v) => setDraft((d) => ({ ...d, percent: v }))} placeholder="vd 30" />
                  {errors.percent && <p className="text-xs text-destructive">{errors.percent}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lo-month">Áp dụng từ tháng</Label>
                  <MonthInput id="lo-month" value={draft.month} onChange={(m) => setDraft((d) => ({ ...d, month: m }))} />
                  {errors.month && <p className="text-xs text-destructive">{errors.month}</p>}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Sổ quỹ của chủ nhà</Label>
                <p className="text-xs text-muted-foreground">Tiền khách chuyển vào các sổ này tính là chủ nhà thu. Sổ xếp theo số phiếu thu của toà trong 120 ngày.</p>
                <div className="max-h-52 divide-y overflow-y-auto rounded-md border">
                  {options.data.accounts.map((a) => {
                    const checked = draft.accountIds.includes(a.id);
                    return (
                      <label key={a.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/40">
                        <Checkbox checked={checked} onCheckedChange={(v) => toggleAccount(a.id, v === true)} />
                        <span className="min-w-0 flex-1 truncate">
                          {a.name}{a.code ? <span className="text-muted-foreground"> · {a.code}</span> : null}
                          {a.is_virtual ? <span className="text-muted-foreground"> · sổ ảo</span> : null}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {a.income_count_120d > 0 ? `${a.income_count_120d} phiếu thu` : ''}
                          {a.id === suggestedId && !checked ? ' · gợi ý' : ''}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {errors.accounts && <p className="text-xs text-destructive">{errors.accounts}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="lo-opening">Số dư đầu kỳ</Label>
                <p className="text-xs text-muted-foreground">
                  Khoản chủ nhà còn phải trả quản lý từ trước tháng áp dụng (âm nếu ngược lại) — vd cọc khách đã chuyển vào sổ chủ nhà mà quản lý phải hoàn.
                </p>
                <CurrencyInput id="lo-opening" allowNegative value={draft.openingBalance}
                  onChange={(v) => setDraft((d) => ({ ...d, openingBalance: v }))} />
                {options.data.current && options.data.current.pre_start_landlord_deposits !== 0 && (
                  <p className="text-xs">
                    Gợi ý: cọc/tiền khách trả thừa đang nằm ở sổ chủ nhà trước tháng áp dụng là{' '}
                    <b>{formatVND(options.data.current.pre_start_landlord_deposits)}</b>.{' '}
                    <button type="button" className="text-primary underline underline-offset-2"
                      onClick={() => setDraft((d) => ({ ...d, openingBalance: options.data?.current?.pre_start_landlord_deposits ?? 0 }))}>
                      Dùng số này
                    </button>
                  </p>
                )}
                {errors.opening && <p className="text-xs text-destructive">{errors.opening}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="lo-note">Ghi chú thoả thuận</Label>
                <Textarea id="lo-note" rows={2} maxLength={500} value={draft.note}
                  onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} />
                {errors.note && <p className="text-xs text-destructive">{errors.note}</p>}
              </div>

              <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                <span>Đang áp dụng</span>
                <Switch checked={draft.isActive} onCheckedChange={(v) => setDraft((d) => ({ ...d, isActive: v }))} />
              </label>

              {options.data.current && (
                <p className="text-xs text-muted-foreground">
                  Đổi tỷ lệ hoặc sổ quỹ không đổi số của tháng đã chốt; tháng chưa chốt tính lại theo cài đặt mới.
                </p>
              )}
            </>
          )}

          {serverError && <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm text-destructive">{serverError}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Đóng</Button>
          <Button type="button" onClick={submit} disabled={save.isPending || !buildingId || loading}>
            {save.isPending ? 'Đang lưu…' : 'Lưu cài đặt'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
