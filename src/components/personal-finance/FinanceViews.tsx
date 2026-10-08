import { useState, useEffect, useRef, useId, type ReactNode } from "react";
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Download,
  Pencil,
  Plus,
  Trash2,
  Wallet,
  Tags,
  Settings,
  ChevronDown,
  Check,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PopoverContainerContext } from "@/components/ui/popover";
import { sumMoney } from "@/lib/personalFinance/money";
import type { Entity, Snapshot } from "@/lib/personalFinance/contract";
import {
  selectMonth,
  selectTransactions,
  selectGoals,
  transactionsCsv,
} from "@/lib/personalFinance/selectors";
import {
  money,
  shiftMonth,
  deleteReason,
  entityLabel,
  categoryFilterFor,
  categoryFilterValue,
  matchesCategoryFilter,
  type CategoryFilter,
  type Filters,
  type Editor,
  type RecordData,
  type Permissions,
} from "./presentation";

/** Kept mounted so the recorder and attachment composer survive closing the sheet. */
export function FinanceSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [container, setContainer] = useState<HTMLDialogElement | null>(null);
  useEffect(() => setContainer(dialog.current), []);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      if (node.showModal) node.showModal();
      else node.setAttribute("open", "");
    } else if (!open && node.open) {
      if (node.close) node.close();
      else node.removeAttribute("open");
    }
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="pf-dialog pf-sheet"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <div className="pf-sheet-handle" />
      <header className="pf-sheet-header">
        <h2 id={titleId}>{title}</h2>
        <button aria-label="Đóng" onClick={onClose}>
          <X size={21} />
        </button>
      </header>
      <PopoverContainerContext.Provider value={container ?? undefined}>
        <div className="pf-sheet-body">{children}</div>
      </PopoverContainerContext.Provider>
    </dialog>
  );
}

const shortMoney = (value: number) =>
  Math.abs(value) >= 1e6
    ? new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(
        value / 1e6,
      ) + "tr"
    : new Intl.NumberFormat("vi-VN").format(value / 1000) + "k";
