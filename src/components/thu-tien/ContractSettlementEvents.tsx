import { useMemo, useState, type ReactNode } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { normalizeVietnamese } from "@/lib/utils";
import "./contract-settlement.css";

const eventLabels = { sign: "Ký mới", renew: "Gia hạn", terminate: "Thanh lý", forfeit: "Bỏ cọc", reserve: "Giữ chỗ" } as const;
type EventType = keyof typeof eventLabels;
/** Presentation input: the authenticated event adapter owns deduplication, dates and link verification. */
export interface SettlementEventView {
  id: string;
  type: EventType;
  buildingId: string | null;
  roomName: string | null;
  customerName: string | null;
  sourceCode: string;
  businessDate: string | null;
  origin: "contract" | "reservation";
  staffName: string | null;
  links: { state: "ready"; values: readonly { id: string; label: string; amountLabel: string; statusLabel: string }[] }
    | { state: "unavailable"; reason: string };
}
export interface ContractSettlementEventsProps {
  /** Complete scoped set, before display pagination; do not pass only a database page. */
  rows: readonly SettlementEventView[];
  period: string;
  buildings: readonly { id: string; name: string }[];
  complete: boolean;
  loading?: boolean;
  fetching?: boolean;
  error?: string | null;
  navigation?: ReactNode;
  onSelect: (eventId: string) => void;
  onRefresh: () => void;
  onPeriodChange: (period: string) => void;
}
const dateLabel = (date: string | null) => date ? date.slice(0, 10).split("-").reverse().join("/") : "Chưa rõ ngày";

