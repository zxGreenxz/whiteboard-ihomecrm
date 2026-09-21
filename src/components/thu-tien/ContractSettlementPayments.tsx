import { useMemo, useState, type ReactNode } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { normalizeVietnamese } from "@/lib/utils";
import {
  calculateSettlementTotals, detectSettlementIssues, getSettlementDisplayState,
  type SettlementDisplayCode, type SettlementKind, type SettlementRow, type SettlementSelection,
} from "@/lib/contractSettlement";
import "./contract-settlement.css";
import { classifySettlementPostingDate } from "@/lib/contractSettlementReader";

export interface ContractSettlementPaymentsProps {
  /** All scoped rows, not just a display page. Incomplete reads must set complete=false. */
  rows: readonly SettlementRow[];
  period: string;
  buildings: readonly { id: string; name: string }[];
  complete: boolean;
  loading?: boolean;
  fetching?: boolean;
  error?: string | null;
  navigation?: ReactNode;
  headerAction?: ReactNode;
  onSelect: (selection: SettlementSelection) => void;
  onRefresh: () => void;
  onPeriodChange: (period: string) => void;
}
type StatusFilter = "open" | "all" | "review" | "pending" | "payment" | "pending_payment" | "paid" | "source" | "cancelled" | "other";
const kinds: Record<SettlementKind, string> = { refund: "Hoàn khách", commission: "Hoa hồng", bonus: "Thưởng sale" };
const statusGroups: Record<Exclude<StatusFilter, "all" | "open">, SettlementDisplayCode[]> = {
  review: ["NEEDS_REVIEW"], pending: ["PENDING_APPROVAL"], payment: ["WAITING_PAYMENT"],
  pending_payment: ["PENDING_APPROVAL", "WAITING_PAYMENT"], paid: ["PAID"], source: ["NOT_CREATED"],
  cancelled: ["CANCELLED"], other: ["NON_CASH", "REVERSED", "NEEDS_RECONCILIATION", "UNAVAILABLE"],
};
const money = (value: number | null) => value === null ? "Chưa xác định" : `${value.toLocaleString("vi-VN")}đ`;
const compactMoney = (value: number) => value >= 1_000_000 ? `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(value / 1_000_000)} tr` : money(value);
const day = (value: string | null) => value ? value.slice(0, 10).split("-").reverse().join("/") : "Chưa rõ ngày";
function rowFacts(row: SettlementRow) {
  if (row.rowType === "source") return {
    buildingId: row.buildingId, roomName: row.roomName, contractNumber: row.contractNumber, customerName: row.customerName,
    recipient: row.recipient.name, bank: row.recipient.bankAccount, sourceDate: row.eventDate, postedDate: null,
    source: row.sourceRef, amount: row.basis.amount, code: "Chưa lập phiếu", sourceDateFallback: false,
  };
  if (row.snapshot.state === "unavailable") return {
    buildingId: null, roomName: null, contractNumber: null, customerName: null, recipient: null, bank: null,
    sourceDate: null, postedDate: null, source: row.sourceLink.state === "verified" ? row.sourceLink.sourceRef : null,
    amount: null, code: row.voucherCode, sourceDateFallback: false,
  };
  const v = row.snapshot.value;
  return {
    buildingId: v.buildingId, roomName: v.roomName, contractNumber: v.contractNumber, customerName: v.customerName,
    recipient: v.payerName, bank: v.receiveBankAccount, sourceDate: v.sourceEventDate ?? v.voucherDate,
    postedDate: v.postedOn, source: row.sourceLink.state === "verified" ? row.sourceLink.sourceRef : null,
    amount: v.totalAmount, code: v.code, sourceDateFallback: v.sourceEventDate === null,
  };
}
function matchesStatus(row: SettlementRow, status: StatusFilter) {
  const code = getSettlementDisplayState(row).code;
  if (status === "all") return true;
  if (status === "open") return code !== "PAID" && code !== "CANCELLED";
  return statusGroups[status].includes(code);
}
function previousPeriod(period: string) {
  const [year, month] = period.split("-").map(Number);
  return `${month === 1 ? year - 1 : year}-${String(month === 1 ? 12 : month - 1).padStart(2, "0")}`;
}