export function MonthPicker({
  month,
  onChange,
}: {
  month: string;
  onChange: (m: string) => void;
}) {
  return (
    <div className="pf-month">
      <button
        aria-label="Tháng trước"
        onClick={() => onChange(shiftMonth(month, -1))}
      >
        <ChevronLeft size={16} />
      </button>
      <label>
        <span>
          {Number(month.slice(5))}.{month.slice(0, 4)}
        </span>
        <input
          aria-label="Tháng"
          type="month"
          value={month}
          onChange={(e) => {
            if (e.target.value) onChange(e.target.value);
          }}
        />
      </label>
      <button
        aria-label="Tháng sau"
        onClick={() => onChange(shiftMonth(month, 1))}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
type Props = {
  snapshot: Snapshot;
  permissions: Permissions;
  edit: (editor: Editor) => void;
};
export function RowActions({
  entity,
  row,
  snapshot,
  permissions,
  edit,
}: Props & { entity: Entity; row: RecordData }) {
  const reason = deleteReason(entity, row, snapshot);
  return (
    <div className="pf-actions">
      {permissions.edit && !(entity === "transfer" && row.goal_id) && (
        <button
          aria-label={`Sửa ${entityLabel[entity]} ${String(row.name ?? row.description ?? row.note ?? "")}`.trim()}
          onClick={() => edit({ entity, record: row })}
        >
          <Pencil size={16} />
        </button>
      )}
      {permissions.delete && (
        <button
          aria-label={`Xóa ${entityLabel[entity]} ${String(row.name ?? row.description ?? row.note ?? "")}`.trim()}
          title={reason ?? undefined}
          onClick={() => edit({ entity, record: row, remove: true })}
        >
          <Trash2 size={16} />
        </button>
      )}
    </div>
  );
}
export function Management({
  kind,
  onWallet,
  ...p
}: Props & { kind: "wallet" | "category"; onWallet?: (id: string) => void }) {
  const [type, setType] = useState("EXPENSE");
  const rows =
    kind === "wallet"
      ? p.snapshot.wallets
      : p.snapshot.categories.filter((c) => c.type === type);
  return (
    <div className="pf-stack">
      {kind === "category" && (
        <div className="pf-pills">
          <button
            className={type === "EXPENSE" ? "active" : ""}
            onClick={() => setType("EXPENSE")}
          >
            Chi tiêu
          </button>
          <button
            className={type === "INCOME" ? "active" : ""}
            onClick={() => setType("INCOME")}
          >
            Thu nhập
          </button>
        </div>
      )}
      <div
        className={
          kind === "category" ? "pf-category-grid" : "pf-wallet-settings"
        }
      >
        {rows.map((r) => (
          <div
            className={kind === "category" ? "pf-category-cell" : "pf-row"}
            key={r.id}
          >
            <button
              className={
                kind === "category" ? "pf-category-detail" : "pf-wallet-detail"
              }
              aria-label={
                kind === "category"
                  ? `${p.permissions.edit ? "Sửa" : "Xem"} danh mục ${r.name}`
                  : `Xem ví ${r.name}`
              }
              onClick={() =>
                kind === "wallet" && onWallet
                  ? onWallet(r.id)
                  : p.edit({ entity: kind, record: r })
              }
            >
              <span className="pf-emoji">{r.icon}</span>
              <span className="pf-grow">
                <strong>{r.name}</strong>
                <small>
                  {kind === "wallet" && "balance" in r ? money(r.balance) : ""}
                  {kind === "wallet" && "is_preferred" in r && r.is_preferred ? " · Ưu tiên" : ""}
                  {r.hidden ? " · Đang ẩn" : ""}
                </small>
              </span>
            </button>
            {kind === "wallet" &&
              (p.permissions.edit || p.permissions.delete) && (
                <button
                  aria-label={`${p.permissions.edit ? "Sửa ví" : "Chi tiết ví"} ${r.name}`}
                  onClick={() => p.edit({ entity: kind, record: r })}
                >
                  <Pencil size={18} />
                </button>
              )}
          </div>
        ))}
      </div>
      {p.permissions.create && (
        <Button
          onClick={() =>
            p.edit({
              entity: kind,
              defaults: kind === "category" ? { type } : undefined,
            })
          }
        >
          <Plus size={16} />
          Thêm {entityLabel[kind]}
        </Button>
      )}
      <p className="pf-muted">
        {kind === "wallet"
          ? "Ví ẩn vẫn được tính vào tổng số dư và vẫn có thể chọn khi ghi giao dịch."
          : "Danh mục ẩn vẫn giữ trong lịch sử. Mỗi loại cần ít nhất một danh mục hiện."}
      </p>
    </div>
  );
}
export function Ledger(
  p: Props & {
    month: string;
    filters: Filters;
    onFilters: (f: Filters) => void;
    manage: () => void;
    categories: () => void;
    recent?: boolean;
    entry?: () => void;
    company?: ReactNode;
  },
) {
  const { snapshot: s, filters: f } = p;
  const [picker, setPicker] = useState<
    "wallet" | "category" | "settings" | null
  >(null);
  const all = selectMonth(s, p.month);
  const categoryOptions = [
    ...s.categories.map((c) => ({
      value: c.id,
      label: c.name,
      filter: categoryFilterFor(c.id, null),
    })),
    ...new Map(
      selectTransactions(s)
        .filter((t) => t.resolved_category_id === null)
        .map((t) => {
          const filter = categoryFilterFor(null, t.category);
          const value = categoryFilterValue(filter);
          return [
            value,
            {
              value,
              label:
                t.category === null
                  ? "Chưa phân loại"
                  : `${t.category || "(Tên trống)"} · Lịch sử`,
              filter,
            },
          ];
        }),
    ).values(),
  ];
  const txns = all.transactions.filter(
    (t) =>
      (f.type === "all" || t.type === f.type) &&
      (!f.wallet || t.resolved_wallet_id === f.wallet) &&
      matchesCategoryFilter(t, f.category) &&
      `${t.description ?? ""} ${s.categories.find((c) => c.id === t.resolved_category_id)?.name ?? t.category ?? ""} ${t.amount}`
        .toLocaleLowerCase("vi")
        .includes(f.search.toLocaleLowerCase("vi")),
  );
  const transfers = s.transfers.filter(
    (t) =>
      !t.deleted_at &&
      t.txn_date.startsWith(p.month) &&
      (f.type === "all" || f.type === "transfer") &&
      f.category.kind === "all" &&
      (!f.wallet ||
        [t.source_wallet_id, t.target_wallet_id].includes(f.wallet)) &&
      (t.note ?? "Chuyển ví")
        .toLocaleLowerCase("vi")
        .includes(f.search.toLocaleLowerCase("vi")),
  );
  const rows = [
    ...txns.map((t) => ({ date: t.txn_date, key: t.id, txn: t })),
    ...transfers.map((t) => ({ date: t.txn_date, key: t.id, transfer: t })),
  ]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, p.recent ? 5 : undefined);
  const days = [...new Set(rows.map((r) => r.date))];
  const income = sumMoney(
    txns.filter((t) => t.type === "INCOME").map((t) => t.amount),
  );
  const expense = sumMoney(
    txns.filter((t) => t.type === "EXPENSE").map((t) => t.amount),
  );
  return (
    <>
      {!p.recent && (
        <>
          <div className={`pf-pills pf-type-chips${p.company ? " pf-has-company" : ""}`}>
            {[
              ["all", "Tất cả"],
              ["EXPENSE", "Chi tiêu"],
              ["INCOME", "Thu nhập"],
              ["transfer", "Chuyển ví"],
              ...(p.company ? [["company", "Công ty"]] : []),
            ].map(([value, label]) => (
              <button
                key={value}
                className={f.type === value ? "active" : ""}
                onClick={() => p.onFilters({ ...f, type: value })}
              >
                {label}
              </button>
            ))}
            <button
              className="pf-ledger-settings"
              aria-label="Cài đặt ví cá nhân"
              title="Cài đặt ví và danh mục"
              onClick={() => setPicker("settings")}
            >
              <Settings size={18} />
            </button>
          </div>
          {f.type !== "company" && <div className="pf-tools pf-filter-triggers">
            <button aria-label="Lọc ví" onClick={() => setPicker("wallet")}>
              <Wallet size={18} />
              {s.wallets.find((w) => w.id === f.wallet)?.name ?? "Mọi ví"}
              <ChevronDown size={16} />
            </button>
            <button
              aria-label="Lọc danh mục"
              onClick={() => setPicker("category")}
            >
              <Tags size={18} />
              {categoryOptions.find(
                (c) => c.value === categoryFilterValue(f.category),
              )?.label ?? "Mọi danh mục"}
              <ChevronDown size={16} />
            </button>
          </div>}
        </>
      )}
      <FinanceSheet
        open={picker !== null}
        title={
          picker === "wallet"
            ? "Lọc theo ví"
            : picker === "category"
              ? "Lọc theo danh mục"
              : "Quản lý ví cá nhân"
        }
        onClose={() => setPicker(null)}
      >
        {picker === "settings" ? (
          <div className="pf-stack">
            <button
              className="pf-list-item"
              onClick={() => {
                setPicker(null);
                p.manage();
              }}
            >
              <Wallet />
              Ví & tài khoản
              <ChevronRight />
            </button>
            <button
              className="pf-list-item"
              onClick={() => {
                setPicker(null);
                p.categories();
              }}
            >
              <Tags />
              Danh mục thu chi
              <ChevronRight />
            </button>
          </div>
        ) : (
          <>
            {(picker === "wallet"
              ? [
                  { value: "", label: "Tất cả các ví", icon: "👛" },
                  ...s.wallets.map((w) => ({
                    value: w.id,
                    label: w.name,
                    icon: w.icon,
                  })),
                ]
              : [
                  { value: "", label: "Mọi danh mục", icon: "🏷️" },
                  ...categoryOptions.map((c) => ({
                    ...c,
                    icon:
                      s.categories.find((x) => x.id === c.value)?.icon ?? "🏷️",
                  })),
                ]
            ).map((option) => (
              <button
                className="pf-filter-option"
                key={option.value}
                aria-pressed={
                  option.value ===
                  (picker === "wallet"
                    ? f.wallet
                    : categoryFilterValue(f.category))
                }
                onClick={() => {
                  p.onFilters(
                    picker === "wallet"
                      ? { ...f, wallet: option.value }
                      : {
                          ...f,
                          category: categoryOptions.find(
                            (c) => c.value === option.value,
                          )?.filter ?? { kind: "all" },
                        },
                  );
                  setPicker(null);
                }}
              >
                <span className="pf-emoji">{option.icon}</span>
                <span className="pf-grow">{option.label}</span>
                {option.value ===
                  (picker === "wallet"
                    ? f.wallet
                    : categoryFilterValue(f.category)) && <Check size={20} />}
              </button>
            ))}
            <footer className="pf-form-actions pf-filter-footer">
              {p.permissions.create && (
                <Button
                  onClick={() => {
                    setPicker(null);
                    p.edit({
                      entity: picker === "wallet" ? "wallet" : "category",
                    });
                  }}
                >
                  <Plus size={16} />
                  Thêm {picker === "wallet" ? "ví" : "danh mục"}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  setPicker(null);
                  if (picker === "wallet") p.manage();
                  else p.categories();
                }}
              >
                <Settings size={18} />
                Quản lý {picker === "wallet" ? "ví" : "danh mục"}
              </Button>
            </footer>
          </>
        )}
      </FinanceSheet>
      {f.type === "company" && p.company ? p.company : <section className="pf-card">
        {!p.recent && (
          <div className="pf-between pf-muted">
            <span>{rows.length} giao dịch</span>
            <span>
              Thu {money(income)} · Chi {money(expense)}
            </span>
          </div>
        )}
        {!rows.length && p.recent && (
          <div className="pf-empty">
            <span className="pf-empty-emoji">🌱</span>
            <h3>Tháng này còn trống</h3>
            <p>Ghi lại khoản đầu tiên của bạn.</p>
            {p.permissions.create && (
              <Button
                variant="outline"
                onClick={() =>
                  p.entry ? p.entry() : p.edit({ entity: "transaction" })
                }
              >
                Ghi khoản đầu tiên
              </Button>
            )}
          </div>
        )}
        {!rows.length && !p.recent && (
          <p className="pf-empty">
            Chưa có giao dịch phù hợp. Thay bộ lọc hoặc ghi khoản đầu tiên.
          </p>
        )}
        {days.map((day) => (
          <section key={day}>
            <h3 className="pf-day">{day.split("-").reverse().join("/")}</h3>
            {rows
              .filter((r) => r.date === day)
              .map((row) => {
                return "txn" in row ? (
                  <button
                    className="pf-row pf-transaction"
                    key={row.key}
                    aria-label={`Xem ${row.txn.description || row.txn.category || "Giao dịch"}`}
                    onClick={() =>
                      p.edit({ entity: "transaction", record: row.txn })
                    }
                  >
                    <span className="pf-emoji">
                      {s.categories.find(
                        (c) => c.id === row.txn.resolved_category_id,
                      )?.icon ?? "🧾"}
                    </span>
                    <div className="pf-grow">
                      <strong>
                        {row.txn.description ||
                          s.categories.find(
                            (c) => c.id === row.txn.resolved_category_id,
                          )?.name ||
                          row.txn.category ||
                          "Giao dịch"}
                      </strong>
                      <small>
                        {s.categories.find(
                          (c) => c.id === row.txn.resolved_category_id,
                        )?.name ?? row.txn.category}{" "}
                        ·{" "}
                        {
                          s.wallets.find(
                            (w) => w.id === row.txn.resolved_wallet_id,
                          )?.name
                        }
                      </small>
                    </div>
                    <div
                      className={
                        row.txn.type === "INCOME" ? "pf-positive" : "pf-amount"
                      }
                    >
                      <b>
                        {row.txn.type === "INCOME" ? "+" : "−"}
                        {money(row.txn.amount)}
                      </b>
                      <small>{row.txn.type === "INCOME" ? "Thu" : "Chi"}</small>
                    </div>
                  </button>
                ) : (
                  <button
                    className="pf-row pf-transaction"
                    key={row.key}
                    aria-label={`Xem ${row.transfer.note || "Chuyển ví"}`}
                    onClick={() =>
                      p.edit({ entity: "transfer", record: row.transfer })
                    }
                  >
                    <span className="pf-emoji">
                      <ArrowLeftRight size={20} />
                    </span>
                    <div className="pf-grow">
                      <strong>{row.transfer.note || "Chuyển ví"}</strong>
                      <small>
                        {
                          s.wallets.find(
                            (w) => w.id === row.transfer.source_wallet_id,
                          )?.name
                        }{" "}
                        →{" "}
                        {
                          s.wallets.find(
                            (w) => w.id === row.transfer.target_wallet_id,
                          )?.name
                        }
                        {row.transfer.goal_id ? " · Góp mục tiêu" : ""}
                      </small>
                    </div>
                    <b>{money(row.transfer.amount)}</b>
                  </button>
                );
              })}
          </section>
        ))}
      </section>}
      {!p.recent && f.type !== "company" && p.permissions.create && (
        <Button
          className="pf-transfer-cta"
          variant="outline"
          onClick={() => p.edit({ entity: "transfer" })}
        >
          <ArrowLeftRight size={18} />
          Chuyển tiền giữa ví
        </Button>
      )}
    </>
  );
}
export function Budgets(
  p: Props & {
    month: string;
    compact?: boolean;
    onMonth?: (month: string) => void;
    categories?: () => void;
  },
) {
  const selected = selectMonth(p.snapshot, p.month),
    budgets = selected.budgets,
    overall = budgets.find((b) => !b.category_id),
    categories = budgets.filter((b) => b.category_id);
  const item = (b: (typeof budgets)[number]) => {
    const c = p.snapshot.categories.find((c) => c.id === b.category_id);
    return (
      <article
        className={`pf-budget-item ${b.ratio > 1 ? "over" : b.ratio >= 0.8 ? "warn" : ""}`}
        key={b.id}
      >
        <div className="pf-between">
          <div className="pf-budget-label">
            <span>{c?.icon ?? "🏷️"}</span>
            <strong>{c?.name ?? "Danh mục"}</strong>
          </div>
          {p.compact ? (
            <span className="pf-muted">
              {shortMoney(b.spent)} / {shortMoney(b.amount)}
            </span>
          ) : (
            <button
              aria-label={`${p.permissions.edit ? "Sửa" : "Xem"} hạn mức ${c?.name ?? ""}`}
              onClick={() => p.edit({ entity: "budget", record: b })}
              disabled={!p.permissions.edit && !p.permissions.delete}
            >
              <Pencil size={18} />
            </button>
          )}
        </div>
        {!p.compact && (
          <div className="pf-between pf-muted">
            <span>{money(b.spent)}</span>
            <span>/ {money(b.amount)}</span>
          </div>
        )}
        <progress
          aria-label={`Đã chi ${c?.name ?? "danh mục"}`}
          max={Math.max(b.amount, b.spent)}
          value={b.spent}
        />
        <p className="pf-budget-note">
          {b.remaining < 0 ? "Vượt" : "Còn"} {money(Math.abs(b.remaining))} ·{" "}
          {Math.round(b.ratio * 100)}% đã dùng
        </p>
      </article>
    );
  };
  const summary = overall ? (
    <div className="pf-budget-total">
      <div className="pf-between">
        <span className="pf-muted">
          {overall.remaining < 0 ? "Vượt ngân sách tháng" : "Còn có thể chi"}
        </span>
        <strong>{money(Math.abs(overall.remaining))}</strong>
      </div>
      <progress
        aria-label="Ngân sách tổng"
        max={Math.max(overall.amount, overall.spent)}
        value={overall.spent}
      />
      <p className="pf-budget-note">
        Đã chi {money(overall.spent)} / ngân sách {money(overall.amount)}
      </p>
    </div>
  ) : (
    <p className="pf-empty">Chưa đặt ngân sách tổng.</p>
  );
  if (p.compact)
    return (
      <div>
        {summary}
        {categories.slice(0, 3).map(item)}
        <p className="pf-budget-advice">
          {categories.some((b) => b.ratio >= 0.8)
            ? "Có danh mục đã dùng hơn 80% ngân sách. Xem Ngân sách để điều chỉnh."
            : "Mỗi khoản ghi lại giúp bạn nhìn rõ hơn."}
        </p>
      </div>
    );
  return (
    <div className="pf-stack">
      <section className="pf-card">
        <div className="pf-between">
          <div>
            <h2>Ngân sách</h2>
            <p className="pf-muted">Tất cả ví cá nhân</p>
          </div>
          {p.onMonth && <MonthPicker month={p.month} onChange={p.onMonth} />}
        </div>
        <div className="pf-between pf-monthly-amount">
          <strong>{overall ? money(overall.amount) : "Chưa đặt"}</strong>
          {(overall
            ? p.permissions.edit || p.permissions.delete
            : p.permissions.create) && (
            <button
              aria-label="Sửa ngân sách tháng"
              onClick={() =>
                p.edit({
                  entity: "budget",
                  ...(overall
                    ? { record: overall }
                    : { defaults: { category_id: "" } }),
                })
              }
            >
              <Pencil size={20} />
            </button>
          )}
        </div>
        {overall && (
          <>
            <progress
              aria-label="Ngân sách tháng"
              max={Math.max(overall.amount, overall.spent)}
              value={overall.spent}
            />
            <p className="pf-muted">
              Đã chi {money(selected.expense)} ·{" "}
              {overall.remaining < 0 ? "Vượt" : "Còn"}{" "}
              {money(Math.abs(overall.remaining))}
            </p>
          </>
        )}
      </section>
      <section className="pf-card">
        <div className="pf-between">
          <h2>Theo danh mục</h2>
          <div className="pf-tools">
            {p.categories && (
              <button aria-label="Quản lý danh mục" onClick={p.categories}>
                <Tags size={20} />
              </button>
            )}
            {p.permissions.create && (
              <button
                aria-label="Thêm hạn mức"
                onClick={() =>
                  p.edit({
                    entity: "budget",
                    defaults: {
                      category_id:
                        p.snapshot.categories.find(
                          (c) =>
                            c.type === "EXPENSE" &&
                            !c.hidden &&
                            !budgets.some((b) => b.category_id === c.id),
                        )?.id ??
                        p.snapshot.categories.find(
                          (c) => c.type === "EXPENSE" && !c.hidden,
                        )?.id ??
                        "",
                    },
                  })
                }
              >
                <Plus size={18} /> Thêm
              </button>
            )}
          </div>
        </div>
        {categories.map(item)}
        {!categories.length && (
          <p className="pf-empty">
            Chưa có ngân sách. Đặt giới hạn cho danh mục bạn quan tâm.
          </p>
        )}
      </section>
    </div>
  );
}
export function Goals(p: Props) {
  return (
    <div className="pf-stack">
      <p className="pf-muted">
        Góp tiền bằng chuyển giữa hai ví. “Đã góp” là tổng khoản đã góp, không
        phải số dư còn lại của ví.
      </p>
      {selectGoals(p.snapshot).map((g) => (
        <article className="pf-card pf-goal-card" key={g.id}>
          <div className="pf-between">
            <h3>
              <span className="pf-goal-icon">{g.icon}</span> {g.name}
            </h3>
            <RowActions {...p} entity="goal" row={g} />
          </div>
          <p>
            Đã góp <b>{money(g.saved)}</b> / {money(g.target)}
          </p>
          <progress
            aria-label={`Tiến độ ${g.name}`}
            max={Math.max(g.target, g.saved)}
            value={g.saved}
          />
          <p className="pf-muted">
            {p.snapshot.wallets.find((w) => w.id === g.wallet_id)?.name} · Số dư{" "}
            {money(
              p.snapshot.wallets.find((w) => w.id === g.wallet_id)?.balance ??
                0,
            )}
            {g.target_date ? ` · Hẹn ${g.target_date}` : ""}
          </p>
          {p.permissions.create && (
            <Button
              variant="outline"
              onClick={() =>
                p.edit({
                  entity: "transfer",
                  defaults: {
                    goal_id: g.id,
                    target_wallet_id: g.wallet_id,
                    source_wallet_id:
                      p.snapshot.wallets.find((w) => w.id !== g.wallet_id)
                        ?.id ?? "",
                  },
                })
              }
            >
              Góp tiền {g.name}
            </Button>
          )}
        </article>
      ))}
      {!p.snapshot.goals.length && (
        <p className="pf-empty">Chưa có mục tiêu tích lũy.</p>
      )}
      {p.permissions.create && (
        <Button onClick={() => p.edit({ entity: "goal" })}>
          <Plus size={16} />
          Thêm mục tiêu
        </Button>
      )}
    </div>
  );
}
const colors = [
  "#146a57",
  "#88a777",
  "#d6b56d",
  "#91bdb1",
  "#c1908a",
  "#9f9bc7",
];
export function Reports({
  snapshot: s,
  month,
  onMonth,
  onDrill,
}: {
  snapshot: Snapshot;
  month: string;
  onMonth: (m: string) => void;
  onDrill: (category: CategoryFilter, type: string) => void;
}) {
  const [type, setType] = useState("EXPENSE");
  const selected = selectMonth(s, month);
  const groups = selected.categories
    .filter((c) => c.type === type)
    .sort((a, b) => b.amount - a.amount);
  const total = type === "EXPENSE" ? selected.expense : selected.income;
  let offset = 0;
  const groupColor = (c: (typeof groups)[number], i: number) =>
    s.categories.find((category) => category.id === c.categoryId)?.color ??
    colors[i % colors.length];
  const stops = groups.map((c, i) => {
    const begin = offset;
    offset += total ? (c.amount / total) * 100 : 0;
    return `${groupColor(c, i)} ${begin}% ${offset}%`;
  });
  const months = Array.from({ length: 6 }, (_, i) =>
    selectMonth(s, shiftMonth(month, i - 5)),
  );
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.expense]));
  const largestExpense = selected.categories
    .filter((c) => c.type === "EXPENSE")
    .sort((a, b) => b.amount - a.amount)[0];
  return (
    <>
      <div className="pf-stats">
        <div>
          Thu nhập trong tháng<strong>{money(selected.income)}</strong>
        </div>
        <div>
          Chi tiêu trong tháng<strong>{money(selected.expense)}</strong>
        </div>
      </div>
      <section className="pf-card">
        <div className="pf-report-controls">
          <MonthPicker month={month} onChange={onMonth} />
          <div className="pf-pills pf-report-tabs">
            {[
              ["EXPENSE", "Chi"],
              ["INCOME", "Thu"],
            ].map(([v, label]) => (
              <button
                key={v}
                className={v === type ? "active" : ""}
                onClick={() => setType(v)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {total ? (
          <>
            <div className="pf-ring-layout">
              <div
                className="pf-donut"
                role="img"
                aria-label={`${type === "EXPENSE" ? "Chi" : "Thu"} ${money(total)}`}
                style={{ background: `conic-gradient(${stops.join(",")})` }}
              >
                <div>
                  <small>{type === "EXPENSE" ? "Tổng chi" : "Tổng thu"}</small>
                  <b>{shortMoney(total)}</b>
                  <small>{groups.length} danh mục</small>
                </div>
              </div>
              <ul className="pf-legend">
                {groups.slice(0, 4).map((c, i) => (
                  <li
                    key={categoryFilterValue(
                      categoryFilterFor(c.categoryId, c.legacyName),
                    )}
                  >
                    <button
                      onClick={() =>
                        onDrill(
                          categoryFilterFor(c.categoryId, c.legacyName),
                          type,
                        )
                      }
                    >
                      <span style={{ background: groupColor(c, i) }} />
                      {c.name}
                      <b>{Math.round((c.amount / total) * 100)}%</b>
                    </button>
                  </li>
                ))}
                {groups.length > 4 && (
                  <li className="pf-muted">
                    + {groups.length - 4} danh mục khác
                  </li>
                )}
              </ul>
            </div>
            <p className="pf-muted">Chạm vào danh mục để xem từng khoản.</p>
            {groups.map((c, i) => (
              <button
                className="pf-category-report"
                key={categoryFilterValue(
                  categoryFilterFor(c.categoryId, c.legacyName),
                )}
                onClick={() =>
                  onDrill(categoryFilterFor(c.categoryId, c.legacyName), type)
                }
              >
                <span className="pf-emoji">
                  {s.categories.find((category) => category.id === c.categoryId)
                    ?.icon ?? "🏷️"}
                </span>
                <span className="pf-grow">{c.name}</span>
                <span>{money(c.amount)}</span>
                <ChevronRight size={18} />
                <span className="pf-category-progress">
                  <i
                    style={{
                      width: `${(c.amount / total) * 100}%`,
                      background: groupColor(c, i),
                    }}
                  />
                </span>
              </button>
            ))}
          </>
        ) : (
          <p className="pf-empty">
            Tháng này chưa có {type === "EXPENSE" ? "khoản chi" : "thu nhập"}.
          </p>
        )}
      </section>
      <section className="pf-card">
        <h2>Dòng tiền 6 tháng</h2>
        <div className="pf-bars" role="img" aria-label="Thu chi sáu tháng">
          {months.map((m) => (
            <div key={m.month}>
              <div className="pf-bar-pair">
                <i style={{ height: `${(m.income / max) * 100}%` }} />
                <i style={{ height: `${(m.expense / max) * 100}%` }} />
              </div>
              <small>
                {Number(m.month.slice(5))}.{m.month.slice(2, 4)}
              </small>
            </div>
          ))}
        </div>
        <details>
          <summary>Số liệu thu chi từng tháng</summary>
          <table className="pf-report-table">
            <thead>
              <tr>
                <th>Tháng</th>
                <th>Thu</th>
                <th>Chi</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <td>{m.month}</td>
                  <td>{money(m.income)}</td>
                  <td>{money(m.expense)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <p className="pf-muted">
          Xanh: Thu nhập · Nâu: Chi tiêu. Tháng trống: 0 ₫.
        </p>
      </section>
      <section
        className="pf-card pf-monthly-insight"
        data-testid="monthly-insight"
      >
        <h2>Nhìn lại tháng này</h2>
        <p>
          {selected.income || selected.expense ? (
            <>
              Thu trừ chi {selected.net >= 0 ? "còn" : "âm"}{" "}
              <strong>{money(Math.abs(selected.net))}</strong>.{" "}
              {largestExpense && (
                <>
                  Khoản chi lớn nhất thuộc{" "}
                  <strong>{largestExpense.name}</strong>.
                </>
              )}
            </>
          ) : (
            "Chưa đủ giao dịch để đưa ra nhận xét."
          )}
        </p>
      </section>
      <Button
        className="pf-export-report"
        variant="outline"
        onClick={() =>
          downloadCsv(transactionsCsv(s, selected.transactions), month)
        }
      >
        <Download size={16} /> Xuất giao dịch tháng này
      </Button>
    </>
  );
}
function downloadCsv(csv: string, month: string) {
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `vi-ca-nhan-${month}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