/** Opens an event identity only. Payment selection and all writers belong to the shared modal host. */
export function ContractSettlementEvents({ rows, period, buildings, complete, loading, fetching, error, navigation, onSelect, onRefresh, onPeriodChange }: ContractSettlementEventsProps) {
  const [search, setSearch] = useState("");
  const [building, setBuilding] = useState("all");
  const [withinPeriod, setWithinPeriod] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [origin, setOrigin] = useState("all");
  const [person, setPerson] = useState("all");
  const [kind, setKind] = useState<EventType | "all">("all");
  const [page, setPage] = useState(0);
  const buildingNames = useMemo(() => new Map(buildings.map(b => [b.id, b.name])), [buildings]);
  const people = useMemo(() => [...new Set(rows.map(row => row.staffName).filter((name): name is string => name !== null))].sort((a, b) => a.localeCompare(b, "vi")), [rows]);
  const base = useMemo(() => rows.filter(row => {
    if (building !== "all" && row.buildingId !== building) return false;
    if (origin !== "all" && row.origin !== origin) return false;
    if (person !== "all" && row.staffName !== person) return false;
    if (withinPeriod && row.businessDate !== null && row.businessDate.slice(0, 7) !== period) return false;
    const haystack = [row.sourceCode, row.roomName, row.customerName, row.staffName, row.buildingId ? buildingNames.get(row.buildingId) : null].join(" ");
    return !search.trim() || normalizeVietnamese(haystack).includes(normalizeVietnamese(search.trim()));
  }), [rows, building, origin, person, withinPeriod, period, search, buildingNames]);
  const shown = base.filter(row => kind === "all" || row.type === kind);
  const scopeUnknownDates = base.filter(row => row.businessDate === null).length;
  const unknownDates = shown.filter(row => row.businessDate === null).length;
  const resultLabel = withinPeriod && unknownDates > 0
    ? `${shown.length - unknownDates} lượt trong kỳ · ${unknownDates} lượt chưa rõ ngày`
    : `${shown.length} lượt biến động`;
  const footerLabel = complete
    ? withinPeriod && unknownDates > 0 ? resultLabel : `${shown.length} lượt trong phạm vi đang xem`
    : `Tạm tính trên ${shown.length} lượt đã tải${withinPeriod && unknownDates > 0 ? ` · ${resultLabel}` : ""}`;
  const countsFor = (type: EventType | "all") => {
    const matching = base.filter(row => type === "all" || row.type === type);
    const unassigned = withinPeriod ? matching.filter(row => row.businessDate === null).length : 0;
    return { count: matching.length - unassigned, unassigned };
  };
  const pageCount = Math.max(1, Math.ceil(shown.length / 50));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = shown.slice(currentPage * 50, (currentPage + 1) * 50);
  const selectKind = (value: EventType | "all") => { setKind(value); setPage(0); };
  function clearFilters() { setSearch(""); setBuilding("all"); setWithinPeriod(true); setOrigin("all"); setPerson("all"); selectKind("all"); }
  const [year, month] = period.split("-").map(Number);
  const priorPeriod = `${month === 1 ? year - 1 : year}-${String(month === 1 ? 12 : month - 1).padStart(2, "0")}`;

  return <div className="contract-settlement cs-payments cs-events">
    <div className="cs-viewbar">{navigation ?? <span className="cs-secondary">Biến động · theo ngày phát sinh nghiệp vụ</span>}</div>
    {loading && rows.length === 0 ? <div role="status" className="cs-surface cs-loading"><LoaderCircle className="animate-spin" size={22} aria-hidden="true" />Đang tải biến động…</div> : <>
      <div className="cs-stats" data-columns="5" aria-label="Lượt biến động theo loại, trước khi lọc loại">
        {(Object.keys(eventLabels) as EventType[]).map(type => {
          const counts = countsFor(type);
          return <button type="button" key={type} data-testid="event-stat" className="cs-stat cs-event-stat" aria-pressed={kind === type} onClick={() => selectKind(kind === type ? "all" : type)}>
            <span className="cs-stat-label">{eventLabels[type]}</span><div className="cs-stat-value">{counts.count}</div><div className="cs-stat-meta">{complete ? "" : "Tạm tính · "}lượt biến động</div>
            {counts.unassigned > 0 && <div className="cs-stat-meta">{counts.unassigned} chưa rõ ngày · chưa tính vào kỳ</div>}
          </button>;
        })}
      </div>
      {error && <div className="cs-error" role="alert"><strong>{error}</strong><span>Bộ lọc và dữ liệu đã tải vẫn được giữ.</span><button className="cs-button" onClick={onRefresh}>Thử lại</button></div>}
      <section className="cs-surface" aria-busy={fetching}>
        <div className="cs-filters">
          <label className="cs-search"><Search size={14} aria-hidden="true" /><input aria-label="Tìm biến động" placeholder="Tìm phòng, khách, hợp đồng…" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} /></label>
          <select aria-label="Tòa" className="cs-select" value={building} onChange={e => { setBuilding(e.target.value); setPage(0); }}><option value="all">Tất cả tòa</option>{buildings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          <select aria-label="Phạm vi kỳ" className="cs-select" value={withinPeriod ? period : "all"} onChange={e => { setWithinPeriod(e.target.value !== "all"); if (e.target.value !== "all") onPeriodChange(e.target.value); setPage(0); }}><option value="all">Mọi kỳ</option><option value={period}>Kỳ {period}</option><option value={priorPeriod}>Kỳ {priorPeriod}</option></select>
          <button className="cs-filter-button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>Bộ lọc</button>
        </div>
        {advanced && <div className="cs-advanced">
          <label>Nguồn<select className="cs-select" value={origin} onChange={e => { setOrigin(e.target.value); setPage(0); }}><option value="all">Tất cả nguồn</option><option value="contract">Hợp đồng</option><option value="reservation">Giữ chỗ</option></select></label>
          <label>Người phụ trách<select className="cs-select" value={person} onChange={e => { setPerson(e.target.value); setPage(0); }}><option value="all">Tất cả</option>{people.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
          <button className="cs-clear" onClick={clearFilters}>Bỏ bộ lọc</button>
        </div>}
        <div className="cs-chips">{(["all", ...Object.keys(eventLabels)] as (EventType | "all")[]).map(type => {
          const counts = countsFor(type);
          return <button className="cs-chip" key={type} aria-pressed={kind === type} onClick={() => selectKind(type)}>{type === "all" ? "Tất cả" : eventLabels[type]}<span className="cs-chip-count">{counts.count}</span>{counts.unassigned > 0 && <span className="cs-secondary"> + {counts.unassigned} chưa rõ ngày</span>}</button>;
        })}</div>
        <div className="cs-event-notice">Đếm theo lượt biến động, theo ngày phát sinh nghiệp vụ. Khoản chi liên kết dùng chung, không cộng lặp giữa giữ chỗ và ký hợp đồng.</div>
        {scopeUnknownDates > 0 && <div className="cs-notice">{scopeUnknownDates} biến động chưa rõ ngày; {withinPeriod ? "chưa tính vào số lượt trong kỳ. Chọn loại biến động tương ứng để đối chiếu." : "vẫn được giữ trong danh sách để đối chiếu."}</div>}
        <div className="cs-results"><span>{resultLabel}{fetching ? " · Đang cập nhật" : ""}</span><span className="cs-mono">{complete ? "Theo ngày nghiệp vụ" : "Chưa tải đủ dữ liệu"}</span></div>
        <div className="cs-table-scroll"><div role="table" aria-label="Danh sách biến động" className="cs-event-table">
          <div role="row" className="cs-grid-row cs-grid-head">{["Phòng · Khách", "Biến động", "Ngày phát sinh", "Khoản chi liên quan", ""].map((label, index) => <div role="columnheader" key={index}>{label}</div>)}</div>
          {pageRows.map(row => <div role="row" className="cs-grid-row" key={row.id}>
            <div role="cell"><button className="cs-row-open" onClick={() => onSelect(row.id)} aria-label={`Xem biến động ${row.id}`}><div className="cs-room">{[row.buildingId ? buildingNames.get(row.buildingId) : null, row.roomName].filter(Boolean).join(" · ") || "Chưa đọc được phòng"}</div><div className="cs-customer">{row.customerName ?? "Chưa có tên khách"}</div><div className="cs-code">{row.sourceCode}</div></button></div>
            <div role="cell"><span className="cs-badge">{eventLabels[row.type]}</span><div className="cs-secondary">{row.origin === "reservation" ? "Giữ chỗ" : "Hợp đồng"}</div></div>
            <div role="cell" className="cs-mono">{dateLabel(row.businessDate)}</div>
            <div role="cell">{row.links.state === "unavailable" ? <span className="cs-secondary">{row.links.reason}</span> : row.links.values.length === 0 ? <span className="cs-secondary">Không phát sinh chi</span> : row.links.values.map(link => <div key={link.id}>{link.label} <span className="cs-secondary">· <span className="cs-mono">{link.amountLabel}</span> · {link.statusLabel}</span></div>)}</div>
            <div role="cell" className="cs-row-action"><button className="cs-button" aria-label={`Xem hồ sơ ${row.id}`} onClick={() => onSelect(row.id)}>Xem hồ sơ</button></div>
          </div>)}
        </div></div>
        {shown.length === 0 && <div className="cs-empty"><strong>{complete ? "Không có biến động phù hợp" : "Chưa có dữ liệu để hiển thị"}</strong><p>{complete ? "Thử thay đổi kỳ hoặc bỏ bớt bộ lọc." : "Tải lại để xác định đầy đủ biến động."}</p><button className="cs-button" onClick={complete ? clearFilters : onRefresh}>{complete ? "Bỏ bộ lọc" : "Tải lại"}</button></div>}
        <div className="cs-footer"><span>{footerLabel}</span><span>Không cộng số tiền theo lượt biến động</span></div>
        {pageCount > 1 && <div className="cs-footer"><button className="cs-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Trước</button><span>Trang {currentPage + 1}/{pageCount} · Hiển thị toàn bộ {shown.length} dòng</span><button className="cs-button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Sau</button></div>}
      </section>
    </>}
  </div>;
}
