// Một thẻ nháp trên trang "Báo chi nhanh": sửa được mọi ô, chỉ ghi khi bấm Lưu.
// Thẻ không tự gọi máy chủ để ghi — trang cha lo lưu; thẻ chỉ báo thay đổi (đánh dấu ô người dùng đã
// sửa để AI không đè, dựng lại tên phiếu theo nội dung) và hiện đúng trạng thái máy chủ trả về.

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Loader2, Plus, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import { useVoucherSlotWarning } from "@/hooks/useVoucherSlotWarning";
import { addDaysISO, formatISODateVN } from "@/lib/vnDate";
import { LINES_EDITED, markTouched, removeLineAt, syncName, type DraftFlag, type DraftState } from "@/lib/quickEntry/compose";
import { MAX_PAYER_NAME, validateDraft, type DraftLine, type QuickDraft } from "@/lib/quickEntry/draft";
import { modelLabel } from "@/lib/quickEntry/models";
import type { CategoryRef } from "@/lib/quickEntry/categorySuggest";
import type { IeFormBuilding, IeFormRoom } from "@/hooks/useIncomeExpenseFormScope";
import type { PickerOption } from "@/hooks/quick-entry/useQuickEntryRefs";
import { isLocked, type CardStatus } from "@/lib/quickEntry/cardStatus";
import { primaryCode } from "@/lib/quickEntry/spokenBuilding";
import { DEPOSIT_ROOM_REQUIRED_MESSAGE, depositTypeIdSet, needsDepositRoom } from "@/lib/depositRoomRule";
import type { PersonalCategoryRef } from '@/lib/quickEntry/personalRefs';
import type { Wallet } from '@/lib/personalFinance/contract';
import type { CompanyWallet } from '@/lib/companyWallet/contract';

const WHOLE_BUILDING = "__ca_toa__";
const AMOUNT_PATH = /^lines\.(\d+)\.amount$/;

const FLAG_TEXT: Record<DraftFlag, string> = {
  ai_direction_conflict: "AI tìm thấy cả Thu và Chi khác lựa chọn bạn đã chốt. Đã giữ nguyên nháp; các khoản AI bổ sung chưa được thêm. Hãy kiểm lại nội dung và thêm riêng khoản còn thiếu.",
  missing_amount: "Chưa có số tiền — nhập vào ô tiền.",
  small_amount: "Số tiền dưới 10.000đ — có phải thiếu chữ “k”?",
  ambiguous_amount: "Câu có nhiều con số — kiểm lại số tiền.",
  building_choice: "Câu nhắc nhiều toà — chọn đúng toà.",
  building_guess: "Nghe giống toà gợi ý bên dưới — bấm để chọn nếu đúng.",
  check_total: "Tổng các món khác số thực trả trên bill — đã ghi theo số thực trả, kiểm lại.",
  total_mismatch: "Tổng bạn ghi khác cộng các dòng — kiểm lại số tiền.",
  maybe_total: "Có dòng bằng đúng tổng các dòng khác — nếu đó là dòng tổng thì bỏ dòng đó.",
};

const vnd = (n: number) => `${n.toLocaleString("vi-VN")}đ`;

export interface DraftCardProps {
  inDialog?: boolean;
  state: DraftState;
  status: CardStatus;
  today: string;
  buildings: IeFormBuilding[];
  rooms: IeFormRoom[];
  categories: CategoryRef[];
  cashbooks: PickerOption[];
  personalCategories: readonly PersonalCategoryRef[];
  personalWallets?: readonly Wallet[];
  companyWallets?: readonly Pick<CompanyWallet, 'id' | 'account_id' | 'name' | 'hidden' | 'can_use'>[];
  photoUrl?: string | null;
  /** Có giá trị khi AI đã đọc thẻ này — hiện nhãn "AI đọc" để người dùng soát kỹ. */
  aiModel?: string | null;
  defaultAccountFor: (buildingId: string | null) => string | null;
  onChange: (next: DraftState) => void;
  onSave: () => void;
  onDiscard: () => void;
}

/** Cờ còn đáng nói: cờ về số tiền tắt khi người dùng đã tự sửa tiền; "chọn toà" tắt khi đã có toà. */
function visibleFlags(state: DraftState): DraftFlag[] {
  const amountTouched = state.touched.some((p) => AMOUNT_PATH.test(p));
  const out: DraftFlag[] = [];
  if (state.draft.lines.some((l) => !(l.amount > 0))) out.push("missing_amount");
  for (const f of state.flags) {
    if (f === "missing_amount") continue;
    if (
      (f === "small_amount" || f === "ambiguous_amount" || f === "check_total" || f === "total_mismatch" || f === "maybe_total") &&
      amountTouched
    ) {
      continue;
    }
    if ((f === "building_choice" || f === "building_guess") && state.draft.buildingId) continue;
    out.push(f);
  }
  return out;
}

