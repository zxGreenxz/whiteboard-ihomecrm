import { lazy, Suspense, useEffect, useState } from "react";
import { Building2, ChevronRight, Paperclip, Pencil, Plus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { useAccounts } from "@/hooks/useAccounts";
import { useCustodianCashbooksV2 } from "@/hooks/income-expenses/financeV2Mutations";
import { useCompanyWallets, useCompanyWalletMutation } from "@/hooks/company-wallet/useCompanyWallets";
import { canUse } from "@/lib/permissionPages";
import { expenseCashbooksForOrg } from "@/lib/quickEntry/cashbook";
import { MoneyRangeError, sumMoney } from "@/lib/personalFinance/money";
import { money } from "./presentation";
import { MonthPicker } from "./FinanceViews";

const VoucherDetail = lazy(() => import("@/components/income-expenses/IncomeExpenseDetailDialog").then(m => ({ default: m.IncomeExpenseDetailDialog })));
type Snapshot = NonNullable<ReturnType<typeof useCompanyWallets>["data"]>;
type Wallet = Snapshot["wallets"][number];
type Transaction = Snapshot["transactions"][number];
type Request = Parameters<ReturnType<typeof useCompanyWalletMutation>["mutateAsync"]>[0];
const kinds = [["bank", "Ngân hàng"], ["sp_card", "Thẻ SP"], ["credit_card", "Thẻ tín dụng"], ["cash", "Tiền mặt"]] as const;
const kindLabel = (kind: string) => kinds.find(([value]) => value === kind)?.[1] ?? kind;
const isPosted = (t: Transaction) => t.approval_status !== "CANCELLED" && t.posting_status === "POSTED" && !t.deleted_at;
function statusLabel(t: Transaction) {
  if (t.approval_status === "CANCELLED" || t.deleted_at) return "Đã hủy";
  if (t.posting_status === "REVERSED") return "Đã hoàn tác";
  if (t.posting_status === "POSTED") return t.type === "INCOME" ? "Đã thu" : "Đã chi";
  if (t.review_state === "CHANGES_REQUESTED") return "Cần bổ sung";
  if (t.review_state === "DISPUTED") return "Đang tranh chấp";
  if (t.approval_status === "APPROVED") return t.type === "INCOME" ? "Đã duyệt · Chưa thu" : "Đã duyệt · Chưa chi";
  return "Chờ duyệt";
}

export default function CompanyFinance({ view, month, onMonth, search = "", hidden = false, onManage, onEntry, onCreateCashbook }: {
  view: "overview" | "ledger" | "reports" | "settings";
  month: string;
  onMonth: (month: string) => void;
  search?: string;
  hidden?: boolean;
  onManage?: () => void;
  onEntry?: () => void;
  onCreateCashbook?: () => void;
}) {
  const { selectedOrganizationId, organization } = useOrganization();
  const query = useCompanyWallets(selectedOrganizationId);
  const permissions = useMyPermissions();
  const snapshot = query.data;
  if (!selectedOrganizationId) return <p className="pf-card">Chọn công ty để xem ví chi cho công ty.</p>;
  if (query.isLoading) return <p className="pf-card" role="status">Đang tải ví công ty…</p>;
  if (!snapshot) return <div className="pf-card" role="alert">Chưa tải được ví công ty. <Button variant="outline" onClick={() => void query.refetch()}>Thử lại</Button></div>;
  const canWrite = !permissions.error && canUse(permissions.data, "income_expenses", "create");
  const canViewDetail = !permissions.error && canUse(permissions.data, "income_expenses", "view");
  return <div className="pf-stack pf-company" data-testid="company-finance">
    <div className="pf-between"><h2><Building2 size={18} className="inline-block" /> Ví công ty</h2><span className="pf-muted">{organization?.name}</span></div>
    {query.error && <div role="alert">Chưa cập nhật được ví công ty. <Button variant="outline" onClick={() => void query.refetch()}>Thử lại</Button></div>}
    {permissions.error && <div role="alert">Chưa kiểm tra được quyền thao tác. <Button variant="outline" onClick={() => void permissions.refetch()}>Thử lại</Button></div>}
    {view === "settings" ? <CompanyWalletSettings key={`${snapshot.owner_id}:${selectedOrganizationId}`} snapshot={snapshot} canWrite={canWrite} canCreateCashbook={!permissions.error && canUse(permissions.data, "cashbooks", "create")} onCreateCashbook={onCreateCashbook} /> :
      <CompanyWalletActivity key={`${snapshot.owner_id}:${selectedOrganizationId}`} snapshot={snapshot} view={view} month={month} onMonth={onMonth} search={search} hidden={hidden} canViewDetail={canViewDetail} canWrite={canWrite} onManage={onManage} onEntry={onEntry} onRefresh={() => { void query.refetch(); }} />}
  </div>;
}

function CompanyWalletSettings({ snapshot, canWrite, canCreateCashbook, onCreateCashbook }: {
  snapshot: Snapshot; canWrite: boolean; canCreateCashbook: boolean; onCreateCashbook?: () => void;
}) {
  const [editing, setEditing] = useState<Wallet | "new" | null>(null);
  const accounts = useAccounts({ enabled: canWrite });
  const custodians = useCustodianCashbooksV2(canWrite);
  const allowed = expenseCashbooksForOrg(custodians.data ?? [], accounts.data, snapshot.organization_id);
  const available = allowed.filter(account => !snapshot.wallets.some(w => w.account_id === account.id && (editing === "new" || w.id !== editing?.id)));
  if (editing) return <CompanyWalletEditor key={editing === "new" ? "new" : editing.id} wallet={editing === "new" ? null : editing} organizationId={snapshot.organization_id} accounts={available} accountsLoading={accounts.isLoading || custodians.isLoading} accountsError={accounts.error ?? custodians.error} canWrite={canWrite} onRetryAccounts={() => { void accounts.refetch(); void custodians.refetch(); }} onClose={() => setEditing(null)} />;
  return <div className="pf-stack">
    <p className="pf-muted">Mỗi ví gắn một sổ quỹ công ty. Số dư lấy từ sổ quỹ đã liên kết.</p>
    {!snapshot.wallets.length && <p className="pf-empty">Chưa cài đặt ví chi cho công ty. Thêm ví để chọn khi ghi phiếu.</p>}
    {snapshot.wallets.map(wallet => <div className="pf-row" key={wallet.id}>
      <span className="pf-emoji">{wallet.icon}</span><div className="pf-grow"><strong>{wallet.name}</strong><small>{kindLabel(wallet.kind)} · {wallet.account_name ?? "Sổ quỹ không còn khả dụng"}{wallet.is_preferred ? " · Ưu tiên" : ""}{wallet.hidden ? " · Đang ẩn" : ""}</small><small>{wallet.balance_visible && wallet.balance !== null ? money(wallet.balance) : "Không có quyền xem số dư"}{!wallet.can_use ? " · Không thể dùng để lập phiếu" : ""}</small></div>
      {canWrite && <button aria-label={`Sửa ví công ty ${wallet.name}`} onClick={() => setEditing(wallet)}><Pencil size={18} /></button>}
    </div>)}
    {canWrite && <Button onClick={() => setEditing("new")}><Plus size={16} /> Thêm ví công ty</Button>}
    {canCreateCashbook && onCreateCashbook && <Button variant="outline" onClick={onCreateCashbook}>Tạo sổ quỹ mới</Button>}
  </div>;
}

function CompanyWalletEditor({ wallet, organizationId, accounts, accountsLoading, accountsError, canWrite, onRetryAccounts, onClose }: {
  wallet: Wallet | null; organizationId: string; accounts: Array<{ id: string; name: string }>; accountsLoading: boolean; accountsError: unknown; canWrite: boolean; onRetryAccounts: () => void; onClose: () => void;
}) {
  const writer = useCompanyWalletMutation(organizationId);
  const [name, setName] = useState(wallet?.name ?? "");
  const [kind, setKind] = useState<Wallet["kind"]>(wallet?.kind ?? "bank");
  const [icon, setIcon] = useState(wallet?.icon ?? "🏦");
  const [accountId, setAccountId] = useState(wallet?.account_id ?? "");
  const [preferred, setPreferred] = useState(wallet?.is_preferred ?? false);
  const [hidden, setHidden] = useState(wallet?.hidden ?? false);
  const [held, setHeld] = useState<Request | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remove, setRemove] = useState(false);
  const locked = writer.isPending || !!held || !canWrite;
  const unavailableCurrent = wallet && !accounts.some(account => account.id === wallet.account_id);
  async function submit() {
    if (!canWrite || writer.isPending) return;
    setError(null);
    const request: Request = held ?? {
      requestKey: crypto.randomUUID(), action: remove ? "delete" : wallet ? "update" : "create",
      ...(wallet ? { id: wallet.id, expectedVersion: wallet.version } : {}),
      data: remove ? {} : { name: name.trim(), kind, account_id: accountId, icon, is_preferred: preferred, hidden },
    };
    try {
      await writer.mutateAsync(request);
      setHeld(null); onClose();
    } catch (e) {
      const unknown = typeof e === "object" && e !== null && "outcomeUnknown" in e && e.outcomeUnknown === true;
      setHeld(unknown ? request : null);
      setError(e instanceof Error ? e.message : "Chưa thể lưu cài đặt ví công ty.");
    }
  }
  return <form className="pf-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <h3>{remove ? "Xóa ví công ty" : wallet ? "Sửa ví công ty" : "Thêm ví công ty"}</h3>
    {remove ? <p>Xóa cài đặt ví “{wallet?.name}”? Sổ quỹ công ty được giữ nguyên. Ví đã có phiếu chỉ có thể ẩn.</p> : <fieldset disabled={locked}>
      <label className="pf-field">Tên ví công ty<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label>
      <label className="pf-field">Loại ví công ty<select aria-label="Loại ví công ty" value={kind} onChange={e => setKind(e.target.value as Wallet["kind"])}>{kinds.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <div className="pf-field"><span>Chọn biểu tượng</span><div className="pf-emoji-options" role="group" aria-label="Biểu tượng ví công ty">{[...new Set([icon, "🏦", "👛", "💳", "💵", "🏢", "🪙", "📱"])].map(value => <button type="button" key={value} aria-label={`Biểu tượng ${value}`} aria-pressed={icon === value} onClick={() => setIcon(value)}>{value}</button>)}</div></div>
      <label className="pf-field">Sổ quỹ liên kết<select aria-label="Sổ quỹ liên kết" required value={accountId} disabled={accountsLoading || !!accountsError || !!wallet} onChange={e => setAccountId(e.target.value)}><option value="">Chọn sổ quỹ công ty</option>{unavailableCurrent && <option value={wallet.account_id}>{wallet.account_name ?? "Sổ quỹ hiện tại"}</option>}{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      {accountsLoading && <p role="status">Đang tải sổ quỹ…</p>}
      {accountsError ? <p role="alert">Chưa tải được sổ quỹ. <button type="button" onClick={onRetryAccounts}>Thử lại</button></p> : !accountsLoading && !accounts.length && !wallet && <p>Chưa có sổ quỹ khả dụng chưa liên kết. Tạo sổ quỹ hoặc nhờ người quản lý giao quyền giữ sổ.</p>}
      <label className="pf-check"><input type="checkbox" checked={preferred} onChange={e => setPreferred(e.target.checked)} /> Ưu tiên ví này khi nhận diện cùng loại thanh toán</label>
      <label className="pf-check"><input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} /> Ẩn ví khỏi danh sách chọn</label>
    </fieldset>}
    {error && <p role="alert">{error}</p>}
    <div className="pf-form-actions">
      <Button type="button" variant="outline" disabled={writer.isPending || !!held} onClick={remove ? () => setRemove(false) : onClose}>Quay lại</Button>
      <Button type="submit" disabled={writer.isPending || !canWrite || (!held && !remove && (!name.trim() || !accountId || (!wallet && (accountsLoading || !!accountsError))))}>{writer.isPending ? "Đang lưu…" : held ? "Gửi lại y nguyên" : remove ? "Xác nhận xóa" : "Lưu ví công ty"}</Button>
      {wallet && !remove && <Button type="button" variant="outline" disabled={locked} onClick={() => setRemove(true)}>Xóa ví công ty</Button>}
    </div>
  </form>;
}

function CompanyWalletActivity({ snapshot, view, month, onMonth, search, hidden, canViewDetail, canWrite, onManage, onEntry, onRefresh }: {
  snapshot: Snapshot; view: "overview" | "ledger" | "reports"; month: string; onMonth: (month: string) => void; search: string; hidden: boolean; canViewDetail: boolean; canWrite: boolean; onManage?: () => void; onEntry?: () => void; onRefresh: () => void;
}) {
  const [walletId, setWalletId] = useState("");
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("all");
  const [dateFrom, setDateFrom] = useState(`${month}-01`);
  const [dateTo, setDateTo] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  useEffect(() => { setDateFrom(`${month}-01`); const [year, selectedMonth] = month.split("-").map(Number); setDateTo(`${month}-${new Date(year, selectedMonth, 0).getDate()}`); }, [month]);
  const rows = snapshot.transactions.filter(row => row.user_id === snapshot.owner_id && row.organization_id === snapshot.organization_id)
    .filter(row => view === "ledger" ? (!dateFrom || row.voucher_date >= dateFrom) && (!dateTo || row.voucher_date <= dateTo) : row.voucher_date.startsWith(month))
    .filter(row => (!walletId || row.wallet_id === walletId) && (type === "all" || row.type === type))
    .filter(row => status === "all" || (status === "posted" ? isPosted(row) : status === "cancelled" ? row.approval_status === "CANCELLED" || !!row.deleted_at : status === "reversed" ? row.posting_status === "REVERSED" : !isPosted(row) && row.approval_status !== "CANCELLED" && row.posting_status !== "REVERSED" && !row.deleted_at))
    .filter(row => `${row.name} ${row.code} ${row.total_amount} ${snapshot.wallets.find(wallet => wallet.id === row.wallet_id)?.name ?? ""}`.toLocaleLowerCase("vi").includes(search.toLocaleLowerCase("vi")))
    .sort((a, b) => b.voucher_date.localeCompare(a.voucher_date) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  let income = 0, expense = 0, balance: number | null = null;
  try {
    income = sumMoney(rows.filter(row => isPosted(row) && row.type === "INCOME").map(row => row.total_amount));
    expense = sumMoney(rows.filter(row => isPosted(row) && row.type === "EXPENSE").map(row => row.total_amount));
    if (snapshot.wallets.every(wallet => wallet.balance_visible && wallet.balance !== null)) balance = sumMoney(snapshot.wallets.map(wallet => wallet.balance ?? 0));
  } catch (error) { if (error instanceof MoneyRangeError) return <p role="alert">{error.message}</p>; throw error; }
  return <>
    {view !== "ledger" && <div className="pf-between"><MonthPicker month={month} onChange={onMonth} />{onManage && <Button variant="outline" onClick={onManage}><Settings size={16} /> Cài đặt ví công ty</Button>}</div>}
    {view === "overview" && <>
      <section className="pf-balance"><span>Tổng số dư ví công ty</span><strong data-testid="company-total-balance">{hidden ? "••••••" : balance === null ? "Chưa đủ quyền xem" : money(balance)}</strong><small>Số dư hiện tại của {snapshot.wallets.length} sổ quỹ đã liên kết</small></section>
      <div className="pf-wallet-strip">{snapshot.wallets.filter(wallet => !wallet.hidden).map(wallet => <button key={wallet.id} aria-pressed={walletId === wallet.id} onClick={() => setWalletId(walletId === wallet.id ? "" : wallet.id)}><small>{wallet.icon} {wallet.name}</small><b>{hidden ? "••••" : wallet.balance_visible && wallet.balance !== null ? money(wallet.balance) : "Không có quyền xem"}</b></button>)}</div>
      {canWrite && onEntry && <Button onClick={onEntry}><Plus size={18} /> Ghi phiếu công ty</Button>}
    </>}
    <p className="pf-muted">Giao dịch và báo cáo chỉ gồm phiếu bạn nhập từ trang Ví cá nhân cho công ty này.</p>
    {view === "ledger" && <div className="pf-company-filters">
      <label className="pf-field">Từ ngày<input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></label><label className="pf-field">Đến ngày<input type="date" value={dateTo} min={dateFrom} onChange={e => setDateTo(e.target.value)} /></label>
      <label className="pf-field">Ví công ty<select aria-label="Ví công ty" value={walletId} onChange={e => setWalletId(e.target.value)}><option value="">Mọi ví công ty</option>{snapshot.wallets.map(wallet => <option key={wallet.id} value={wallet.id}>{wallet.name}</option>)}</select></label>
      <label className="pf-field">Loại giao dịch<select aria-label="Loại giao dịch" value={type} onChange={e => setType(e.target.value)}><option value="all">Thu và chi</option><option value="EXPENSE">Chi</option><option value="INCOME">Thu</option></select></label>
      <label className="pf-field">Trạng thái phiếu<select aria-label="Trạng thái phiếu" value={status} onChange={e => setStatus(e.target.value)}><option value="all">Mọi trạng thái</option><option value="posted">Đã thu/chi</option><option value="pending">Chờ xử lý</option><option value="cancelled">Đã hủy</option><option value="reversed">Đã hoàn tác</option></select></label>
    </div>}
    <section className="pf-card">
      <div className="pf-between"><strong>{rows.length} phiếu công ty</strong><span data-testid="company-month-totals">Đã thu {hidden ? "••••" : money(income)} · Đã chi {hidden ? "••••" : money(expense)}</span></div>
      {!rows.length && <p className="pf-empty">Chưa có phiếu công ty phù hợp.</p>}
      {view === "reports" ? snapshot.wallets.map(wallet => {
        const posted = rows.filter(row => row.wallet_id === wallet.id && isPosted(row));
        if (!posted.length) return null;
        return <div className="pf-row" key={wallet.id}><span className="pf-emoji">{wallet.icon}</span><div className="pf-grow"><strong>{wallet.name}</strong><small>{kindLabel(wallet.kind)} · {posted.length} phiếu đã thu/chi</small></div><div><small>Thu {money(sumMoney(posted.filter(row => row.type === "INCOME").map(row => row.total_amount)))}</small><small>Chi {money(sumMoney(posted.filter(row => row.type === "EXPENSE").map(row => row.total_amount)))}</small></div></div>;
      }) : rows.slice(0, view === "overview" ? 5 : undefined).map(row => <div className="pf-row" key={row.id}>
        <span className="pf-emoji">{snapshot.wallets.find(wallet => wallet.id === row.wallet_id)?.icon ?? "🏢"}</span><div className="pf-grow"><strong>{row.name}</strong><small>{row.voucher_date.split("-").reverse().join("/")} · {row.code} · {snapshot.wallets.find(wallet => wallet.id === row.wallet_id)?.name ?? "Ví công ty"}</small><small>{statusLabel(row)}{row.attachments.length > 0 && <> · <Paperclip size={12} className="inline-block" /> {row.attachments.length} chứng từ</>}</small></div><b>{hidden ? "••••" : `${row.type === "INCOME" ? "+" : "−"}${money(row.total_amount)}`}</b>{canViewDetail && <button aria-label={`Xem phiếu ${row.code}`} onClick={() => setDetailId(row.id)}><ChevronRight size={20} /></button>}
      </div>)}
    </section>
    {detailId && canViewDetail && <Suspense fallback={<p role="status">Đang tải chi tiết phiếu…</p>}><VoucherDetail open voucher={null} voucherId={detailId} organizationIdHint={snapshot.organization_id} onOpenChange={open => { if (!open) { setDetailId(null); onRefresh(); } }} /></Suspense>}
  </>;
}
