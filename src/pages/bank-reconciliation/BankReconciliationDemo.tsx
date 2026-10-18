import { useMemo, useState, type ReactNode } from 'react';
import { Activity, ArrowDownLeft, ArrowUpRight, ArrowRight, Building2, Check, CheckCheck, ChevronLeft, ChevronRight, CircleHelp, Download, FileText, Filter, History, Inbox, Link2, ListFilter, RotateCcw, Search, ShieldCheck, Wallet, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cashbooks, createDemoState } from '@/lib/bank-reconciliation/demoFixtures';
import { applyDemoCommand, csvCell, findMatches, money, normalize, outstanding, statusLabels, transactionStatus, type BankTransaction, type Candidate, type Command, type Status } from '@/lib/bank-reconciliation/demoModel';
import './bankReconciliation.css';
import SourceConfiguration from './SourceConfiguration';
import { channelLabels, identityLabels } from '@/lib/bank-reconciliation/sourceRules';

type View = 'transactions' | 'invoices' | 'sources' | 'history' | 'guide';
type Group = 'all' | 'pending' | 'suggested' | 'matched' | 'review' | 'other';
interface Filters { query: string; book: string; source: string; bank: string; direction: string; from: string; to: string; min: string; max: string; exact: string; status: string; building: string; basis: string; invoiceId: string }
const emptyFilters: Filters = { query: '', book: '', source: '', bank: '', direction: '', from: '', to: '', min: '', max: '', exact: '', status: '', building: '', basis: 'transaction', invoiceId: '' };
const time = (s: string) => new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(s));
const titles: Record<View, string> = { transactions: 'Biến động ngân hàng', invoices: 'Hóa đơn cần đối chiếu', sources: 'Nguồn kết nối', history: 'Lịch sử xử lý', guide: 'Hướng dẫn sử dụng' };
const groups: { id: Group; label: string }[] = [{ id: 'all', label: 'Tất cả' }, { id: 'pending', label: 'Cần khớp' }, { id: 'suggested', label: 'Có gợi ý' }, { id: 'matched', label: 'Đã khớp' }, { id: 'review', label: 'Cần kiểm tra' }, { id: 'other', label: 'Khoản khác' }];
const matchesGroup = (g: Group, s: Status, t: BankTransaction) => g === 'all' || (g === 'pending' ? t.direction === 'in' && !['matched', 'other'].includes(s) : g === 'suggested' ? ['suggested', 'existing'].includes(s) : g === s);
const bookName = (id: string | null) => cashbooks.find(x => x.id === id)?.name ?? 'Chưa xác định sổ';
function Pill({ status }: { status: Status }) { return <span className={`br-pill br-${status}`}><span />{statusLabels[status]}</span>; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="br-field"><span>{label}</span>{children}</label>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <div className="br-empty"><Inbox size={32} /><h3>{title}</h3><p>{detail}</p></div>; }
function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (s: string) => void; options: { value: string; label: string }[] }) {
  return <Field label={label}><select value={value} onChange={e => onChange(e.target.value)}><option value="">Tất cả</option>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>;
}

