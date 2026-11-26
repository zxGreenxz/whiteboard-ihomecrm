import { useId, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  HandCoins,
  Landmark,
  Layers3,
  Scale,
  X,
} from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { formatISODateVN } from '@/lib/vnDate';

const topics = {
  profit: { label: 'Lợi nhuận', icon: Layers3 },
  payout: { label: 'Chi lợi nhuận', icon: ArrowUpRight },
  advance: { label: 'Tạm ứng', icon: HandCoins },
  balance: { label: 'Số dư kỳ', icon: Scale },
  fund: { label: 'Quỹ chung', icon: Landmark },
  expenses: { label: 'Chi quỹ chung', icon: ArrowDownLeft },
} as const;
type Topic = keyof typeof topics;
export type OverviewItems = Partial<
  Record<Topic, { amount: number | null; caption: string; detail: ReactNode }>
>;
export interface OverviewLine {
  key: string;
  date?: string | null;
  title: string;
  note?: string;
  amount: number | null;
}
export const overviewMoney = (amount: number | null | undefined) =>
  amount == null ? '—' : formatCurrency(amount);

export function OverviewLines({
  rows,
  empty = 'Chưa có chứng từ trong kỳ này.',
}: {
  rows: OverviewLine[];
  empty?: string;
}) {
  return rows.length ? (
    <ul className="divide-y rounded-lg border bg-background">
      {rows.map((row) => (
        <li key={row.key} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3">
          <div className="min-w-0 flex-1">
            <span className="block break-words text-sm font-semibold">{row.title}</span>
            {(row.date || row.note) && (
              <span className="block break-words text-xs text-muted-foreground">
                {[row.date && formatISODateVN(row.date), row.note].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
          <strong className="whitespace-nowrap text-sm tabular-nums">{overviewMoney(row.amount)}</strong>
        </li>
      ))}
    </ul>
  ) : (
    <p className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">{empty}</p>
  );
}

export function FinanceOverview({
  title,
  controls,
  items,
  children,
}: {
  title: string;
  controls?: ReactNode;
  items: OverviewItems;
  children?: ReactNode;
}) {
  const [active, setActive] = useState<Topic | null>(null);
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const buttons = useRef<Partial<Record<Topic, HTMLButtonElement | null>>>({});
  const selected = active && items[active];
  function choose(key: Topic) {
    if (key === active) {
      setActive(null);
      return;
    }
    setActive(key);
    requestAnimationFrame(() => panel.current?.focus());
  }
  function close() {
    if (active) buttons.current[active]?.focus();
    setActive(null);
  }
  return (
    <section className="space-y-4 text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {controls}
      </header>
      <div className="grid grid-cols-1 gap-3 min-[350px]:grid-cols-2 lg:grid-cols-3">
        {(Object.keys(topics) as Topic[]).map((key) => {
          const item = items[key];
          if (!item) return null;
          const { icon: Icon, label } = topics[key];
          return (
            <button
              key={key}
              type="button"
              ref={(el) => {
                buttons.current[key] = el;
              }}
              aria-expanded={active === key}
              aria-controls={id}
              onClick={() => choose(key)}
              className={
                'group flex min-w-0 flex-col rounded-xl border p-4 text-left shadow-sm transition-colors hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ' +
                (key === 'balance'
                  ? 'border-emerald-800 bg-emerald-900 text-white'
                  : active === key
                    ? 'border-primary bg-accent/50'
                    : 'bg-card')
              }
            >
              <span className="flex w-full items-center gap-2 text-sm font-semibold">
                <Icon
                  aria-hidden
                  className={'size-4 shrink-0 ' + (key === 'balance' ? 'text-emerald-200' : 'text-primary')}
                />
                {label}
                <ChevronRight
                  aria-hidden
                  className={
                    'ml-auto size-4 shrink-0 text-muted-foreground ' + (active === key ? 'rotate-90' : '')
                  }
                />
              </span>
              <strong className="mt-3 break-words text-lg font-semibold leading-tight tracking-tight tabular-nums sm:text-2xl">
                {overviewMoney(item.amount)}
              </strong>
              <span
                className={
                  'mt-1 text-xs leading-relaxed ' +
                  (key === 'balance' ? 'text-emerald-100' : 'text-muted-foreground')
                }
              >
                {item.caption}
              </span>
            </button>
          );
        })}
      </div>
      <div id={id}>
        {active && selected && (
          <section
            ref={panel}
            tabIndex={-1}
            aria-label={'Chi tiết ' + topics[active].label}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.defaultPrevented) close();
            }}
            className="space-y-3 rounded-xl border bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-primary sm:p-5"
          >
            <header className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">{topics[active].label}</h3>
                <p className="text-xs text-muted-foreground">{selected.caption}</p>
              </div>
              <button
                type="button"
                onClick={close}
                className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium"
              >
                <X aria-hidden className="size-3.5" />
                Đóng chi tiết
              </button>
            </header>
            {selected.detail}
          </section>
        )}
      </div>
      {children}
    </section>
  );
}

export function OverviewPeriod({
  year,
  month,
  years,
  onYear,
  onMonth,
}: {
  year: number;
  month: number | null;
  years: number[];
  onYear: (year: number) => void;
  onMonth: (month: number | null) => void;
}) {
  const style = 'rounded-md border bg-background px-2 py-2 text-sm';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Năm đối chiếu"
        value={year}
        onChange={(e) => onYear(Number(e.target.value))}
        className={style}
      >
        {years.map((y) => (
          <option key={y} value={y}>
            Năm {y}
          </option>
        ))}
      </select>
      <select
        aria-label="Kỳ đối chiếu"
        value={month ?? ''}
        onChange={(e) => onMonth(e.target.value ? Number(e.target.value) : null)}
        className={style}
      >
        <option value="">Cả năm</option>
        {Array.from({ length: 12 }, (_, i) => (
          <option key={i} value={i + 1}>
            Tháng {i + 1}
          </option>
        ))}
      </select>
    </div>
  );
}