/** Presentation only. Every row action opens a stable target; no money command lives here. */
export function ContractSettlementPayments({ rows, period, buildings, complete, loading = false, fetching = false, error, navigation, headerAction, onSelect, onRefresh, onPeriodChange }: ContractSettlementPaymentsProps) {
  const [merged, setMerged] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [search, setSearch] = useState("");
  const [building, setBuilding] = useState("all");
  const [withinPeriod, setWithinPeriod] = useState(false);
  const [dateBasis, setDateBasis] = useState<"business" | "posting">("business");
  const [kind, setKind] = useState<SettlementKind | "all">("all");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [origin, setOrigin] = useState("all");
  const [person, setPerson] = useState("all");
  const [issue, setIssue] = useState("all");
  const [page, setPage] = useState(0);
  const buildingNames = useMemo(() => new Map(buildings.map(b => [b.id, b.name])), [buildings]);
  const people = useMemo(() => [...new Set(rows.map(row => rowFacts(row).recipient).filter((name): name is string => name !== null))].sort((a, b) => a.localeCompare(b, "vi")), [rows]);
  const base = useMemo(() => rows.filter(row => {
    const f = rowFacts(row);
    if (building !== "all" && f.buildingId !== building) return false;
    if (person !== "all" && f.recipient !== person) return false;
    const isReservation = f.source?.kind === "reservation_refund" || f.source?.kind === "sale_deposit";
    if (origin !== "all" && (f.source === null || (origin === "reservation") !== isReservation)) return false;
    const postingDate = dateBasis === "posting" ? classifySettlementPostingDate(row) : null;
    if (postingDate?.state === "known_none") return false;
    const date = postingDate?.state === "known_paid" ? postingDate.postedOn : dateBasis === "posting" ? null : f.sourceDate;
    if (withinPeriod && date !== null && date.slice(0, 7) !== period) return false;
    if (issue === "yes" && detectSettlementIssues(row, period).length === 0) return false;
    if (search.trim()) {
      const haystack = [f.code, f.contractNumber, f.roomName, f.customerName, f.recipient, f.buildingId ? buildingNames.get(f.buildingId) : null].join(" ");
      if (!normalizeVietnamese(haystack).includes(normalizeVietnamese(search.trim()))) return false;
    }
    return true;
  }), [rows, building, person, origin, dateBasis, withinPeriod, period, issue, search, buildingNames]);
  const metricRows = base.filter(row => kind === "all" || row.settlementKind === kind);
  const unknownPostingCount = dateBasis === "posting" ? metricRows.filter(row => classifySettlementPostingDate(row).state === "unverified").length : 0;
  const amountsVerified = complete && unknownPostingCount === 0 && !metricRows.some(row => row.rowType === "voucher" && row.snapshot.state !== "ready");
  const shown = metricRows.filter(row => matchesStatus(row, status));
  const totals = calculateSettlementTotals(shown);
  const reviewRows = metricRows.filter(row => matchesStatus(row, "review"));
  const pendingRows = metricRows.filter(row => matchesStatus(row, "pending"));
  const paymentRows = metricRows.filter(row => matchesStatus(row, "payment"));
  const paidRows = metricRows.filter(row => matchesStatus(row, "paid"));
  const oldRows = shown.filter(row => detectSettlementIssues(row, period).includes("OLD_PERIOD"));
  const unknownCount = shown.filter(row => row.rowType === "voucher" && row.snapshot.state === "unavailable").length;
  const pageCount = Math.max(1, Math.ceil(shown.length / 50));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = shown.slice(currentPage * 50, (currentPage + 1) * 50);
  const sum = (list: SettlementRow[]) => calculateSettlementTotals(list).displayedVoucherAmount;
  const paidTotal = calculateSettlementTotals(paidRows).effectiveNetPaid;
  const cards = [
    { key: "review" as const, label: "Cần rà soát", value: String(reviewRows.length), meta: "phiếu cần kiểm tra", color: "#d6453f" },
    ...(merged ? [{ key: "pending_payment" as const, label: "Chờ Duyệt và Chi", value: compactMoney(sum([...pendingRows, ...paymentRows])), meta: `${pendingRows.length} chờ duyệt · ${paymentRows.length} chờ chi · ${money(sum([...pendingRows, ...paymentRows]))}`, color: "#c97a10" }]
      : [{ key: "pending" as const, label: "Chờ duyệt", value: compactMoney(sum(pendingRows)), meta: `${pendingRows.length} phiếu · ${money(sum(pendingRows))}`, color: "#c97a10" },
        { key: "payment" as const, label: "Chờ chi", value: compactMoney(sum(paymentRows)), meta: `${paymentRows.length} phiếu · ${money(sum(paymentRows))}`, color: "#1f7a52" }]),
    { key: "paid" as const, label: "Đã chi", value: compactMoney(paidTotal), meta: `${paidRows.length} phiếu · ${money(paidTotal)}`, color: "#1f9d57" },
  ];
  const displayCards = cards.map(card => amountsVerified || card.key === "review" ? card : {
    ...card, value: "Chưa xác định", meta: "Chưa xác minh được tổng tiền",
  });
  function clearFilters() {
    setSearch(""); setBuilding("all"); setWithinPeriod(false); setDateBasis("business"); setKind("all");
    setStatus("open"); setOrigin("all"); setPerson("all"); setIssue("all"); setPage(0);
  }
  const selectStatus = (next: StatusFilter) => { setStatus(next); setPage(0); };
  const selectRow = (row: SettlementRow) => onSelect(row.rowType === "voucher" ? { kind: "voucher", voucherId: row.voucherId } : { kind: "source", sourceRef: row.sourceRef });

  return <div className="contract-settlement cs-payments">
    <div className="cs-viewbar cs-payments-viewbar">
      {navigation ?? <span className="cs-secondary">{withinPeriod ? `Kỳ ${period} · ${dateBasis === "posting" ? "theo ngày ghi chi" : "theo ngày nghiệp vụ"}` : "Mọi kỳ · gồm tồn cũ"}</span>}
      <div className="cs-view-actions">{headerAction}<label className="cs-merge"><input type="checkbox" checked={merged} onChange={() => { setMerged(!merged); if (["pending", "payment", "pending_payment"].includes(status)) selectStatus("open"); }} />Gộp Chờ duyệt và Chi</label></div>
    </div>
    {loading && rows.length === 0 ? <div role="status" aria-live="polite">
      <div className="cs-stats" data-columns={merged ? "3" : "4"} aria-hidden="true">{Array.from({ length: merged ? 3 : 4 }, (_, index) => <div className="cs-stat cs-skeleton" key={index}><div /><div /><div /></div>)}</div>
      <div className="cs-surface cs-loading"><LoaderCircle size={22} className="animate-spin" aria-hidden="true" /><span>Đang tải khoản chi…</span></div>
    </div> : <>
      <div className="cs-stats" data-columns={merged ? "3" : "4"} aria-label="Thống kê theo bộ lọc, trước khi lọc trạng thái">
        {displayCards.map(card => <button key={card.key} type="button" data-testid="settlement-stat" className="cs-stat" aria-pressed={status === card.key} onClick={() => selectStatus(status === card.key ? "open" : card.key)}>
          <span className="cs-stat-label"><span className="cs-dot" style={{ background: card.color }} />{card.label}</span>
          <div className="cs-stat-value">{card.value}</div><div className="cs-stat-meta">{complete ? "" : "Tạm tính · "}{card.meta}</div>
          <span className="cs-stat-cta">{status === card.key ? "Đang lọc" : "Lọc"}</span>
        </button>)}
      </div>
      {error && <div className="cs-error" role="alert"><strong>{error}</strong><span>Dữ liệu đã tải được giữ lại. Hãy tải lại trước khi xử lý phiếu.</span><button className="cs-button" onClick={onRefresh}>Thử lại</button></div>}
      <section className="cs-surface" aria-busy={fetching}>
        <div className="cs-filters">
          <label className="cs-search"><Search size={14} aria-hidden="true" /><input aria-label="Tìm khoản chi" placeholder="Tìm phòng, khách, hợp đồng, phiếu…" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
          <select className="cs-select" aria-label="Tòa" value={building} onChange={event => { setBuilding(event.target.value); setPage(0); }}><option value="all">Tất cả tòa</option>{buildings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          <select className="cs-select" aria-label="Phạm vi kỳ" value={withinPeriod ? period : "all"} onChange={event => { const value = event.target.value; setWithinPeriod(value !== "all"); if (value !== "all") onPeriodChange(value); setPage(0); }}>
            <option value="all">Mọi kỳ · gồm tồn cũ</option><option value={period}>Kỳ {period}</option><option value={previousPeriod(period)}>Kỳ {previousPeriod(period)}</option>
          </select>
          <button className="cs-filter-button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>Bộ lọc</button>
        </div>
        {advanced && <div className="cs-advanced">
          <label>Nguồn<select className="cs-select" value={origin} onChange={event => { setOrigin(event.target.value); setPage(0); }}><option value="all">Tất cả nguồn</option><option value="contract">Hợp đồng</option><option value="reservation">Giữ chỗ</option></select></label>
          <label>Người nhận<select className="cs-select" value={person} onChange={event => { setPerson(event.target.value); setPage(0); }}><option value="all">Tất cả</option>{people.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
          <label>Trạng thái<select className="cs-select" value={status} onChange={event => selectStatus(event.target.value as StatusFilter)}>
            <option value="open">Cần xử lý</option><option value="all">Tất cả trạng thái</option><option value="source">Chưa lập phiếu</option><option value="review">Cần rà soát</option><option value="pending">Chờ duyệt</option><option value="payment">Đã duyệt · chờ chi</option><option value="pending_payment">Chờ duyệt và chi</option><option value="paid">Đã chi</option><option value="cancelled">Đã hủy</option><option value="other">Trạng thái khác / cần đối chiếu</option>
          </select></label>
          <label>Vướng mắc<select className="cs-select" value={issue} onChange={event => { setIssue(event.target.value); setPage(0); }}><option value="all">Tất cả</option><option value="yes">Có vấn đề cần rà soát</option></select></label>
          <label>Theo ngày<select className="cs-select" value={dateBasis} onChange={event => { setDateBasis(event.target.value === "posting" ? "posting" : "business"); setPage(0); }}><option value="business">Ngày nghiệp vụ</option><option value="posting">Ngày ghi chi</option></select></label>
          <button className="cs-clear" onClick={clearFilters}>Bỏ bộ lọc</button>
        </div>}
        <div className="cs-chips">
          {(["all", "refund", "commission", "bonus"] as const).map(k => <button key={k} className="cs-chip" aria-pressed={kind === k} onClick={() => { setKind(k); setPage(0); }}>{k === "all" ? "Tất cả" : kinds[k]}<span className="cs-chip-count">{base.filter(row => (k === "all" || row.settlementKind === k) && matchesStatus(row, status)).length}</span></button>)}
          <span className="cs-spacer" /><button className="cs-chip" aria-pressed={status === "open"} onClick={() => selectStatus("open")}>Cần xử lý</button><button className="cs-chip" aria-pressed={status === "paid"} onClick={() => selectStatus("paid")}>Đã chi</button>
        </div>
        {oldRows.length > 0 && <div className="cs-notice"><b className="cs-mono">TỒN</b><span>Có <b>{oldRows.length} khoản tồn kỳ trước</b>. Vẫn được giữ trong danh sách cần xử lý.</span></div>}
        {unknownPostingCount > 0 && <div className="cs-notice">{unknownPostingCount} phiếu chưa xác minh được ngày ghi chi. Giữ lại để đối chiếu; tổng tiền chưa xác định.</div>}
        <div className="cs-results"><span>{shown.length} khoản{fetching ? " · Đang cập nhật, đang hiển thị dữ liệu lần trước" : ""}{!complete ? " · Chưa tải đủ dữ liệu" : ""}</span><span className="cs-mono">{totals.sourceCount > 0 ? `${totals.sourceCount} hồ sơ chưa lập phiếu` : "Danh sách chi tiết"}</span></div>
        <div className="cs-table-scroll">
          <div role="table" aria-label="Danh sách khoản chi" className="cs-payment-table">
            <div role="row" className="cs-grid-row cs-grid-head">{["Phòng · Khách", "Khoản chi", "Người nhận", "Số tiền", "Trạng thái", ""].map((label, index) => <div key={index} role="columnheader" className={index === 3 ? "cs-money-cell" : undefined}>{label}</div>)}</div>
            {pageRows.map(row => {
              const f = rowFacts(row), state = getSettlementDisplayState(row);
              const issueCodes = detectSettlementIssues(row, period);
              const roomLabel = [f.buildingId ? buildingNames.get(f.buildingId) : null, f.roomName].filter(Boolean).join(" · ") || "Chưa đọc được phòng";
              const codeLine = [f.contractNumber, f.code].filter(Boolean).join(" · ");
              return <div role="row" className="cs-grid-row" key={row.rowKey}>
                <div role="cell"><button className="cs-row-open" aria-label={row.rowType === "source" ? `Xem nguồn ${f.contractNumber ?? row.rowKey}` : `Xem ${row.voucherCode}`} onClick={() => selectRow(row)}><div className="cs-room">{roomLabel}</div><div className="cs-customer">{f.customerName ?? "Chưa có tên khách"}</div><div className="cs-code">{codeLine}</div></button></div>
                <div role="cell"><strong>{kinds[row.settlementKind]}</strong><div className="cs-secondary">{f.source === null ? "Chưa xác minh nguồn" : f.source.kind === "reservation_refund" || f.source.kind === "sale_deposit" ? "Từ giữ chỗ" : "Từ hợp đồng"} · {day(f.sourceDate)}</div>{f.sourceDateFallback && <div className="cs-secondary">Theo ngày phiếu</div>}{issueCodes.includes("OLD_PERIOD") && <span className="cs-badge" data-tone="amber">Tồn kỳ cũ</span>}</div>
                <div role="cell">{f.recipient ?? "Chưa có người nhận"}<div className="cs-secondary">{f.bank ? "Đã có thông tin nhận" : "Chưa có tài khoản"}</div></div>
                <div role="cell" className="cs-money-cell"><div className="cs-amount">{money(f.amount)}</div><div className="cs-secondary">{row.rowType === "source" ? "Căn cứ dự kiến" : "Số trên phiếu"}</div>{state.code === "PAID" && row.rowType === "voucher" && row.snapshot.state === "ready" && <div className="cs-secondary">Thực chi: {money(row.snapshot.value.effectiveNetPaid)} · {day(f.postedDate)}</div>}</div>
                <div role="cell"><span className="cs-badge" data-tone={state.code === "PAID" ? "green" : ["NEEDS_REVIEW", "NEEDS_RECONCILIATION", "UNAVAILABLE"].includes(state.code) ? "red" : "amber"}>{state.label}</span>{issueCodes.includes("AMOUNT_MISMATCH") && <div className="cs-issue">Lệch căn cứ</div>}{row.rowType === "voucher" && row.snapshot.state === "unavailable" && <div className="cs-secondary">Mở hồ sơ để tải lại</div>}</div>
                <div role="cell" className="cs-row-action"><button className="cs-button" aria-label={row.rowType === "voucher" ? `Xử lý ${row.voucherCode}` : `Xử lý nguồn ${f.contractNumber ?? row.rowKey}`} onClick={() => selectRow(row)}>{state.code === "PAID" || state.code === "CANCELLED" ? "Xem chi tiết" : "Xử lý"}</button></div>
              </div>;
            })}
          </div>
        </div>
        {shown.length === 0 && <div className="cs-empty"><strong>{complete ? "Không có khoản chi phù hợp" : "Chưa có dữ liệu để hiển thị"}</strong><p>{complete ? "Thử thay đổi kỳ hoặc bỏ bớt bộ lọc." : "Hãy tải lại để xác định đầy đủ các khoản chi."}</p><button className="cs-button" onClick={complete ? clearFilters : onRefresh}>{complete ? "Bỏ bộ lọc" : "Tải lại"}</button></div>}
        <div className="cs-footer"><span>{complete ? `${shown.length} khoản trong phạm vi đang xem` : `Tạm tính trên ${shown.length} dòng đã tải`}{unknownCount > 0 ? ` · ${unknownCount} phiếu chưa đọc được số tiền` : ""}</span><span className="cs-mono">Tổng trên phiếu: {money(amountsVerified ? totals.displayedVoucherAmount : null)}</span></div>
        {pageCount > 1 && <div className="cs-footer"><button className="cs-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Trước</button><span>Trang {currentPage + 1}/{pageCount} · Tổng tính trên toàn bộ {shown.length} khoản</span><button className="cs-button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Sau</button></div>}
      </section>
    </>}
  </div>;
}