export default function BankReconciliationDemo() {
  const [state, setState] = useState(createDemoState);
  const [view, setView] = useState<View>('transactions');
  const [filters, setFilters] = useState<Filters>({ ...emptyFilters });
  const [group, setGroup] = useState<Group>('all');
  const [advanced, setAdvanced] = useState(false);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const [preview, setPreview] = useState<Command | null>(null);
  const [reason, setReason] = useState('');
  const [showExcluded, setShowExcluded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const selected = state.transactions.find(t => t.id === selectedId);
  const selectedMatches = selected ? findMatches(state, selected) : null;
  const analyzed = useMemo(() => state.transactions.map(t => ({ t, status: transactionStatus(state, t), match: findMatches(state, t) })), [state]);
  const allSources = [...new Set(state.transactions.flatMap(t => t.sources))];
  const filterError = filters.from && filters.to && filters.from > filters.to ? 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.'
    : filters.min && filters.max && Number(filters.min) > Number(filters.max) ? 'Số tiền đến phải lớn hơn hoặc bằng số tiền từ.' : '';
  const baseRows = analyzed.filter(({ t, status, match }) => {
    const linked = state.invoices.find(i => i.id === t.link?.invoiceId);
    const related = linked ? [linked] : [...match.candidates.map(c => c.invoice), ...state.invoices.filter(i => match.receipts.some(r => r.invoiceId === i.id))];
    const book = cashbooks.find(b => b.id === t.book);
    const date = (filters.basis === 'received' ? t.receivedAt : t.at).slice(0, 10);
    const searchText = [t.id, t.reference, t.description, book?.name, ...t.sources, ...related.flatMap(i => [i.number, i.building, i.room, ...i.customers])].join(' ');
    return !filterError && (!filters.query || normalize(searchText).includes(normalize(filters.query)))
      && (!filters.book || (filters.book === 'unknown' ? !t.book : t.book === filters.book))
      && (!filters.bank || book?.bank === filters.bank) && (!filters.source || t.sources.includes(filters.source))
      && (!filters.direction || t.direction === filters.direction) && (!filters.status || status === filters.status)
      && (!filters.from || date >= filters.from) && (!filters.to || date <= filters.to)
      && (!filters.min || t.amount >= Number(filters.min)) && (!filters.max || t.amount <= Number(filters.max))
      && (!filters.exact || t.amount === Number(filters.exact))
      && (!filters.building || related.some(i => i.building === filters.building))
      && (!filters.invoiceId || related.some(i => i.id === filters.invoiceId));
  }).sort((a, b) => b.t.at.localeCompare(a.t.at));
  const rows = baseRows.filter(r => matchesGroup(group, r.status, r.t));
  const pageCount = Math.max(1, Math.ceil(rows.length / 8)), currentPage = Math.min(page, pageCount - 1);
  const displayRows = rows.slice(currentPage * 8, currentPage * 8 + 8);
  const totalIn = rows.filter(r => r.t.direction === 'in').reduce((s, r) => s + r.t.amount, 0);
  const totalOut = rows.filter(r => r.t.direction === 'out').reduce((s, r) => s + r.t.amount, 0);
  const pending = rows.filter(r => r.t.direction === 'in' && !r.t.link && r.status !== 'other');
  const reviews = rows.filter(r => r.status === 'review').length;
  const changeFilter = (key: keyof Filters, value: string) => { setFilters(f => ({ ...f, [key]: value })); setPage(0); };
  function open(t: BankTransaction) { setSelectedId(t.id); setFailure(''); setShowExcluded(false); setShowAll(false); setReason(''); }
  function choose(command: Command) { setPreview(command); setFailure(''); }
  function confirm() {
    if (!preview) return;
    try {
      const next = applyDemoCommand(state, preview, new Date().toISOString());
      setState(next); setPreview(null); setFailure(''); setReason('');
      setNotice(`${next.audit[0]?.action ?? 'Đã xử lý'} thành công. Chỉ dữ liệu DEMO được cập nhật.`);
    } catch (error) { setFailure(error instanceof Error ? error.message : 'Chưa hoàn tất thao tác.'); }
  }
  function exportCsv() {
    const data = [['Mã giao dịch', 'Giờ giao dịch', 'Sổ nhận', 'Chiều', 'Số tiền', 'Nội dung', 'Nguồn', 'Trạng thái', 'Hóa đơn đã khớp'], ...rows.map(({ t, status }) => [t.id, time(t.at), bookName(t.book), t.direction === 'in' ? 'Vào' : 'Ra', t.amount, t.description, t.sources.join(' + '), statusLabels[status], state.invoices.find(i => i.id === t.link?.invoiceId)?.number ?? ''])];
    const url = URL.createObjectURL(new Blob(['\uFEFF', data.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a'); a.href = url; a.download = 'DEMO-bien-dong-ngan-hang.csv'; a.click(); URL.revokeObjectURL(url);
    setNotice(`Đã xuất ${rows.length} giao dịch theo toàn bộ bộ lọc hiện tại.`);
  }
  const previewInvoice = preview?.type === 'collect' ? state.invoices.find(i => i.id === preview.invoiceId) : null;
  const previewTransaction = preview ? state.transactions.find(t => t.id === preview.transactionId) : null;

  return <div className="br-demo">
    <aside className="br-sidebar">
      <a className="br-brand" href="/src/pages/bank-reconciliation/local.html"><span><Building2 size={23} /></span><strong>iHome<span>CRM</span></strong></a>
      <div className="br-workspace"><Building2 size={18} /><div><strong>Không gian DEMO</strong><small>Quản lý nhà cho thuê</small></div></div>
      <p className="br-nav-label">TÀI CHÍNH</p>
      <nav aria-label="Điều hướng demo">{([{ id: 'transactions', icon: Activity, label: 'Biến động ngân hàng' }, { id: 'invoices', icon: FileText, label: 'Hóa đơn đối chiếu' }, { id: 'sources', icon: Link2, label: 'Nguồn kết nối' }, { id: 'history', icon: History, label: 'Lịch sử xử lý' }] as const).map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}><item.icon size={18} /><span>{item.label}</span>{item.id === 'transactions' && <small>{state.transactions.length}</small>}</button>)}</nav>
      <div className="br-sidebar-bottom"><div className="br-rule"><ShieldCheck size={18} /><strong>Quản lý xác nhận</strong><p>Chỉ gợi ý khi lệch tối đa 10.000đ. Tự động thanh toán đang tắt.</p></div><button className={view === 'guide' ? 'br-help active' : 'br-help'} onClick={() => setView('guide')}><CircleHelp size={18} />Hướng dẫn sử dụng</button><div className="br-user"><span>QL</span><div><strong>Quản lý DEMO</strong><small>Phiên thử trên local</small></div></div></div>
    </aside>
    <div className="br-work">
      <div className="br-topbar"><span>Tài chính <ChevronRight size={14} /> <strong>{titles[view]}</strong></span><span className="br-local"><i />Local · dữ liệu mẫu</span></div>
      <main className="br-main">
        <header className="br-heading"><div><p className="br-eyebrow">ĐỐI SOÁT THU TIỀN</p><h1>{titles[view]}</h1><p>Mỗi khoản tiền, đúng sổ nhận, đúng hóa đơn.</p></div><div className="br-actions"><button className="br-button" onClick={() => setView('guide')}><CircleHelp size={16} />Hướng dẫn</button><button className="br-button" onClick={() => setResetOpen(true)}><RotateCcw size={16} />Đặt lại demo</button>{view === 'transactions' && <button className="br-button br-primary" onClick={exportCsv} disabled={!!filterError || !rows.length}><Download size={16} />Xuất CSV</button>}</div></header>
        <div className="br-demo-note"><ShieldCheck size={17} /><span><strong>Bản trải nghiệm · 17/10/2026</strong> — Tất cả giao dịch và khách đều là dữ liệu mẫu. Thao tác lưu trong phiên này; tải lại trang sẽ đặt lại.</span></div>
        {notice && <div className="br-notice" role="status"><CheckCheck size={18} /><span>{notice}</span><button aria-label="Đóng thông báo" onClick={() => setNotice('')}><X size={16} /></button></div>}
        {view === 'transactions' && <>
          <section className="br-stats" aria-label="Số liệu theo bộ lọc"><Stat label="Tổng tiền vào" value={money(totalIn)} detail={`${rows.filter(r => r.t.direction === 'in').length} khoản nhận`} icon={<ArrowDownLeft />} tone="green" /><Stat label="Tổng tiền ra" value={money(totalOut)} detail={`${rows.filter(r => r.t.direction === 'out').length} khoản chi`} icon={<ArrowUpRight />} /><Stat label="Tiền vào cần khớp" value={money(pending.reduce((s, r) => s + r.t.amount, 0))} detail={`${pending.length} khoản đang chờ đối chiếu`} icon={<Wallet />} tone="amber" /><Stat label="Cần kiểm tra" value={`${reviews} khoản`} detail="Thiếu sổ, nghi trùng hoặc dữ liệu" icon={<ListFilter />} /></section>
          <section className="br-table-card" aria-label="Danh sách biến động ngân hàng">
            <div className="br-tabs" role="group" aria-label="Nhóm giao dịch">{groups.map(g => <button className={group === g.id ? 'active' : ''} key={g.id} onClick={() => { setGroup(g.id); setPage(0); }}>{g.label}<span>{baseRows.filter(r => matchesGroup(g.id, r.status, r.t)).length}</span></button>)}</div>
            <div className="br-filters"><label className="br-search"><Search size={17} /><input aria-label="Tìm giao dịch" placeholder="Nội dung, mã giao dịch, phòng, tên khách…" value={filters.query} onChange={e => changeFilter('query', e.target.value)} /></label><select aria-label="Lọc sổ ngân hàng" value={filters.book} onChange={e => changeFilter('book', e.target.value)}><option value="">Tất cả sổ ngân hàng</option>{cashbooks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}<option value="unknown">Chưa xác định sổ</option></select><select aria-label="Chiều tiền" value={filters.direction} onChange={e => changeFilter('direction', e.target.value)}><option value="">Tiền vào & tiền ra</option><option value="in">Tiền vào</option><option value="out">Tiền ra</option></select><button className={`br-button ${advanced ? 'br-filter-active' : ''}`} aria-expanded={advanced} onClick={() => setAdvanced(v => !v)}><Filter size={16} />Bộ lọc</button></div>
            {advanced && <div className="br-advanced">
              <Field label="Từ ngày"><input type="date" value={filters.from} onChange={e => changeFilter('from', e.target.value)} /></Field><Field label="Đến ngày"><input type="date" value={filters.to} onChange={e => changeFilter('to', e.target.value)} /></Field>
              <Field label="Mốc thời gian"><select value={filters.basis} onChange={e => changeFilter('basis', e.target.value)}><option value="transaction">Giờ giao dịch</option><option value="received">Giờ nhận tin</option></select></Field>
              <FilterSelect label="Ngân hàng" value={filters.bank} onChange={v => changeFilter('bank', v)} options={[...new Set(cashbooks.map(b => b.bank))].map(bank => ({ value: bank, label: bank }))} />
              <FilterSelect label="Nguồn báo tin" value={filters.source} onChange={v => changeFilter('source', v)} options={allSources.map(s => ({ value: s, label: s }))} />
              <FilterSelect label="Trạng thái xử lý" value={filters.status} onChange={v => changeFilter('status', v)} options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))} />
              <FilterSelect label="Tòa đã khớp / có gợi ý" value={filters.building} onChange={v => changeFilter('building', v)} options={[...new Set(state.invoices.map(i => i.building))].map(s => ({ value: s, label: s }))} />
              <Field label="Số tiền chính xác (đ)"><input type="number" min="0" step="1" value={filters.exact} onChange={e => changeFilter('exact', e.target.value)} placeholder="Ví dụ: 3000000" /></Field>
              <Field label="Số tiền từ (đ)"><input type="number" min="0" value={filters.min} onChange={e => changeFilter('min', e.target.value)} /></Field><Field label="Số tiền đến (đ)"><input type="number" min="0" value={filters.max} onChange={e => changeFilter('max', e.target.value)} /></Field>
              <button className="br-button" onClick={() => { setFilters({ ...emptyFilters }); setPage(0); }}>Xóa bộ lọc</button>
            </div>}
            {filters.invoiceId && <div className="br-context">Đang dò ngược cho {state.invoices.find(i => i.id === filters.invoiceId)?.number}<button onClick={() => changeFilter('invoiceId', '')}>Bỏ điều kiện</button></div>}
            {filterError && <p role="alert" className="br-error">{filterError}</p>}
            <div className="br-table-caption"><span><strong>{rows.length}</strong> giao dịch · Giờ Việt Nam</span><span>Một khoản nhiều tin chỉ tính một lần · Gợi ý ±10.000đ</span></div>
            {!rows.length ? <Empty title="Không có giao dịch phù hợp" detail="Thử xóa bộ lọc hoặc chọn nhóm Tất cả. Không có dữ liệu khác ngoài bộ mẫu này." /> : <table className="br-table"><thead><tr><th>Giao dịch / nội dung</th><th>Số tiền</th><th>Sổ nhận & nguồn</th><th>Đối chiếu hóa đơn</th><th>Trạng thái</th><th><span className="sr-only">Mở chi tiết</span></th></tr></thead><tbody>{displayRows.map(({ t, status, match }) => {
              const c = match.candidates.find(candidate => candidate.invoice.id === filters.invoiceId)
                ?? match.candidates.find(candidate => !!filters.building && candidate.invoice.building === filters.building)
                ?? match.candidates[0];
              const linked = state.invoices.find(i => i.id === t.link?.invoiceId), b = cashbooks.find(x => x.id === t.book);
              return <tr key={t.id}><td><div className="br-transaction"><span className={`br-direction ${t.direction}`} >{t.direction === 'in' ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}</span><div><button className="br-row-link" onClick={() => open(t)}>{t.description}</button><small>{time(t.at)} · {t.id}</small></div></div></td><td className={`br-amount ${t.direction}`}>{t.direction === 'in' ? '+' : '−'}{money(t.amount)}</td><td><strong className={!b ? 'br-amber-text' : ''}>{bookName(t.book)}</strong><small>{b ? `${b.bank} · ${b.account}` : 'Cần xác minh tài khoản'}</small><span className="br-source">{t.sources[0]?.split(' · ')[0]}{t.sources.length > 1 ? ` + ${t.sources.length - 1} nguồn` : ''}</span></td><td>{linked ? <><strong>{linked.number}</strong><small>{linked.building} · P.{linked.room}</small></> : match.receipts.length ? <><strong>Đối chiếu khoản thu cũ</strong><small>Không tạo lần thu mới</small></> : c ? <><strong>{c.invoice.building} · P.{c.invoice.room}</strong><small>{c.delta === 0 ? 'Khớp số còn phải thu' : `${c.delta < 0 ? 'Thiếu' : 'Dư'} ${money(Math.abs(c.delta))}`}</small>{match.candidates.length > 1 && <span className="br-small-note">{match.candidates.length} hóa đơn phù hợp</span>}</> : <small>{t.issue || t.routingIssue ? 'Kiểm tra dữ liệu trước' : status === 'other' ? 'Ngoài luồng thu hóa đơn' : 'Chưa có trong ngưỡng'}</small>}</td><td><Pill status={status} /></td><td><button className="br-icon-button" aria-label={`Xem ${t.id}`} onClick={() => open(t)}><ChevronRight size={18} /></button></td></tr>;
            })}</tbody></table>}
            <div className="br-pagination"><span>{rows.length ? `${currentPage * 8 + 1}–${Math.min((currentPage + 1) * 8, rows.length)}` : '0'} / {rows.length} giao dịch</span><div><button className="br-icon-button" aria-label="Trang trước" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={17} /></button><span>Trang {currentPage + 1} / {pageCount}</span><button className="br-icon-button" aria-label="Trang sau" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}><ChevronRight size={17} /></button></div></div>
          </section><p className="br-footnote">Số liệu tính trên toàn bộ kết quả đang lọc, không chỉ trang đang xem. Khoản nghi trùng còn giữ riêng và chưa được xác nhận.</p>
        </>}
        {view === 'invoices' && <section className="br-table-card"><div className="br-section-heading"><h2>Từ hóa đơn, tìm lại khoản tiền</h2><p>So số còn phải thu, đúng sổ nhận và lệch tối đa 10.000đ.</p></div><div className="br-invoice-grid">{state.invoices.map(i => {
          const found = analyzed.filter(r => r.match.candidates.some(c => c.invoice.id === i.id) || r.match.receipts.some(receipt => receipt.invoiceId === i.id) || r.t.link?.invoiceId === i.id);
          return <article className="br-invoice-card" key={i.id}><div><span className="br-tag">{i.kind} · {i.period}</span><strong>{i.building} · Phòng {i.room}</strong><small>{i.number}</small></div><p>{i.customers.join(', ')}</p><dl><div><dt>Tổng hóa đơn</dt><dd>{money(i.total)}</dd></div><div><dt>Đã áp dụng</dt><dd>{money(i.paid)}</dd></div><div><dt>Còn phải thu</dt><dd>{i.status === 'PAID' ? 'Đã tất toán' : money(outstanding(i))}</dd></div></dl>{(i.debtNote || i.carriedBy) && <p className="br-card-note">{i.debtNote || `Nợ đã gộp vào DEMO-HD-${i.carriedBy}`}</p>}<button className="br-button" onClick={() => { setFilters({ ...emptyFilters, invoiceId: i.id }); setGroup('all'); setPage(0); setView('transactions'); }}><Search size={15} />Tìm tiền ngân hàng <span>{found.length}</span></button></article>;
        })}</div></section>}
        {view === 'sources' && <SourceConfiguration state={state} onSave={setState} onOpen={id => { const t = state.transactions.find(x => x.id === id); if (t) open(t); }} />}
        {view === 'history' && <section className="br-table-card"><div className="br-section-heading"><h2>Ai đã xử lý, xử lý thế nào?</h2><p>Lịch sử thao tác trong phiên demo. Hoàn tác giữ lại lịch sử cũ.</p></div>{!state.audit.length ? <Empty title="Chưa có thao tác" detail="Thử xác nhận một giao dịch hoặc phân loại khoản khác; lịch sử sẽ xuất hiện tại đây." /> : <ol className="br-history">{state.audit.map(a => <li key={a.id}><span className="br-history-dot"><Check size={15} /></span><div><strong>{a.action}</strong><p>{a.detail}</p><small>{time(a.at)} · {a.actor} · <button onClick={() => { const t = state.transactions.find(x => x.id === a.transactionId); if (t) open(t); }}>{a.transactionId}</button></small></div></li>)}</ol>}</section>}
        {view === 'guide' && <Guide onTry={() => { setView('transactions'); setFilters({ ...emptyFilters, query: 'DEMO-GD-09' }); setGroup('all'); setPage(0); }} />}
      </main>
    </div>
    <Dialog open={!!selected} onOpenChange={v => { if (!v) { setSelectedId(null); setPreview(null); } }}><DialogContent className="br-panel" onEscapeKeyDown={() => {}}><DialogHeader><DialogTitle>Chi tiết giao dịch</DialogTitle><DialogDescription>{selected?.id} · Đối soát dữ liệu mẫu</DialogDescription></DialogHeader>{selected && selectedMatches && <>
      <div className="br-panel-body"><div className="br-detail-amount"><span className={`br-direction ${selected.direction}`}>{selected.direction === 'in' ? <ArrowDownLeft /> : <ArrowUpRight />}</span><div><small>{selected.direction === 'in' ? 'Ngân hàng báo nhận' : 'Ngân hàng báo chi'}</small><h2>{selected.direction === 'in' ? '+' : '−'}{money(selected.amount)}</h2></div><Pill status={transactionStatus(state, selected)} /></div>
        <p className="br-description">{selected.description}</p><dl className="br-facts"><div><dt>Sổ ngân hàng</dt><dd>{bookName(selected.book)}</dd></div><div><dt>Mã ngân hàng</dt><dd>{selected.reference}</dd></div><div><dt>Giờ giao dịch</dt><dd>{time(selected.at)}</dd></div><div><dt>Giờ nhận tin</dt><dd>{time(selected.receivedAt)}</dd></div></dl>
        <details className="br-evidence"><summary>{selected.sources.length} tin báo · xem bằng chứng mẫu</summary>{selected.messages?.map((m, idx) => <article key={m.id}><strong>{selected.sources[idx]} · {channelLabels[m.channel]}</strong><p>{identityLabels[m.channel]}: <code>{m.channel === 'notification' ? m.packageName : m.sender}</code></p><p>{m.title}</p><small>{m.body}</small></article>)}<p>Các tin ở đây đã được gộp sẵn trong bộ mẫu. Chưa kết nối bộ tiếp nhận thực tế.</p></details>
        {!!selected.routingReasons?.length && <section className="br-routing-evidence"><h3>Vì sao nhận vào sổ này?</h3>{selected.routingReasons.map((r, i) => <p key={i}>{r}</p>)}{selected.link && <small>Cấu hình tại lúc xác nhận; không đổi sổ khoản đã ghi thu.</small>}<button className="br-button" onClick={() => { setSelectedId(null); setView('sources'); }}>Mở cấu hình nguồn</button></section>}
        {selected.link ? <div className="br-success-card"><CheckCheck size={24} /><h3>Đã đối soát giao dịch</h3><p>{selected.link.type === 'existing' ? 'Đã gắn khoản thu cũ, không tăng tiền ghi sổ.' : 'Đã tạo khoản thu trong bộ dữ liệu mẫu.'}</p><dl><div><dt>Hóa đơn</dt><dd>{state.invoices.find(i => i.id === selected.link?.invoiceId)?.number}</dd></div><div><dt>Áp vào hóa đơn</dt><dd>{money(selected.link.applied)}</dd></div><div><dt>Giữ credit</dt><dd>{money(selected.link.credit)}</dd></div></dl><small>{selected.link.receiptId}</small></div> : <>
          {selectedMatches.blocked && <div className="br-warning"><CircleHelp size={18} /><p>{selectedMatches.blocked}</p></div>}
          {!!selectedMatches.receipts.length && <section><div className="br-subheading"><h3>CRM có thể đã ghi khoản này</h3><span>Kiểm trước khi thu mới</span></div>{selectedMatches.receipts.map(r => <article key={r.id} className="br-receipt"><strong>{r.id}</strong><p>Tiền đã nhận {money(r.retained)} = trả bill {money(r.applied)} + credit {money(r.credit)}.</p><p>{state.invoices.find(i => i.id === r.invoiceId)?.number} · {bookName(r.book)}</p><span className="br-evidence-label">{r.reference === selected.reference ? 'Trùng mã ngân hàng · Đúng sổ · Đúng tiền' : 'Chỉ trùng sổ và tiền — cần kiểm thêm bằng chứng'}</span><button className="br-button br-primary" onClick={() => choose({ type: 'link', transactionId: selected.id, receiptId: r.id })}><Link2 size={16} />Gắn khoản thu đã có</button></article>)}</section>}
          {!selectedMatches.blocked && <section><div className="br-subheading"><h3>Hóa đơn gợi ý <span>{selectedMatches.candidates.length}</span></h3><small>Ngưỡng ±10.000đ</small></div>{!selectedMatches.candidates.length ? <Empty title="Chưa có hóa đơn trong ngưỡng" detail="Có thể để chờ xử lý hoặc phân loại khoản khác. Không tự nới ngưỡng 10.000đ." /> : selectedMatches.candidates.slice(0, showAll ? undefined : 5).map(c => <CandidateCard key={c.invoice.id} candidate={c} disabled={!!selectedMatches.receipts.length} onChoose={() => choose({ type: 'collect', transactionId: selected.id, invoiceId: c.invoice.id, expectedRevision: c.invoice.revision })} />)}{selectedMatches.candidates.length > 5 && <button className="br-button" onClick={() => setShowAll(v => !v)}>{showAll ? 'Thu gọn' : 'Xem thêm trong ngưỡng'}</button>}</section>}
          {!!selectedMatches.excluded.length && <section><button className="br-excluded-toggle" aria-expanded={showExcluded} onClick={() => setShowExcluded(v => !v)}>Vì sao các hóa đơn khác bị loại? ({selectedMatches.excluded.length})<ChevronRight size={15} /></button>{showExcluded && <ul className="br-excluded">{selectedMatches.excluded.map(x => <li key={x.invoice.id}><strong>{x.invoice.number} · P.{x.invoice.room}</strong><span>{x.reason}</span></li>)}</ul>}</section>}
        </>}
        {selected.note && <p className="br-card-note">Ghi chú: {selected.note}</p>}
        <section className="br-classify"><h3>{selected.link || selected.classification ? 'Sửa quyết định' : 'Chưa đủ thông tin?'}</h3><Field label="Lý do / ghi chú"><textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Ví dụ: cần kiểm tra với khách, đây là tiền cọc riêng…" /></Field><div className="br-actions">{selected.link || selected.classification ? <button className="br-button" disabled={!reason.trim()} onClick={() => choose({ type: 'undo', transactionId: selected.id, reason })}><RotateCcw size={15} />{selected.link ? 'Gỡ / hoàn tác' : 'Gỡ phân loại'}</button> : <><button className="br-button" disabled={!reason.trim()} onClick={() => choose({ type: 'classify', transactionId: selected.id, classification: 'waiting', reason })}>Để chờ xử lý</button><button className="br-button" disabled={!reason.trim()} onClick={() => choose({ type: 'classify', transactionId: selected.id, classification: 'other', reason })}>Không phải tiền hóa đơn</button></>}</div></section>
      </div><div className="br-panel-footer"><ShieldCheck size={16} />Mọi xác nhận ở đây chỉ thay đổi dữ liệu mẫu.</div>
    </>}</DialogContent></Dialog>
    <Dialog open={!!preview} onOpenChange={v => { if (!v) setPreview(null); }}><DialogContent className="br-confirm" onEscapeKeyDown={() => {}}><DialogHeader><DialogTitle>{preview?.type === 'collect' ? 'Xem trước khoản thu' : preview?.type === 'link' ? 'Gắn khoản thu đã có?' : preview?.type === 'undo' ? 'Hoàn tác quyết định?' : 'Xác nhận phân loại'}</DialogTitle><DialogDescription>Thao tác trên bộ mẫu DEMO, không ghi vào hệ thống thật.</DialogDescription></DialogHeader>{previewInvoice && previewTransaction ? <><h3>{previewInvoice.number} · Phòng {previewInvoice.room}</h3><dl className="br-preview-money"><div><dt>Ngân hàng đã nhận</dt><dd>{money(previewTransaction.amount)}</dd></div><div><dt>Còn phải thu trước xác nhận</dt><dd>{money(outstanding(previewInvoice))}</dd></div><div><dt>Áp vào hóa đơn</dt><dd>{money(Math.min(previewTransaction.amount, outstanding(previewInvoice)))}</dd></div><div><dt>Còn nợ sau xác nhận</dt><dd>{money(Math.max(outstanding(previewInvoice) - previewTransaction.amount, 0))}</dd></div><div><dt>Tiền dư giữ credit</dt><dd>{money(Math.max(previewTransaction.amount - outstanding(previewInvoice), 0))}</dd></div></dl><p className="br-card-note">Thu vào {bookName(previewTransaction.book)}. Thu thiếu vẫn còn nợ; demo không tự làm tròn hoặc tự hoàn tiền.</p></> : <p>{preview?.type === 'link' ? 'Chỉ thêm liên kết với giao dịch ngân hàng. Không tạo payment mới, không cộng thêm tiền hoặc giảm nợ lần nữa.' : preview?.type === 'undo' ? 'Nếu đã tạo khoản thu mẫu, hoàn tác sẽ khôi phục công nợ khi chưa có thay đổi tiếp theo. Gỡ khoản thu cũ giữ nguyên tiền đã ghi. Đây không phải hoàn tiền qua ngân hàng.' : preview?.type === 'classify' ? preview.reason : ''}</p>}{failure && <p role="alert" className="br-error">{failure}</p>}<div className="br-actions br-confirm-actions"><button className="br-button" onClick={() => setPreview(null)}>Quay lại</button><button className="br-button br-primary" onClick={confirm}><Check size={16} />Xác nhận trên demo</button></div></DialogContent></Dialog>
    <Dialog open={resetOpen} onOpenChange={setResetOpen}><DialogContent className="br-confirm"><DialogHeader><DialogTitle>Đặt lại dữ liệu mẫu?</DialogTitle><DialogDescription>Các thao tác và cấu hình nguồn trong phiên này sẽ được xóa. Bộ 16 giao dịch và 13 hóa đơn mẫu được khôi phục.</DialogDescription></DialogHeader><div className="br-actions"><button className="br-button" onClick={() => setResetOpen(false)}>Giữ lại</button><button className="br-button br-primary" onClick={() => { setState(createDemoState()); setFilters({ ...emptyFilters }); setGroup('all'); setPage(0); setSelectedId(null); setPreview(null); setResetOpen(false); setNotice('Đã khôi phục bộ dữ liệu mẫu.'); }}>Đặt lại dữ liệu</button></div></DialogContent></Dialog>
  </div>;
}