/**
 * Lời nhắc còn thiếu gì (gộp câu trùng). Không nhắc lại thứ đã có lời riêng: dòng chưa có tiền (cờ
 * "Chưa có số tiền") và sổ quỹ khi người dùng không được giao sổ nào (bảo "chọn sổ" là sai — không
 * có gì để chọn).
 */
function issueTexts(d: QuickDraft, noCashbook: boolean): string[] {
  const v = validateDraft(d);
  if (!("issues" in v)) return [];
  const texts = Object.entries(v.issues)
    .filter(([path]) => {
      if (path === "accountId" && noCashbook) return false;
      const m = AMOUNT_PATH.exec(path);
      return !m || (d.lines[Number(m[1])]?.amount ?? 0) > 0;
    })
    .map(([, text]) => text);
  return [...new Set(texts)];
}

const NO_CASHBOOK =
  "Bạn chưa được giao sổ quỹ nào để chi, nên chưa lưu được phiếu chi ở đây. Nhờ chủ sổ hoặc chủ công ty giao sổ cho bạn.";

/** "102LVT — Toà 102 Lê Văn Thọ"; tên trùng mã thì chỉ hiện một lần. */
function buildingLabel(b: IeFormBuilding): string {
  if (!b.code || b.code.trim().toLowerCase() === b.name.trim().toLowerCase()) return b.name;
  return `${b.code} — ${b.name}`;
}

