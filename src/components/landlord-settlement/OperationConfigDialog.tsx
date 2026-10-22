// Cài đặt một toà vận hành cho chủ nhà: tên chủ nhà, % quản lý theo thoả thuận,
// tháng bắt đầu, sổ quỹ nào là của chủ nhà, số dư đầu kỳ. Server kiểm lại mọi thứ.
// % và sổ chủ nhà theo phiên bản tháng: chọn "sửa từ tháng X" thì ô % và danh sách sổ hiện đúng
// điều khoản đang áp ở tháng X; lưu thì server chỉ ghi TRƯỜNG đã đổi cho tháng X và các mốc sau.
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
  describeOperationChange,
  landlordErrorMessage,
  monthKey,
  monthShort,
  monthToDate,
  sameIdSet,
  termsAt,
  type LandlordOperationOptions,
  type LandlordOperationsList,
} from '@/lib/landlordSettlement';
import { vnYmOf } from '@/lib/salaryPeriod';
import { formatVND } from '@/lib/utils';

type Terms = NonNullable<LandlordOperationOptions['current']>['terms'][number];

interface Draft {
  landlordName: string;
  month: string;
  /** 'YYYY-MM' — % và sổ bên dưới là điều khoản áp từ tháng này. */
  termsMonth: string;
  percent: number;
  accountIds: string[];
  /** Tháng mà % / sổ đang hiện được NẠP tự động từ đó — khác điều khoản của tháng này = người dùng đã sửa. */
  pctFrom: string;
  idsFrom: string;
  note: string;
  isActive: boolean;
  openingBalance: number;
  openingConfirmed: boolean;
}