function Stat({ label, value, detail, icon, tone = '' }: { label: string; value: string; detail: string; icon: ReactNode; tone?: string }) { return <article className={`br-stat ${tone}`}><div><span>{label}</span><i>{icon}</i></div><strong>{value}</strong><small>{detail}</small></article>; }
function CandidateCard({ candidate: c, onChoose, disabled }: { candidate: Candidate; onChoose: () => void; disabled: boolean }) {
  return <article className="br-candidate"><div className="br-candidate-top"><span className="br-room">{c.invoice.room}</span><div><strong>{c.invoice.building} · Phòng {c.invoice.room}</strong><small>{c.invoice.customers.join(', ')} · {c.invoice.kind} {c.invoice.period}</small></div><span className={`br-tag ${c.delta === 0 ? 'exact' : 'near'}`}>{c.delta === 0 ? 'Đúng tiền' : `${c.delta < 0 ? 'Thiếu' : 'Dư'} ${money(Math.abs(c.delta))}`}</span></div><div className="br-candidate-money"><span>{c.invoice.number}</span><strong>Còn thu {money(c.remaining)}</strong></div><div className="br-reasons">{c.reasons.map(r => <span key={r}><Check size={12} />{r}</span>)}</div>{!c.evidence && <p className="br-card-note">Chưa nhận diện được khách/phòng từ nội dung. Quản lý cần đối chiếu thêm.</p>}{c.invoice.debtNote && <p className="br-card-note">{c.invoice.debtNote}</p>}{!!c.competitors && <p className="br-competition">Còn {c.competitors} khoản khác đang được gợi ý vào hóa đơn này.</p>}<button className="br-button br-primary" disabled={disabled} onClick={onChoose}>Chọn hóa đơn này<ArrowRight size={15} /></button>{disabled && <small>Đối chiếu khoản thu cũ phía trên trước.</small>}</article>;
}
function Guide({ onTry }: { onTry: () => void }) {
  return <div className="br-guide"><section className="br-guide-intro"><span className="br-tag exact">BẮT ĐẦU TỪ ĐÂY</span><h2>Đối chiếu một khoản tiền trong 4 bước</h2><p>Hệ thống tìm ứng viên. Anh kiểm chứng thông tin và quyết định ghi nhận.</p><button className="br-button br-primary" onClick={onTry}>Thử khoản đúng tiền<ArrowRight size={16} /></button></section><div className="br-guide-steps">{[
    ['01', 'Tìm khoản tiền', 'Mở Biến động ngân hàng, chọn sổ nhận và khoảng ngày. Dùng nhóm Cần khớp hoặc tìm mã giao dịch, tên khách, phòng.'],
    ['02', 'Kiểm nguồn và sổ', 'Bấm vào dòng. Đọc số tiền, tài khoản, nội dung và các tin báo. Khoản thiếu sổ hoặc nghi trùng cần được kiểm tra trước.'],
    ['03', 'Chọn đúng hóa đơn', 'Ưu tiên kiểm CRM đã ghi thu chưa. Nếu chưa, so hóa đơn gợi ý: đúng sổ, đúng phần còn nợ, phòng/tòa/khách và số thiếu dư.'],
    ['04', 'Xem trước rồi xác nhận', 'Xem tiền áp bill, nợ còn lại và credit. Bấm xác nhận trên demo. Kiểm kết quả ở Đã khớp, Hóa đơn đối chiếu và Lịch sử xử lý.'],
  ].map(([n, title, detail]) => <article key={n}><span>{n}</span><h3>{title}</h3><p>{detail}</p></article>)}</div>
    <section className="br-table-card"><div className="br-section-heading"><h2>Các tình huống anh nên thử</h2><p>Nhập mã ở ô tìm kiếm trên trang giao dịch.</p></div><table className="br-guide-table"><thead><tr><th>Mã mẫu</th><th>Tình huống</th><th>Kết quả cần thấy</th></tr></thead><tbody>{[
      ['DEMO-GD-09', 'Đúng tiền, SMS + Gmail', 'Một khoản 3.250.000đ, hai tin báo; chọn bill phòng 101.'],
      ['DEMO-GD-10', 'Thiếu đúng 10.000đ', 'Được gợi ý bill phòng 102; xác nhận xong vẫn còn nợ 10.000đ.'],
      ['DEMO-GD-11', 'Dư 10.000đ', 'Áp 2.800.000đ vào bill, giữ 10.000đ credit.'],
      ['DEMO-GD-12', 'Hóa đơn đã trả một phần', 'Tổng 5 triệu đã trả 2 triệu; khớp khoản còn lại 3 triệu.'],
      ['DEMO-GD-13 / 20', 'Nhiều ứng viên, cùng tranh một bill', 'Có cảnh báo cạnh tranh. Ghi khoản 20 cho phòng 201 rồi xem gợi ý khoản 13 thay đổi.'],
      ['DEMO-GD-14', 'Nợ gộp tháng trước', 'Gợi ý bill tháng 10 gồm nợ tháng 9; không thu nguồn lần nữa.'],
      ['DEMO-GD-15', 'Nhân viên đã ghi thu', 'Gắn phiếu DEMO-PT-CU-01; không tạo thu mới.'],
      ['DEMO-GD-16', 'Lệch 10.001đ', 'Không gợi ý bill phòng 102 dù nội dung đúng phòng.'],
      ['DEMO-GD-18 / 21', 'Thiếu sổ / nghi trùng', 'Chặn thu; có thể ghi chú và để chờ xử lý.'],
      ['DEMO-GD-MB01', 'Nguồn MBDemo → sổ MBDemo', 'Nhận diện com.mbbmobile và dấu tài khoản 00xxx123; gợi ý bill D06 – DEMO-A trong bộ mẫu.'],
    ].map(([code, situation, result]) => <tr key={code}><td>{code}</td><td>{situation}</td><td>{result}</td></tr>)}</tbody></table></section>
    <section className="br-guide-faq"><h2>Các thao tác còn lại</h2>{[
      ['Bộ lọc và xuất dữ liệu', 'Mở Bộ lọc để chọn ngày giao dịch hoặc ngày nhận, nguồn, ngân hàng, trạng thái, tòa và số tiền. Tòa là tòa đã khớp hoặc có gợi ý, chưa phải kết luận chủ khoản tiền. Số tổng và CSV lấy toàn bộ kết quả đang lọc, không chỉ trang hiện tại.'],
      ['Không tìm được hóa đơn', 'Mở chi tiết, đọc danh sách hóa đơn bị loại. Nhập lý do rồi chọn Để chờ xử lý. Cọc riêng hoặc khoản khác chọn Không phải tiền hóa đơn. Không nâng ngưỡng để cố tìm một bill.'],
      ['Dò ngược từ hóa đơn', 'Vào Hóa đơn đối chiếu → Tìm tiền ngân hàng. Bộ lọc sẽ chỉ hiển thị khoản có gợi ý hoặc đã gắn với bill đó. Bỏ điều kiện để xem toàn bộ.'],
      ['Cấu hình nguồn → sổ nhận', 'Vào Nguồn kết nối → Thêm quy tắc. Chọn nguồn, loại tin, sender SMS / packageName / email From, sổ đích và điều kiện nội dung hoặc tài khoản nếu cần. Thử tin trước khi lưu. Không khớp hoặc nhiều sổ cùng khớp thì chờ kiểm tra. Lưu sẽ tính lại khoản chưa khớp; khoản đã khớp giữ sổ cũ.'],
      ['Sửa nhầm hoặc gỡ liên kết', 'Mở khoản đã xử lý, nhập lý do → Gỡ / hoàn tác → đọc xem trước. Gắn khoản cũ thì chỉ gỡ liên kết. Khoản mới khôi phục công nợ nếu chưa có thay đổi sau đó. Không đồng nghĩa hoàn tiền thật.'],
      ['Thử lại từ đầu', 'Bấm Đặt lại demo rồi xác nhận; hoặc tải lại trang. Phiên demo không lưu lâu dài và không chia sẻ trạng thái giữa các tab.'],
      ['Phần chưa kết nối thật', 'Chưa có tiếp nhận/chuẩn hóa tin thật, API lưu đối soát, quyền theo vai trò, ghi thu V5, khóa đồng thời giữa người dùng hoặc tự thanh toán. Nguồn và tiền đều là mẫu. Các phần đó cần triển khai và kiểm backend riêng trước khi vận hành.'],
    ].map(([title, detail]) => <details key={title}><summary>{title}</summary><p>{detail}</p></details>)}</section>
  </div>;
}
