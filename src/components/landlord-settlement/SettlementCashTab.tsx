// Tab "Thu chi" của Quyết toán vận hành v3: ô 2×2 "Ai thu, ai chi trong tháng" (bấm để lọc theo sổ),
// thẻ Khoản thu / Khoản chi (tổng server, theo hạng mục, từng phiếu) và khối "Khoản khác" (thanh lý, cọc,
// chờ duyệt, không tính). Mọi tổng là số server trả; tỷ trọng hạng mục chỉ chia để hiển thị.
import { useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { cn, formatVND } from '@/lib/utils';
import {
  barPercent,
  initialsOf,
  settlementVoucherName,
  shareText,
  voucherRowNote,
  type SettlementCategory,
  type SettlementStatement,
  type SettlementVoucher,
} from '@/lib/landlordSettlement';
import { Eyebrow, SectionCard } from './SettlementParts';
import { VoucherBreakdown, type GroupKey } from './VoucherBreakdown';

type Side = SettlementVoucher['side'];
type Filter = 'ALL' | Side;
type Kind = 'INCOME' | 'EXPENSE';

const OTHER_GROUPS: readonly GroupKey[] = ['termination', 'deposit', 'pending', 'excluded'];

const INCOME_COLORS = ['bg-emerald-700', 'bg-emerald-500', 'bg-emerald-300', 'bg-emerald-200', 'bg-teal-200', 'bg-emerald-100', 'bg-teal-100', 'bg-slate-200'];
const EXPENSE_COLORS = ['bg-orange-700', 'bg-orange-600', 'bg-orange-500', 'bg-orange-400', 'bg-orange-300', 'bg-orange-200', 'bg-orange-100', 'bg-amber-100'];
const colorAt = (list: readonly string[], i: number) => list[Math.min(i, list.length - 1)];

const fmtDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

const SIDE_LABEL: Record<Side, string> = { LANDLORD: 'Sổ chủ nhà', MANAGER: 'Sổ quản lý' };
const GROUP_OF: Record<Kind, Record<Side, GroupKey>> = {
  INCOME: { LANDLORD: 'landlord_in', MANAGER: 'manager_in' },
  EXPENSE: { LANDLORD: 'landlord_out', MANAGER: 'manager_out' },
};

/** Tổng server cho ô / thẻ đang xem (không cộng ở client). */
function serverTotal(t: SettlementStatement['totals'], kind: Kind, filter: Filter): number {
  if (kind === 'INCOME') return filter === 'ALL' ? t.revenue : filter === 'LANDLORD' ? t.landlord_collected : t.manager_collected;
  return filter === 'ALL' ? t.expense : filter === 'LANDLORD' ? t.landlord_paid : t.manager_paid;
}

const amountOf = (c: SettlementCategory, filter: Filter) =>
  (filter === 'ALL' ? c.amount : filter === 'LANDLORD' ? c.landlord_amount : c.manager_amount);

function SideBadge({ side }: { side: Side }) {
  return (
    <span className={cn('ml-1 whitespace-nowrap rounded px-1.5 py-px text-[10.5px] font-bold',
      side === 'LANDLORD' ? 'bg-muted text-foreground/75' : 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300')}>
      {SIDE_LABEL[side]}
    </span>
  );
}

function CellButton({ label, count, amount, sub, kind, selected, onClick }: {
  label: string; count: number; amount: number; sub: string | null; kind: Kind; selected: boolean; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      className={cn(
        'min-w-0 rounded-[10px] border border-l-4 bg-card px-3 py-2 text-left transition-colors hover:bg-muted/40',
        kind === 'INCOME' ? 'border-l-emerald-600' : 'border-l-orange-600',
        selected && 'ring-2 ring-primary',
      )}>
      <span className="flex items-baseline justify-between gap-1.5">
        <span className="text-xs font-semibold text-foreground/75">{label}</span>
        <span className="whitespace-nowrap text-[11px] text-muted-foreground">{count} khoản</span>
      </span>
      <span className={cn('mt-0.5 block truncate text-[17px] font-extrabold tabular-nums',
        amount === 0 ? 'text-muted-foreground' : kind === 'INCOME' ? 'text-emerald-700 dark:text-emerald-400' : 'text-orange-700 dark:text-orange-400')}>
        {formatVND(amount)}
      </span>
      {sub && <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{sub}</span>}
    </button>
  );
}

/**
 * "Theo hạng mục" — mặc định THU GỌN (chủ nhắn 24/10/2026: thu và chi khác số hạng mục làm hai cột lệch nhau):
 * gọn chỉ còn dòng tiêu đề + thanh tỷ trọng, cao bằng nhau ở hai thẻ; bấm ở thẻ nào cũng mở CẢ HAI (trạng
 * thái dùng chung ở tab). Thẻ không có hạng mục vẫn giữ dòng tiêu đề để hai cột không lệch.
 */
function CategoryBlock({ cats, total, filter, kind, open, onToggle }: {
  cats: readonly SettlementCategory[]; total: number; filter: Filter; kind: Kind; open: boolean; onToggle: () => void;
}) {
  const colors = kind === 'INCOME' ? INCOME_COLORS : EXPENSE_COLORS;
  const shown = cats
    .map((c) => ({ name: c.name, amount: amountOf(c, filter) }))
    .filter((c) => c.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
  const listId = `settlement-categories-list-${kind === 'INCOME' ? 'income' : 'expense'}`;
  return (
    <div className="border-b px-3.5 pb-3 pt-2" data-testid={`settlement-categories-${kind === 'INCOME' ? 'income' : 'expense'}`}>
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={listId}
          disabled={shown.length === 0}
          className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent">
          <span className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
            Theo hạng mục{shown.length > 0 ? ` (${shown.length})` : ' · không có'}
          </span>
          {shown.length > 0 && (
            <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
          )}
        </button>
        {open && shown.length > 0 && <Eyebrow>Tỷ trọng</Eyebrow>}
      </div>
      <div className="mt-1.5 flex h-2 overflow-hidden rounded bg-muted" aria-hidden>
        {/* server gom theo tên + cờ hạn chế ⇒ hai dòng có thể cùng tên: key kèm thứ tự */}
        {shown.map((c, i) => <div key={`${c.name}-${i}`} className={cn('h-full', colorAt(colors, i))} style={{ width: `${barPercent(c.amount, total)}%` }} />)}
      </div>
      {open && shown.length > 0 && (
        <ul id={listId} className="mt-2.5 flex flex-col gap-1.5">
          {shown.map((c, i) => (
            <li key={`${c.name}-${i}`} className="grid grid-cols-[10px_minmax(0,1fr)_auto_44px] items-center gap-2 text-[12.5px]">
              <span className={cn('h-2.5 w-2.5 rounded-[3px]', colorAt(colors, i))} aria-hidden />
              <span className="truncate text-foreground/75">{c.name}</span>
              <span className="whitespace-nowrap font-bold tabular-nums">{formatVND(c.amount)}</span>
              <span className="text-right text-[11.5px] tabular-nums text-muted-foreground">{shareText(c.amount, total) ?? ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function VoucherRow({ v, mode, periodMonth }: { v: SettlementVoucher; mode: 'admin' | 'public'; periodMonth: string }) {
  const name = settlementVoucherName(v, mode);
  const lines = v.lines ?? [];
  // Khoản chi: ô đầu dòng là BÊN CHI (chủ nhắn 24/10/2026) — CN = chủ nhà chi, QL = quản lý (vận hành) chi.
  // Khoản thu: tên phòng (không có phòng thì chữ viết tắt hạng mục).
  const tile = v.type === 'EXPENSE'
    ? (v.side === 'LANDLORD' ? 'CN' : 'QL')
    : v.room_name || initialsOf(lines[0]?.category);
  const tileTitle = v.type === 'EXPENSE' ? (v.side === 'LANDLORD' ? 'Chủ nhà chi' : 'Quản lý (vận hành) chi') : tile;
  const note = voucherRowNote(v, GROUP_OF[v.type][v.side], mode, periodMonth).replace(/^ · /, '');
  const income = v.type === 'INCOME';
  return (
    <li className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-px border-t px-3.5 py-2 hover:bg-muted/30"
      data-testid="settlement-cash-row">
      {/* tên phòng thật dài ("MADRID 4", "LONDON 5") ⇒ xuống tối đa 2 dòng, không cắt chữ */}
      <span title={tileTitle} data-testid="settlement-row-tile"
        className={cn('row-span-2 flex h-9 w-[54px] items-center justify-center self-start overflow-hidden rounded-lg border px-0.5 text-[10px] font-bold leading-[1.15]',
          v.side === 'LANDLORD'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
            : 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-300')}>
        <span className="line-clamp-2 text-center">{tile}</span>
      </span>
      <span className="min-w-0 truncate text-[13px] font-semibold" title={mode === 'admin' ? (v.name ?? '') : name} data-testid="settlement-voucher-name">
        {name}
      </span>
      <span className={cn('whitespace-nowrap text-right text-[13.5px] font-bold tabular-nums',
        income ? 'text-emerald-700 dark:text-emerald-400' : 'text-orange-700 dark:text-orange-400')}>
        {formatVND(v.amount)}
      </span>
      <div className="col-span-2 col-start-2 min-w-0">
        <p className="text-[11.5px] text-muted-foreground">
          {lines.length === 1 ? `${lines[0].category} · ` : ''}{fmtDay(v.voucher_date)}{v.code ? ` · ${v.code}` : ''}
          <SideBadge side={v.side} />
        </p>
        {lines.length > 1 && (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground" data-testid="settlement-voucher-lines">
            {lines.map((l) => `${l.category} ${formatVND(l.amount)}`).join(' · ')}
          </p>
        )}
        {note && <p className="mt-0.5 text-[11px] font-semibold text-blue-700 dark:text-blue-300">{note}</p>}
      </div>
    </li>
  );
}

function ListCard({ kind, st, filter, mode, catsOpen, onToggleCats }: {
  kind: Kind; st: SettlementStatement; filter: Filter; mode: 'admin' | 'public'; catsOpen: boolean; onToggleCats: () => void;
}) {
  const t = st.totals;
  const income = kind === 'INCOME';
  const rows = st.vouchers.filter((v) => v.status === 'APPROVED' && v.group === 'PNL' && v.type === kind
    && (filter === 'ALL' || v.side === filter));
  const total = serverTotal(t, kind, filter);
  const cats = st.categories ? (income ? st.categories.income : st.categories.expense) : null;
  const sideText = filter === 'LANDLORD' ? ' ở sổ chủ nhà' : filter === 'MANAGER' ? ' ở sổ quản lý' : '';
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card" data-testid={income ? 'settlement-income-card' : 'settlement-expense-card'}>
      <div className={cn('flex items-center gap-2 border-b px-3.5 py-2.5',
        income ? 'bg-emerald-50/70 dark:bg-emerald-950/30' : 'bg-orange-50/60 dark:bg-orange-950/20')}>
        <h3 className="text-[13.5px] font-bold">{income ? 'Khoản thu' : 'Khoản chi'}</h3>
        <span className={cn('whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold',
          income ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200' : 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-200')}>
          {rows.length} khoản
        </span>
        <span className={cn('ml-auto whitespace-nowrap text-[15px] font-extrabold tabular-nums',
          income ? 'text-emerald-700 dark:text-emerald-400' : 'text-orange-600 dark:text-orange-400')} data-testid="settlement-list-total">
          {formatVND(total)}
        </span>
      </div>
      {cats && <CategoryBlock cats={cats} total={total} filter={filter} kind={kind} open={catsOpen} onToggle={onToggleCats} />}
      {rows.length === 0 ? (
        <p className="px-4 py-7 text-center text-[12.5px] text-muted-foreground">Không có khoản {income ? 'thu' : 'chi'} nào{sideText} trong tháng.</p>
      ) : (
        <>
          <div className="grid grid-cols-[56px_1fr_auto] gap-2.5 px-3.5 py-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
            <span>{income ? 'Phòng' : 'Bên chi'}</span><span>Mô tả</span><span className="text-right">Số tiền</span>
          </div>
          <ul>{rows.map((v, i) => <VoucherRow key={`${v.code ?? 'phieu'}-${i}`} v={v} mode={mode} periodMonth={st.period_month} />)}</ul>
        </>
      )}
      <div className="mt-auto flex flex-wrap justify-between gap-x-3 gap-y-1 border-t bg-muted/30 px-3.5 py-2 text-[11.5px] text-muted-foreground">
        <span>{income ? 'Vào sổ chủ nhà' : 'Chi từ sổ chủ nhà'}{' '}
          <b className="tabular-nums text-foreground">{formatVND(income ? t.landlord_collected : t.landlord_paid)}</b>
        </span>
        <span>{income ? 'Vào sổ quản lý' : 'Chi từ sổ quản lý'}{' '}
          <b className="tabular-nums text-blue-700 dark:text-blue-300">{formatVND(income ? t.manager_collected : t.manager_paid)}</b>
        </span>
      </div>
    </section>
  );
}

/** Tên hạng mục có tiền ở bên sổ đó (tối đa 3); không có gói hạng mục thì null. */
function categoryNames(cats: readonly SettlementCategory[] | null | undefined, side: Side): string | null {
  if (!cats) return null;
  const names = cats.filter((c) => (side === 'LANDLORD' ? c.landlord_amount : c.manager_amount) !== 0).map((c) => c.name);
  if (names.length === 0) return null;
  return names.length > 3 ? `${names.slice(0, 3).join(', ')}…` : names.join(', ');
}

/** Mô tả dưới số của một ô 2×2. */
function cellSub(st: SettlementStatement, kind: Kind, side: Side, count: number): string | null {
  const who = side === 'LANDLORD' ? 'chủ nhà' : 'quản lý';
  if (count === 0) return `Tháng này ${who} không ${kind === 'INCOME' ? 'nhận' : 'chi'} khoản nào`;
  const names = categoryNames(kind === 'INCOME' ? st.categories?.income : st.categories?.expense, side);
  const prefix = side === 'MANAGER' ? (kind === 'INCOME' ? 'Thu hộ chủ nhà' : 'Chi hộ chủ nhà') : null;
  return [prefix, names].filter(Boolean).join(' — ') || null;
}

export function SettlementCashTab({ st, mode, narrow }: { st: SettlementStatement; mode: 'admin' | 'public'; narrow: boolean }) {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [list, setList] = useState<Kind>('INCOME');
  // "Theo hạng mục" của HAI thẻ mở / đóng cùng nhau (mặc định đóng — hai cột thẳng hàng)
  const [catsOpen, setCatsOpen] = useState(false);
  const toggleCats = () => setCatsOpen((v) => !v);
  const t = st.totals;
  const pnl = st.vouchers.filter((v) => v.status === 'APPROVED' && v.group === 'PNL');
  const count = (kind: Kind, side: Side) => pnl.filter((v) => v.type === kind && v.side === side).length;
  const pick = (side: Side, kind: Kind) => {
    setFilter((f) => (f === side ? 'ALL' : side));
    setList(kind);
  };
  const hasOther = st.vouchers.some((v) => v.source !== null || v.group !== 'PNL' || v.status === 'UNAPPROVED');
  const incCount = pnl.filter((v) => v.type === 'INCOME' && (filter === 'ALL' || v.side === filter)).length;
  const expCount = pnl.filter((v) => v.type === 'EXPENSE' && (filter === 'ALL' || v.side === filter)).length;

  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="Ai thu, ai chi trong tháng" testId="settlement-who-grid"
        description="Tiền vào sổ nào thì bên đó đang giữ. Bấm một ô để xem các khoản của ô đó.">
        <div className="grid grid-cols-2 gap-x-2.5 gap-y-2 px-4 pb-3">
          <Eyebrow>Sổ chủ nhà</Eyebrow>
          <Eyebrow className="text-blue-700 dark:text-blue-300">Sổ quản lý</Eyebrow>
          {([['INCOME', 'LANDLORD'], ['INCOME', 'MANAGER'], ['EXPENSE', 'LANDLORD'], ['EXPENSE', 'MANAGER']] as const).map(([kind, side]) => {
            const n = count(kind, side);
            return (
              <CellButton key={`${kind}-${side}`} kind={kind} count={n}
                label={`${side === 'LANDLORD' ? 'Chủ nhà' : 'Quản lý'} ${kind === 'INCOME' ? 'nhận' : 'chi'}`}
                amount={kind === 'INCOME'
                  ? (side === 'LANDLORD' ? t.landlord_collected : t.manager_collected)
                  : (side === 'LANDLORD' ? t.landlord_paid : t.manager_paid)}
                sub={cellSub(st, kind, side, n)}
                selected={filter === side} onClick={() => pick(side, kind)} />
            );
          })}
        </div>
        {/* Số "đang giữ" (thu − chi) do server tính; ảnh chốt cũ không có ⇒ hiện thu và chi riêng, không tự trừ. */}
        <div className="grid grid-cols-2 gap-2.5 border-t bg-muted/30 px-4 py-2.5" data-testid="settlement-net-held">
          {(['LANDLORD', 'MANAGER'] as const).map((side) => {
            const held = side === 'LANDLORD' ? t.landlord_net_held : t.manager_net_held;
            return (
              <div key={side} className="min-w-0">
                <p className="text-[11px] text-muted-foreground">{side === 'LANDLORD' ? 'Chủ nhà đang giữ' : 'Quản lý đang giữ'}</p>
                {held != null ? (
                  <>
                    <p className={cn('mt-px whitespace-nowrap text-sm font-extrabold tabular-nums',
                      held < 0 && 'text-amber-700 dark:text-amber-400')}>{formatVND(held)}</p>
                    {held < 0 && <p className="mt-px text-[10.5px] text-muted-foreground">đã ứng tiền để chi hộ</p>}
                  </>
                ) : (
                  <p className="mt-px text-[12.5px] tabular-nums">
                    nhận <b>{formatVND(side === 'LANDLORD' ? t.landlord_collected : t.manager_collected)}</b>
                    {' '}· chi <b>{formatVND(side === 'LANDLORD' ? t.landlord_paid : t.manager_paid)}</b>
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </SectionCard>

      {narrow && (
        <div className="flex gap-2" role="group" aria-label="Chọn danh sách">
          {(['INCOME', 'EXPENSE'] as const).map((k) => {
            const on = list === k;
            return (
              <button key={k} type="button" aria-pressed={on} onClick={() => setList(k)}
                className={cn('flex-1 rounded-xl border px-2 py-2 text-[13px] font-extrabold',
                  on ? (k === 'INCOME' ? 'border-emerald-700 bg-emerald-700 text-white' : 'border-orange-700 bg-orange-700 text-white')
                    : 'bg-card text-foreground/75')}>
                {k === 'INCOME' ? `Khoản thu · ${incCount}` : `Khoản chi · ${expCount}`}
              </button>
            );
          })}
        </div>
      )}

      {filter !== 'ALL' && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/75" data-testid="settlement-filter-bar">
          <span>Đang xem khoản của <b>{filter === 'LANDLORD' ? 'sổ chủ nhà' : 'sổ quản lý'}</b></span>
          <button type="button" onClick={() => setFilter('ALL')}
            className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1 text-[11.5px] font-semibold hover:bg-muted">
            Xem tất cả<X className="h-3 w-3" aria-hidden />
          </button>
        </div>
      )}

      <div className="grid items-start gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]">
        {(!narrow || list === 'INCOME') && (
          <ListCard kind="INCOME" st={st} filter={filter} mode={mode} catsOpen={catsOpen} onToggleCats={toggleCats} />
        )}
        {(!narrow || list === 'EXPENSE') && (
          <ListCard kind="EXPENSE" st={st} filter={filter} mode={mode} catsOpen={catsOpen} onToggleCats={toggleCats} />
        )}
      </div>

      {hasOther && (
        <SectionCard title="Khoản khác" testId="settlement-other-vouchers"
          description="Thanh lý hợp đồng, cọc & tiền khách trả thừa, phiếu chờ duyệt và phiếu không tính vào lợi nhuận — để đối chiếu với sổ.">
          <div className="space-y-2 px-4 pb-4">
            {st.excluded.voucher_count > 0 && (
              <p className="text-xs text-muted-foreground">
                {st.excluded.voucher_count} phiếu không tính vào lợi nhuận (khoản nội bộ hoặc phiếu tắt tính KQKD): thu {formatVND(st.excluded.income)}
                {' '}· chi {formatVND(st.excluded.expense)} — xem nhóm "Không tính".
              </p>
            )}
            <VoucherBreakdown vouchers={st.vouchers} totals={t} mode={mode} periodMonth={st.period_month}
              only={OTHER_GROUPS} depositHolder={st.deposit_holder} title="Phiếu theo nhóm" />
          </div>
        </SectionCard>
      )}
    </div>
  );
}
