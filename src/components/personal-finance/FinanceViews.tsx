import { useState } from "react";
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Download,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Entity, Snapshot } from "@/lib/personalFinance/contract";
import {
  selectMonth,
  selectGoals,
  transactionsCsv,
  csvCell,
} from "@/lib/personalFinance/selectors";
import {
  money,
  shiftMonth,
  deleteReason,
  entityLabel,
  type Editor,
  type RecordData,
  type Permissions,
} from "./presentation";

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
  ...p
}: Props & { kind: "wallet" | "category" }) {
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
      {rows.map((r) => (
        <article className="pf-row" key={r.id}>
          <span className="pf-emoji">{r.icon}</span>
          <div className="pf-grow">
            <strong>{r.name}</strong>
            <small>
              {kind === "wallet" && "balance" in r
                ? money(r.balance)
                : type === "EXPENSE"
                  ? "Chi tiêu"
                  : "Thu nhập"}
              {r.hidden ? " · Đã ẩn" : ""}
              {"is_default" in r && r.is_default ? " · Mặc định" : ""}
            </small>
          </div>
          <RowActions {...p} entity={kind} row={r} />
        </article>
      ))}
      <p className="pf-muted">
        {kind === "wallet"
          ? "Ví ẩn vẫn được tính vào tổng số dư và vẫn có thể chọn khi ghi giao dịch."
          : "Danh mục ẩn vẫn giữ trong lịch sử. Mỗi loại cần ít nhất một danh mục hiện."}
      </p>
    </div>
  );
}
export type Filters = {
  search: string;
  type: string;
  wallet: string;
  category: string;
};