function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function DraftCard(props: DraftCardProps) {
  const { state, status, today } = props;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const d = state.draft;
  const company = d.mode === "company";
  const locked = isLocked(status);
  // Cọc không có phòng thì không HĐ nào nhận (depositRoomRule.ts) ⇒ chặn lưu ngay trên thẻ.
  const hasDepositLine = company && needsDepositRoom(d.lines.map((l) => l.categoryId), null, depositTypeIdSet(props.categories));
  const depositNeedsRoom = hasDepositLine && !d.roomId;
  const canSave = validateDraft(d).ok && !depositNeedsRoom;
  const noCashbook = company && props.cashbooks.length === 0;
  const issues = issueTexts(d, noCashbook);
  const total = d.lines.reduce((s, l) => s + (l.amount > 0 ? l.amount : 0), 0);

  const emit = (draft: QuickDraft, path: string) =>
    props.onChange(syncName(markTouched({ ...state, draft }, path)));
  const update = (path: string, next: Partial<QuickDraft>) => emit({ ...d, ...next }, path);
  const updateLine = <K extends keyof DraftLine>(i: number, key: K, value: DraftLine[K]) =>
    emit({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, [key]: value } : l)) }, `lines.${i}.${String(key)}`);
  const addLine = () =>
    emit(
      {
        ...d,
        lines: [...d.lines, { transactionType:d.transactionType??'EXPENSE',personalCategoryId:null,description: "", amount: 0, categoryId: null, personalCategory: null, periodStart: null, periodEnd: null }],
      },
      // Đổi số dòng ⇒ câu gốc AI đọc không còn khớp các dòng; AI không ghép vào thẻ nữa.
      LINES_EDITED,
    );
  const removeLine = (i: number) => props.onChange(syncName(removeLineAt(state, i)));
  const clearPeriod = (i: number) =>
    emit({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, periodStart: null, periodEnd: null } : l)) }, `lines.${i}.period`);
  const chooseBuilding = (buildingId: string) => {
    const keepAccount = state.touched.includes("accountId") || d.entrySource === 'personal_wallet';
    emit(
      { ...d, buildingId, roomId: null, accountId: keepAccount ? d.accountId : props.defaultAccountFor(buildingId) },
      "buildingId",
    );
  };

  const starts = d.lines.map((l) => l.periodStart ?? d.date).sort();
  const ends = d.lines.map((l) => l.periodEnd ?? d.date).sort();
  const slot = useVoucherSlotWarning({
    buildingId: d.buildingId,
    typeIds: d.lines.map((l) => l.categoryId ?? ""),
    start: starts[0] ?? d.date,
    end: ends[ends.length - 1] ?? d.date,
    type: d.transactionType??"EXPENSE",
    enabled: company && status.kind === "draft",
  });
  const slotHits = company && status.kind === "draft" ? slot.data ?? [] : [];

  const buildingOptions: SearchableSelectOption[] = props.buildings.map((b) => ({
    value: b.id,
    label: buildingLabel(b),
    keywords: [b.code ?? "", b.name],
  }));
  const roomOptions: SearchableSelectOption[] = [
    { value: WHOLE_BUILDING, label: "Cả toà (không gắn phòng)" },
    ...props.rooms.filter((r) => r.building_id === d.buildingId).map((r) => ({ value: r.id, label: r.name })),
  ];
  const categoryOptions: SearchableSelectOption[] = props.categories.filter(c=>c.type===(d.transactionType??'EXPENSE').toLowerCase()).map((c) => ({
    value: c.id,
    label: c.name,
    group: c.category ?? "Khác",
    keywords: [c.name, c.category ?? ""],
  }));
  const cashbookOptions: SearchableSelectOption[] = props.cashbooks.map((c) => ({ value: c.id, label: c.label }));
  const personalOptions=(selected:string|null|undefined):SearchableSelectOption[]=>props.personalCategories.filter(c=>c.type===(d.transactionType??'EXPENSE')&&(!c.hidden||c.id===selected)).map(c=>({value:c.id,label:c.name}));
  const walletOptions=(props.personalWallets??[]).map(w=>({value:w.id,label:w.name}));
  const reviewHref = company ? "/income-expense" : "/finance/personal-wallet";

  return (
    <article
      className="space-y-3 rounded-xl border bg-card p-3 shadow-sm"
      data-testid="draft-card"
      data-mode={d.mode}
      data-status={status.kind}
      aria-busy={status.kind === "saving" || status.kind === "reading"}
    >
      <header className="flex items-center gap-2 text-xs">
        <span className="rounded-full bg-muted px-2 py-0.5 font-medium">{company ? "Công ty" : "Cá nhân"}</span>
        {props.aiModel && (
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-violet-700">
            <Sparkles className="h-3 w-3" /> AI đọc · {modelLabel(props.aiModel)} — soát lại
          </span>
        )}
        <span className="ml-auto text-sm font-semibold tabular-nums" data-testid="draft-total">
          {vnd(total)}
        </span>
      </header>

      {status.kind === "reading" ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> AI đang đọc…
        </p>
      ) : (
        <fieldset disabled={locked} className="min-w-0 space-y-2">
          <div className="flex gap-2" role="group" aria-label="Loại giao dịch">
            {(['INCOME','EXPENSE'] as const).map(type=><Button key={type} type="button" variant={(d.transactionType??'EXPENSE')===type?'default':'outline'} aria-pressed={(d.transactionType??'EXPENSE')===type} onClick={()=>update('transactionType',{transactionType:type,lines:d.lines.map(l=>({...l,transactionType:type,categoryId:null,personalCategoryId:null,personalCategory:null}))})}>{type==='INCOME'?'Thu':'Chi'}</Button>)}
          </div>
          {!company&&<Field label="Ví cá nhân"><SearchableSelect modal={props.inDialog} contentClassName={props.inDialog ? "z-[70]" : undefined} aria-label="Ví cá nhân" value={d.personalWalletId??undefined} options={walletOptions} placeholder="Chọn ví" onValueChange={value=>update('personalWalletId',{personalWalletId:value})}/></Field>}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="Ngày giao dịch">
              {props.inDialog ? <input type="date" className="h-11 w-full rounded-md border bg-background px-3" value={d.date} aria-label="Ngày chi" onChange={e=>update("date",{date:e.target.value})}/> : <DateInput value={d.date} aria-label="Ngày chi" onChange={(iso) => update("date", { date: iso })} />}
              <span className="mt-1 flex gap-1">
                <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => update("date", { date: today })}>
                  Hôm nay
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => update("date", { date: addDaysISO(today, -1) ?? today })}
                >
                  Hôm qua
                </Button>
              </span>
            </Field>
            {company && (
              <Field label="Người nhận / cửa hàng">
                <Input
                  value={d.vendor ?? ""}
                  placeholder="Không bắt buộc"
                  aria-label="Người nhận"
                  maxLength={MAX_PAYER_NAME}
                  onChange={(e) => update("vendor", { vendor: e.target.value || null })}
                />
              </Field>
            )}
          </div>

          {company && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Field label="Toà">
                <SearchableSelect modal={props.inDialog} contentClassName={props.inDialog ? "z-[70]" : undefined}
                  value={d.buildingId ?? undefined}
                  onValueChange={chooseBuilding}
                  options={buildingOptions}
                  placeholder="Chọn toà"
                  searchPlaceholder="Tìm toà…"
                  aria-label="Toà"
                />
                {!d.buildingId && state.buildingCandidates.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {state.buildingCandidates.map((id) => {
                      const b = props.buildings.find((x) => x.id === id);
                      return (
                        <Button key={id} type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => chooseBuilding(id)}>
                          {b ? primaryCode(b) || "Toà" : "Toà"}
                        </Button>
                      );
                    })}
                  </span>
                )}
              </Field>
              <Field label={hasDepositLine ? "Phòng *" : "Phòng"}>
                <SearchableSelect modal={props.inDialog} contentClassName={props.inDialog ? "z-[70]" : undefined}
                  value={d.roomId ?? WHOLE_BUILDING}
                  onValueChange={(v) => update("roomId", { roomId: v === WHOLE_BUILDING ? null : v })}
                  options={roomOptions}
                  disabled={!d.buildingId}
                  searchPlaceholder="Tìm phòng…"
                  aria-label="Phòng"
                  aria-invalid={depositNeedsRoom || undefined}
                />
              </Field>
              <Field label={d.entrySource === 'personal_wallet' ? 'Ví Công ty' : 'Sổ quỹ chi tiền'}>
                <SearchableSelect modal={props.inDialog} contentClassName={props.inDialog ? "z-[70]" : undefined}
                  value={d.accountId ?? undefined}
                  onValueChange={(v) => update("accountId", { accountId: v, ...(d.entrySource === 'personal_wallet' ? {companyWalletId:props.companyWallets?.find(w => w.account_id === v)?.id ?? null} : {}) })}
                  options={cashbookOptions}
                  placeholder={d.entrySource === 'personal_wallet' ? 'Chọn ví Công ty đã cài đặt' : cashbookOptions.length ? "Chọn sổ" : "Bạn chưa giữ sổ nào"}
                  aria-label={d.entrySource === 'personal_wallet' ? 'Ví Công ty' : 'Sổ quỹ'}
                />
              </Field>
            </div>
          )}

          <ul className="space-y-2">
            {d.lines.map((l, i) => (
              <li key={i} className="space-y-2 rounded-lg border p-2" data-testid="draft-line">
                <div className="flex items-start gap-2">
                  <Input
                    className="min-w-0 flex-1"
                    value={l.description}
                    placeholder="Mô tả"
                    aria-label={`Mô tả dòng ${i + 1}`}
                    onChange={(e) => updateLine(i, "description", e.target.value)}
                  />
                  <div className="w-36 shrink-0">
                    <CurrencyInput
                      className="text-right font-semibold"
                      value={l.amount > 0 ? l.amount : null}
                      aria-label={`Số tiền dòng ${i + 1}`}
                      onChange={(n) => updateLine(i, "amount", Number.isFinite(n) ? n : 0)}
                    />
                  </div>
                  {d.lines.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" aria-label={`Bỏ dòng ${i + 1}`} onClick={() => removeLine(i)}>
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {company ? (
                    <SearchableSelect modal={props.inDialog} contentClassName={props.inDialog ? "z-[70]" : undefined}
                      className="min-w-[12rem] flex-1"
                      value={l.categoryId ?? undefined}
                      onValueChange={(v) => updateLine(i, "categoryId", v)}
                      options={categoryOptions}
                      placeholder="Chọn hạng mục"
                      searchPlaceholder="Tìm hạng mục…"
                      aria-label={`Hạng mục dòng ${i + 1}`}
                    />
                  ) : (
                    <SearchableSelect modal={props.inDialog} contentClassName={props.inDialog ? "z-[70]" : undefined}
                      className="min-w-[10rem] flex-1"
                      value={l.personalCategoryId ?? undefined}
                      onValueChange={(v) => updateLine(i, "personalCategoryId", v)}
                      options={personalOptions(l.personalCategoryId)}
                      placeholder="Chọn danh mục"
                      searchable={false}
                      aria-label={`Danh mục dòng ${i + 1}`}
                    />
                  )}
                  {company && l.periodStart && l.periodEnd && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                      Kỳ {formatISODateVN(l.periodStart)} – {formatISODateVN(l.periodEnd)}
                      <button type="button" aria-label={`Bỏ kỳ dòng ${i + 1}`} onClick={() => clearPeriod(i)}>
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <Button type="button" variant="ghost" size="sm" onClick={addLine}>
            <Plus className="mr-1 h-4 w-4" /> Thêm dòng
          </Button>
        </fieldset>
      )}

      {props.photoUrl && (
        <figure className="flex items-center gap-2 text-xs text-muted-foreground">
          <img src={props.photoUrl} alt="Ảnh bill" className="h-16 w-16 rounded object-cover" />
          <figcaption>{company ? "Ảnh sẽ lưu làm chứng từ của phiếu." : "Ảnh chỉ để AI đọc — không lưu."}</figcaption>
        </figure>
      )}

      {(status.kind === "draft" || status.kind === "rejected") && (
        <>
          {visibleFlags(state).map((f) => (
            <p key={f} className="flex items-start gap-1 text-xs text-amber-700">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {FLAG_TEXT[f]}
            </p>
          ))}
          {slotHits.length > 0 && (
            <p className="flex items-start gap-1 text-xs text-amber-700" data-testid="slot-warning">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              Kỳ này toà đã có phiếu cùng hạng mục: {slotHits.map((h) => `${h.code} (${vnd(h.totalAmount)})`).join(", ")}. Kiểm tra để không
              chi trùng.
            </p>
          )}
          {noCashbook && (
            <p className="flex items-start gap-1 text-xs text-amber-700" data-testid="no-cashbook">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {d.entrySource === 'personal_wallet' ? 'Chưa có ví Công ty dùng được. Mở Quản lý ví → Công ty để gắn sổ quỹ bạn được phép sử dụng.' : NO_CASHBOOK}
            </p>
          )}
          {status.kind === "rejected" && status.message && (
            <p className="text-xs text-destructive" role="alert">
              {status.message}
            </p>
          )}
          {depositNeedsRoom && (
            <p className="text-xs text-destructive" role="alert">
              {DEPOSIT_ROOM_REQUIRED_MESSAGE}
            </p>
          )}
          {issues.length > 0 && <p className="text-xs text-muted-foreground">{issues.slice(0, 3).join(" ")}</p>}
          <footer className="flex gap-2">
            <Button type="button" className="flex-1" disabled={!canSave} onClick={props.onSave}>
              {company ? (d.transactionType==='INCOME'?'Lưu phiếu thu':"Lưu phiếu chi") : "Lưu vào ví"}
            </Button>
            <Button type="button" variant="outline" aria-label="Bỏ thẻ" onClick={props.onDiscard}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </footer>
        </>
      )}

      {status.kind === "saving" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Đang lưu…
        </p>
      )}

      {status.kind === "saved" && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-emerald-700" data-testid="saved-receipt">
          <CheckCircle2 className="h-4 w-4" />
          {company
            ? `Đã lưu ${status.code ?? "phiếu"} · ${status.approvalStatus === "APPROVED" ? "Đã duyệt" : "Chờ duyệt"}`
            : "Đã ghi vào Ví cá nhân"}
          <Link className="ml-auto underline" to={reviewHref}>
            {company ? "Xem trong Thu chi" : "Xem ví"}
          </Link>
        </p>
      )}

      {(status.kind === "unknown" || status.kind === "maybe_saved") && (
        <div className="space-y-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900" role="alert">
          <p>{status.message}</p>
          <div className="flex flex-wrap gap-2">
            {status.kind === "unknown" && (
              <Button type="button" size="sm" onClick={props.onSave}>
                <RotateCcw className="mr-1 h-3 w-3" /> Gửi lại y nguyên
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" asChild>
              <Link to={reviewHref}>{company ? "Kiểm tra trong Thu chi" : "Xem ví cá nhân"}</Link>
            </Button>
            {/* Bỏ thẻ chỉ gỡ thẻ khỏi màn này, không đụng phiếu/khoản đã ghi — thẻ chưa rõ mà bị từ
                chối lặp lại (vd ví đã ghi một phần) không phải nằm kẹt suốt 48 giờ. Thẻ CHƯA RÕ phải xác
                nhận lần hai: bỏ rồi gõ lại là khoá chống trùng mới ⇒ phiếu đôi nếu lần đầu đã lưu. */}
            {status.kind === "unknown" && !confirmDiscard ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDiscard(true)}>
                Bỏ thẻ
              </Button>
            ) : status.kind === "unknown" ? null : (
              <Button type="button" size="sm" variant="ghost" onClick={props.onDiscard}>
                Bỏ thẻ
              </Button>
            )}
          </div>
          {status.kind === "unknown" && confirmDiscard && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="flex-1">
                Thẻ này có thể đã được lưu. {company ? "Kiểm tra trong Thu chi" : "Xem Ví cá nhân"} trước khi lập lại.
              </p>
              <Button type="button" size="sm" variant="destructive" onClick={props.onDiscard}>
                Bỏ hẳn
              </Button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