const EMPTY: Draft = {
  landlordName: '', month: '', termsMonth: '', percent: Number.NaN, accountIds: [], pctFrom: '', idsFrom: '',
  note: '', isActive: true, openingBalance: 0, openingConfirmed: false,
};
const MAX_SO_CHU_NHA = 20;
const THANG_HOP_LE = /^\d{4}-(0[1-9]|1[0-2])$/;

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
  const cur = options.data?.current ?? null;
  const terms: readonly Terms[] = useMemo(() => cur?.terms ?? [], [cur]);

  // Nạp cấu hình hiện có (hoặc mặc định) một lần cho mỗi toà được chọn.
  useEffect(() => {
    // chờ bản MỚI về (mở lại hộp thì cache cũ trả ngay rồi mới nạp lại) — seed từ cache cũ là sai mốc
    if (!buildingId || !options.data || options.isFetching || loadedFor === buildingId) return;
    const c = options.data.current;
    if (c) {
      const thang = monthKey(c.next_terms_month);
      const dk = termsAt(c.terms, thang);
      setDraft({
        landlordName: c.landlord_name,
        month: monthKey(c.effective_from),
        termsMonth: thang,
        percent: dk?.manager_percent ?? c.manager_percent,
        accountIds: dk?.landlord_account_ids ?? c.landlord_account_ids,
        pctFrom: thang,
        idsFrom: thang,
        note: c.note ?? '',
        isActive: c.is_active,
        openingBalance: c.opening_balance,
        // xác nhận cũ hết hiệu lực (dời tháng / cọc trước kỳ đổi) ⇒ hiện chưa tick, phải đối chiếu lại
        openingConfirmed: c.opening_confirmed_at !== null && !c.opening_confirmation_stale,
      });
    } else {
      const thang = vnYmOf();
      setDraft({ ...EMPTY, month: thang, termsMonth: thang });
    }
    setLoadedFor(buildingId);
  }, [buildingId, options.data, options.isFetching, loadedFor]);

  const buildingOptions = useMemo(
    () => candidates.map((c) => ({ value: c.building_id, label: c.configured ? `${c.building_name} (đã cài)` : c.building_name })),
    [candidates],
  );
  // gợi ý: sổ nhận nhiều phiếu thu của toà nhất mà KHÔNG có phiếu của toà khác (sổ dùng chung thì không
  // phải sổ riêng của chủ nhà)
  const suggestedId = options.data?.accounts.find((a) =>
    a.income_count_120d > 0 && a.other_building_count_120d === 0 && !a.is_virtual && !a.is_deleted)?.id ?? null;
  const lastClosed = cur?.last_closed_month ? monthKey(cur.last_closed_month) : null;
  const firstClosed = cur?.first_closed_month ? monthKey(cur.first_closed_month) : null;
  const preStart = cur?.pre_start_landlord_deposits ?? 0;
  const needsConfirm = draft.openingBalance !== 0 || preStart !== 0;

  // điều khoản đang áp ở tháng đang sửa và những gì sẽ đổi khi lưu (y như server làm: từng trường)
  const base = cur && THANG_HOP_LE.test(draft.termsMonth) ? termsAt(terms, draft.termsMonth) : null;
  const pctChanged = !!base && draft.percent !== base.manager_percent;
  const idsChanged = !!base && !sameIdSet(draft.accountIds, base.landlord_account_ids);
  const laterTerms = cur ? terms.filter((t) => monthKey(t.valid_from) > draft.termsMonth) : [];
  // cơ sở của số dư đầu kỳ (tháng áp dụng + sổ của điều khoản đầu) đổi ngay trong lần lưu này ⇒ chưa thể
  // đối chiếu: cọc trước kỳ theo cơ sở mới chỉ tính ra sau khi lưu
  const basisChanging = !cur
    || draft.month !== monthKey(cur.effective_from)
    || (idsChanged && draft.termsMonth <= draft.month);

  // đổi tháng sửa ⇒ trường nào người dùng đã sửa (khác điều khoản của tháng mà nó được nạp từ đó) thì
  // giữ, trường còn lại nạp theo điều khoản đang áp ở tháng mới; khung vàng so lại với tháng mới. So với
  // tháng NẠP chứ không với tháng đang gõ: ô tháng đi qua giá trị rỗng / tháng trung gian khi gõ phím
  // không được làm mất số đã sửa. Ô tháng chưa hợp lệ thì chưa nạp gì.
  const withTermsOf = (d: Draft, m: string): Draft => {
    const moi = THANG_HOP_LE.test(m) ? termsAt(terms, m) : null;
    if (!moi) return { ...d, termsMonth: m };
    const pctGoc = termsAt(terms, d.pctFrom);
    const idsGoc = termsAt(terms, d.idsFrom);
    const daSuaPct = !!pctGoc && d.percent !== pctGoc.manager_percent;
    const daSuaIds = !!idsGoc && !sameIdSet(d.accountIds, idsGoc.landlord_account_ids);
    return {
      ...d,
      termsMonth: m,
      ...(daSuaPct ? {} : { percent: moi.manager_percent, pctFrom: m }),
      ...(daSuaIds ? {} : { accountIds: moi.landlord_account_ids, idsFrom: m }),
    };
  };
  const setTermsMonth = (m: string) => setDraft((d) => withTermsOf(d, m));
  const setMonth = (m: string) => setDraft((d) => {
    // tháng sửa đi theo tháng bắt đầu khi: chưa chốt tháng nào và đang sửa từ tháng bắt đầu, hoặc tháng
    // sửa rơi về trước tháng bắt đầu mới (tháng đó không còn trong thời gian áp dụng)
    const theo = (!lastClosed && (d.termsMonth === d.month || !cur))
      || (THANG_HOP_LE.test(m) && d.termsMonth < m);
    return theo ? { ...withTermsOf(d, m), month: m } : { ...d, month: m };
  });
  const setPercent = (v: number) => setDraft((d) => ({ ...d, percent: v }));
  const toggleAccount = (id: string, checked: boolean) =>
    setDraft((d) => ({ ...d, accountIds: checked ? [...d.accountIds, id] : d.accountIds.filter((x) => x !== id) }));
  // sổ đã có ở BẤT KỲ phiên bản điều khoản nào (server cho giữ sổ ảo / đã xoá trong tập này)
  const dangCo = useMemo(() => new Set(terms.flatMap((t) => t.landlord_account_ids)), [terms]);
  // đổi số dư đầu kỳ thì phải đối chiếu lại với chủ nhà
  const setOpening = (v: number) => setDraft((d) => ({ ...d, openingBalance: v, openingConfirmed: false }));

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!buildingId) e.building = 'Chọn toà.';
    const name = draft.landlordName.trim();
    if (!name) e.landlordName = 'Nhập tên chủ nhà.';
    else if (name.length > 120) e.landlordName = 'Tối đa 120 ký tự.';
    // ô số để trống phát ra 0 ⇒ 0% coi như chưa nhập (thoả thuận vận hành không có 0%)
    if (!Number.isFinite(draft.percent) || draft.percent <= 0 || draft.percent > 100) e.percent = 'Nhập tỷ lệ lớn hơn 0, tối đa 100.';
    else if (Math.abs(Math.round(draft.percent * 100) - draft.percent * 100) > 1e-6) e.percent = 'Tối đa 2 chữ số thập phân.';
    if (!THANG_HOP_LE.test(draft.month)) e.month = 'Chọn tháng bắt đầu áp dụng.';
    else if (firstClosed && draft.month > firstClosed) {
      e.month = `Tháng ${monthShort(firstClosed)} đã chốt — không dời tháng bắt đầu ra sau tháng đó (mở chốt trước).`;
    }
    if (draft.accountIds.length === 0) e.accounts = 'Chọn ít nhất một sổ quỹ của chủ nhà.';
    else if (new Set(draft.accountIds).size > MAX_SO_CHU_NHA) e.accounts = `Tối đa ${MAX_SO_CHU_NHA} sổ quỹ của chủ nhà.`;
    // sổ ảo / đã xoá chỉ cấm khi THÊM MỚI; sổ đã có ở một phiên bản điều khoản thì giữ được (server cũng vậy)
    const bad = options.data?.accounts.filter((a) =>
      draft.accountIds.includes(a.id) && !dangCo.has(a.id) && (a.is_virtual || a.is_deleted)) ?? [];
    if (bad.length > 0) e.accounts = `Bỏ chọn ${bad.map((a) => a.name).join(', ')} — không thêm sổ ảo hoặc sổ đã xoá làm sổ chủ nhà.`;
    if (cur && !THANG_HOP_LE.test(draft.termsMonth)) e.termsMonth = 'Chọn tháng áp tỷ lệ / sổ chủ nhà.';
    else if (cur && THANG_HOP_LE.test(draft.month) && draft.termsMonth < draft.month) {
      e.termsMonth = 'Phải từ tháng bắt đầu áp dụng trở đi.';
    } else if (cur && (pctChanged || idsChanged)) {
      if (lastClosed && draft.termsMonth <= lastClosed) {
        e.termsMonth = `Đã chốt tới tháng ${monthShort(lastClosed)} — chọn từ tháng sau đó, hoặc mở chốt trước.`;
      }
    }
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
      const r = await save.mutateAsync({
        buildingId,
        landlordName: draft.landlordName.trim(),
        managerPercent: draft.percent,
        effectiveFrom: monthToDate(draft.month),
        landlordAccountIds: draft.accountIds,
        note: draft.note.trim() || null,
        isActive: draft.isActive,
        openingBalance: draft.openingBalance,
        openingConfirmed: draft.openingConfirmed && !basisChanging,
        // LUÔN gửi tháng đang xem: server so % và sổ với đúng điều khoản màn đã hiện cho tháng đó (không gửi
        // thì server so với tháng mặc định — xem một mốc khác rồi lưu sẽ đè điều khoản các tháng chưa chốt)
        termsFrom: cur ? monthToDate(draft.termsMonth) : null,
        openingSeenPreStart: cur ? preStart : null,
      });
      // trạng thái SAU khi lưu do server tính (cọc trước kỳ theo tháng / sổ mới), không đoán theo số cũ trên màn
      if (r.opening_needs_reconfirm || r.opening_needs_confirm) {
        toast.warning('Đã lưu. Còn phải đối chiếu số dư đầu kỳ với chủ nhà (mở lại Cài đặt toà) thì mới chốt được tháng.');
      } else {
        toast.success('Đã lưu cài đặt toà vận hành');
      }
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
              <div className="space-y-1.5">
                <Label htmlFor="lo-month">Áp dụng từ tháng</Label>
                <MonthInput id="lo-month" value={draft.month} onChange={setMonth} />
                {errors.month && <p className="text-xs text-destructive">{errors.month}</p>}
              </div>

              <div className="space-y-3 rounded-md border p-3">
                {cur && (
                  <div className="space-y-1.5">
                    <Label htmlFor="lo-terms">Tỷ lệ và sổ chủ nhà áp từ tháng</Label>
                    <MonthInput id="lo-terms" value={draft.termsMonth} onChange={setTermsMonth} />
                    <p className="text-xs text-muted-foreground">
                      Ô % và sổ bên dưới là điều khoản đang áp ở tháng này. Sửa thì chỉ phần sửa áp từ tháng này trở đi;
                      các tháng trước giữ nguyên{lastClosed ? ` (đã chốt tới tháng ${monthShort(lastClosed)})` : ''}.
                    </p>
                    {errors.termsMonth && <p className="text-xs text-destructive">{errors.termsMonth}</p>}
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="lo-pct">Quản lý nhận (%)</Label>
                  <NumberInput id="lo-pct" allowDecimal min={0} max={100} value={Number.isFinite(draft.percent) ? draft.percent : null}
                    onChange={setPercent} placeholder="vd 30" />
                  {errors.percent && <p className="text-xs text-destructive">{errors.percent}</p>}
                </div>

                <div className="space-y-1.5">
                  <Label>Sổ quỹ của chủ nhà</Label>
                  <p className="text-xs text-muted-foreground">Tiền khách chuyển vào các sổ này tính là chủ nhà thu. Sổ xếp theo số phiếu thu của toà trong 120 ngày.</p>
                  <div className="max-h-52 divide-y overflow-y-auto rounded-md border">
                    {options.data.accounts.map((a) => {
                      const checked = draft.accountIds.includes(a.id);
                      // sổ ảo / sổ đã xoá: không THÊM mới được; sổ đang có sẵn thì bỏ rồi chọn lại vẫn được
                      const locked = (a.is_virtual || a.is_deleted) && !checked && !dangCo.has(a.id);
                      return (
                        <label key={a.id}
                          className={`flex items-start gap-3 px-3 py-2 text-sm ${locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted/40'}`}>
                          <Checkbox className="mt-0.5" checked={checked} disabled={locked} onCheckedChange={(v) => toggleAccount(a.id, v === true)} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              {a.name}{a.code ? <span className="text-muted-foreground"> · {a.code}</span> : null}
                            </span>
                            {(a.is_virtual || a.is_deleted || a.other_building_count_120d > 0) && (
                              <span className="block text-xs">
                                {a.is_virtual ? <span className="text-muted-foreground">sổ ảo · </span> : null}
                                {a.is_deleted ? <span className="text-destructive">đã xoá · </span> : null}
                                {a.other_building_count_120d > 0
                                  ? <span className="text-amber-700 dark:text-amber-400">dùng chung với {a.other_building_count_120d} toà khác</span>
                                  : null}
                              </span>
                            )}
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

                {cur && (pctChanged || idsChanged) && THANG_HOP_LE.test(draft.termsMonth) && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                    <p>
                      Từ tháng {monthShort(draft.termsMonth)}:
                      {pctChanged && <> % quản lý {base?.manager_percent}% → {draft.percent}%</>}
                      {pctChanged && idsChanged && ';'}
                      {idsChanged && <> sổ chủ nhà đổi ({base?.landlord_account_ids.length} → {draft.accountIds.length} sổ)</>}
                      .
                    </p>
                    {laterTerms.length > 0 && (
                      <p className="mt-1">
                        Mốc đã có sau đó cũng nhận {pctChanged && idsChanged ? 'cả % và sổ' : pctChanged ? '% mới' : 'sổ mới'}:{' '}
                        {laterTerms.map((t) => `từ ${monthShort(t.valid_from)} (đang ${t.manager_percent}%, ${t.landlord_account_ids.length} sổ)`).join('; ')}.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="lo-opening">Số dư đầu kỳ</Label>
                <p className="text-xs text-muted-foreground">
                  Khoản chủ nhà còn phải trả quản lý từ trước tháng áp dụng (âm nếu ngược lại) — vd cọc khách đã chuyển vào sổ chủ nhà mà quản lý phải hoàn.
                </p>
                <CurrencyInput id="lo-opening" allowNegative value={draft.openingBalance} onChange={setOpening} />
                {cur && !basisChanging && preStart !== 0 && (
                  <p className="text-xs">
                    Gợi ý: cọc/tiền khách trả thừa đang nằm ở sổ chủ nhà trước tháng {monthShort(cur.effective_from)} là{' '}
                    <b>{formatVND(preStart)}</b>.{' '}
                    {draft.openingBalance !== preStart && (
                      <button type="button" className="text-primary underline underline-offset-2" onClick={() => setOpening(preStart)}>
                        Dùng số này
                      </button>
                    )}
                  </p>
                )}
                {basisChanging ? (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {cur
                      ? 'Đang đổi tháng áp dụng hoặc sổ chủ nhà của tháng đầu nên cọc trước kỳ sẽ tính lại — lưu trước, rồi mở lại để đối chiếu số dư đầu kỳ.'
                      : 'Lưu cài đặt trước, rồi mở lại hộp này để xem cọc đang nằm ở sổ chủ nhà trước tháng áp dụng và đối chiếu số dư đầu kỳ.'}
                  </p>
                ) : (
                  <label className="flex cursor-pointer items-start gap-2 pt-1 text-sm">
                    <Checkbox checked={draft.openingConfirmed}
                      onCheckedChange={(v) => setDraft((d) => ({ ...d, openingConfirmed: v === true }))} />
                    <span>Đã đối chiếu số dư đầu kỳ với chủ nhà</span>
                  </label>
                )}
                {cur?.opening_confirmation_stale && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Xác nhận trước đã hết hiệu lực: lúc xác nhận cọc trước kỳ ở sổ chủ nhà là {formatVND(cur.opening_confirmed_pre_start ?? 0)},
                    nay là {formatVND(preStart)} (hoặc đã dời tháng áp dụng). Đối chiếu lại rồi đánh dấu.
                  </p>
                )}
                {needsConfirm && !basisChanging && !draft.openingConfirmed && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">Chưa xác nhận thì chưa chốt được tháng nào.</p>
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

              {cur && terms.length > 1 && (
                <div className="space-y-1 text-xs">
                  <p className="font-medium">Điều khoản theo tháng</p>
                  <ul className="space-y-0.5 text-muted-foreground">
                    {terms.map((t) => (
                      <li key={t.valid_from}>Từ {monthShort(t.valid_from)}: {t.manager_percent}% · {t.landlord_account_ids.length} sổ chủ nhà</li>
                    ))}
                  </ul>
                </div>
              )}

              {options.data.history.length > 0 && (
                <details className="rounded-md border px-3 py-2 text-xs" data-testid="landlord-config-history">
                  <summary className="cursor-pointer font-medium">Lịch sử thay đổi ({options.data.history.length})</summary>
                  <ul className="mt-2 space-y-2">
                    {options.data.history.map((h) => (
                      <li key={h.created_at} className="min-w-0">
                        <p className="text-muted-foreground">
                          {new Date(h.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}
                          {h.actor_name ? ` · ${h.actor_name}` : ''}
                        </p>
                        {describeOperationChange(h.before, h.after, formatVND).map((line) => (
                          <p key={line} className="break-words">{line}</p>
                        ))}
                      </li>
                    ))}
                  </ul>
                </details>
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