export function Ledger(
  p: Props & {
    month: string;
    filters: Filters;
    onFilters: (f: Filters) => void;
    manage: () => void;
    categories: () => void;
  },
) {
  const { snapshot: s, filters: f } = p;
  const all = selectMonth(s, p.month);
  const txns = all.transactions.filter(
    (t) =>
      (f.type === "all" || t.type === f.type) &&
      (!f.wallet || t.resolved_wallet_id === f.wallet) &&
      (!f.category || t.resolved_category_id === f.category) &&
      `${t.description ?? ""} ${s.categories.find((c) => c.id === t.resolved_category_id)?.name ?? t.category ?? ""}`
        .toLocaleLowerCase("vi")
        .includes(f.search.toLocaleLowerCase("vi")),
  );
  const transfers = s.transfers.filter(
    (t) =>
      !t.deleted_at &&
      t.txn_date.startsWith(p.month) &&
      (f.type === "all" || f.type === "transfer") &&
      !f.category &&
      (!f.wallet ||
        [t.source_wallet_id, t.target_wallet_id].includes(f.wallet)) &&
      (t.note ?? "Chuyển ví")
        .toLocaleLowerCase("vi")
        .includes(f.search.toLocaleLowerCase("vi")),
  );
  const rows = [
    ...txns.map((t) => ({ date: t.txn_date, key: t.id, txn: t })),
    ...transfers.map((t) => ({ date: t.txn_date, key: t.id, transfer: t })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const days = [...new Set(rows.map((r) => r.date))];
  const exportCsv = () => {
    let csv = transactionsCsv(s, txns);
    if (transfers.length)
      csv +=
        "\r\n" +
        transfers
          .map((t) =>
            [
              t.txn_date,
              "TRANSFER",
              t.amount,
              `${s.wallets.find((w) => w.id === t.source_wallet_id)?.name} → ${s.wallets.find((w) => w.id === t.target_wallet_id)?.name}`,
              "",
              t.note,
            ]
              .map(csvCell)
              .join(","),
          )
          .join("\r\n");
    downloadCsv(csv, p.month);
  };
  return (
    <>
      <div className="pf-pills">
        {[
          ["all", "Tất cả"],
          ["EXPENSE", "Chi tiêu"],
          ["INCOME", "Thu nhập"],
          ["transfer", "Chuyển ví"],
        ].map(([value, label]) => (
          <button
            key={value}
            className={f.type === value ? "active" : ""}
            onClick={() => p.onFilters({ ...f, type: value })}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="pf-filter-row">
        <select
          aria-label="Lọc ví"
          value={f.wallet}
          onChange={(e) => p.onFilters({ ...f, wallet: e.target.value })}
        >
          <option value="">Mọi ví</option>
          {s.wallets.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Lọc danh mục"
          value={f.category}
          onChange={(e) => p.onFilters({ ...f, category: e.target.value })}
        >
          <option value="">Mọi danh mục</option>
          {s.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="pf-tools">
        <button onClick={p.manage}>Quản lý ví</button>
        <button onClick={p.categories}>Quản lý danh mục</button>
        <button aria-label="Xuất CSV" onClick={exportCsv}>
          <Download size={16} /> CSV
        </button>
      </div>
      <section className="pf-card">
        <div className="pf-between pf-muted">
          <span>{rows.length} giao dịch</span>
          <span>
            Thu {money(all.income)} · Chi {money(all.expense)}
          </span>
        </div>
        {!rows.length && (
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
                  <article className="pf-row" key={row.key}>
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
                      <RowActions {...p} entity="transaction" row={row.txn} />
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
                  </article>
                ) : (
                  <article className="pf-row" key={row.key}>
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
                      <RowActions {...p} entity="transfer" row={row.transfer} />
                    </div>
                    <b>{money(row.transfer.amount)}</b>
                  </article>
                );
              })}
          </section>
        ))}
      </section>
    </>
  );
}
export function Budgets(p: Props & { month: string; compact?: boolean }) {
  const budgets = selectMonth(p.snapshot, p.month).budgets;
  return (
    <div className="pf-stack">
      {!p.compact && (
        <p className="pf-muted">
          Hạn mức tổng và từng danh mục độc lập, lặp lại mỗi tháng trên mọi ví
          cá nhân.
        </p>
      )}
      {!budgets.length && (
        <p className="pf-empty">
          Chưa đặt ngân sách. Đặt hạn mức để theo dõi chi tiêu mỗi tháng.
        </p>
      )}
      {budgets.map((b) => (
        <article
          className={`pf-budget ${b.ratio > 1 ? "over" : ""}`}
          key={b.id}
        >
          <div className="pf-between">
            <strong>
              {b.category_id
                ? p.snapshot.categories.find((c) => c.id === b.category_id)
                    ?.name
                : "Tổng chi tiêu"}
            </strong>
            {!p.compact && <RowActions {...p} entity="budget" row={b} />}
          </div>
          <div className="pf-between">
            <span>{b.remaining >= 0 ? "Còn có thể chi" : "Đã vượt"}</span>
            <b>{money(Math.abs(b.remaining))}</b>
          </div>
          <progress
            aria-label={`Đã chi ${b.category_id ? p.snapshot.categories.find((c) => c.id === b.category_id)?.name : "tổng"}`}
            max={Math.max(b.amount, b.spent)}
            value={b.spent}
          />
          <small>
            Đã chi {money(b.spent)} / {money(b.amount)}
          </small>
        </article>
      ))}
      {!p.compact && p.permissions.create && (
        <Button onClick={() => p.edit({ entity: "budget" })}>
          <Plus size={16} />
          Thêm hạn mức
        </Button>
      )}
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
        <article className="pf-card" key={g.id}>
          <div className="pf-between">
            <h3>
              {g.icon} {g.name}
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
  onDrill: (category: string, type: string) => void;
}) {
  const [type, setType] = useState("EXPENSE");
  const selected = selectMonth(s, month);
  const groups = selected.categories.filter((c) => c.type === type);
  const total = groups.reduce((a, c) => a + c.amount, 0);
  let offset = 0;
  const stops = groups.map((c, i) => {
    const begin = offset;
    offset += total ? (c.amount / total) * 100 : 0;
    return `${colors[i % colors.length]} ${begin}% ${offset}%`;
  });
  const months = Array.from({ length: 6 }, (_, i) =>
    selectMonth(s, shiftMonth(month, i - 5)),
  );
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.expense]));
  return (
    <>
      <div className="pf-stats">
        <div>
          Thu nhập<strong>{money(selected.income)}</strong>
        </div>
        <div>
          Chi tiêu<strong>{money(selected.expense)}</strong>
        </div>
      </div>
      <section className="pf-card">
        <div className="pf-report-controls">
          <MonthPicker month={month} onChange={onMonth} />
          <div className="pf-pills">
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
            <div
              className="pf-donut"
              role="img"
              aria-label={`${type === "EXPENSE" ? "Chi" : "Thu"} ${money(total)}`}
              style={{ background: `conic-gradient(${stops.join(",")})` }}
            >
              <div>
                <small>{type === "EXPENSE" ? "Tổng chi" : "Tổng thu"}</small>
                <b>{money(total)}</b>
              </div>
            </div>
            <ul className="pf-legend">
              {groups.map((c, i) => (
                <li key={`${c.categoryId}-${c.name}`}>
                  <button onClick={() => onDrill(c.categoryId ?? "", type)}>
                    <span style={{ background: colors[i % colors.length] }} />
                    {c.name}
                    <b>{money(c.amount)}</b>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="pf-empty">
            Tháng này chưa có {type === "EXPENSE" ? "khoản chi" : "thu nhập"}.
          </p>
        )}
      </section>
      <section className="pf-card">
        <h3>Sáu tháng gần đây</h3>
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
        <Button
          variant="outline"
          onClick={() =>
            downloadCsv(transactionsCsv(s, selected.transactions), month)
          }
        >
          <Download size={16} /> Xuất CSV báo cáo
        </Button>
      </section>
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
