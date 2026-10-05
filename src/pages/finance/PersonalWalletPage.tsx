import { useState, useEffect } from "react";
import {
  Home,
  List,
  Plus,
  ClipboardList,
  ChartNoAxesColumn,
  Eye,
  EyeOff,
  ChevronRight,
  ArrowDownLeft,
  ArrowUpLeft,
  Paperclip,
  Camera,
  ImagePlus,
  Mic,
  Settings,
  Wallet,
  Building2,
} from "lucide-react";
import MainLayout from "@/components/layout/MainLayout";
import { Button } from "@/components/ui/button";
import { usePersonalFinancePermissions } from "@/hooks/personal-finance/usePersonalFinancePermissions";
import { usePersonalFinance } from "@/hooks/personal-finance/usePersonalFinance";
import { useQuickEntryController } from "@/hooks/quick-entry/useQuickEntryController";
import {
  QuickEntryInput,
  QuickEntryDraftFeed,
  PersonalPendingRequests,
} from "@/components/quick-entry/EmbeddedQuickEntry";
import {
  localMonth,
  selectBalance,
  selectMonth,
  selectGoals,
} from "@/lib/personalFinance/selectors";
import { MoneyRangeError } from "@/lib/personalFinance/money";
import { useMyShareholder } from "@/hooks/useShareholders";
import {
  useProfitAllocations,
  useShareholderDistributions,
  computeShareholderSummary,
} from "@/hooks/useShareholderProfit";
import { FinanceEditor } from "@/components/personal-finance/FinanceEditor";
import {
  Budgets,
  Goals,
  Ledger,
  Management,
  MonthPicker,
  Reports,
  FinanceSheet,
} from "@/components/personal-finance/FinanceViews";
import {
  money,
  shiftMonth,
  emptyFilters,
  type Editor,
} from "@/components/personal-finance/presentation";
import "@/components/personal-finance/personal-finance.css";

function ShareholderNotice() {
  const me = useMyShareholder();
  const allocations = useProfitAllocations();
  const distributions = useShareholderDistributions();
  if (me.error)
    return (
      <p role="alert">
        Chưa tải được thông tin cổ đông.{" "}
        <button onClick={() => void me.refetch()}>Thử lại</button>
      </p>
    );
  if (!me.data) return null;
  if (allocations.error || distributions.error)
    return (
      <p role="alert">
        Chưa tải được phần lợi nhuận cổ đông.{" "}
        <button
          onClick={() => {
            void allocations.refetch();
            void distributions.refetch();
          }}
        >
          Thử lại
        </button>
      </p>
    );
  if (allocations.isLoading || distributions.isLoading)
    return <p role="status">Đang tải phần lợi nhuận cổ đông…</p>;
  const total = computeShareholderSummary(
    [me.data.id],
    allocations.data ?? [],
    distributions.data ?? [],
  )[me.data.id];
  return total ? (
    <aside className="pf-card pf-muted">
      Từ công ty: Được chia {money(total.accrued)} · Đã ứng {money(total.paid)}{" "}
      · Còn được nhận {money(total.remaining)}
    </aside>
  ) : null;
}
export default function PersonalWalletPage() {
  const query = usePersonalFinance();
  const permissionQuery = usePersonalFinancePermissions();
  const permissions = {
    create: permissionQuery.data?.create === true,
    edit: permissionQuery.data?.edit === true,
    delete: permissionQuery.data?.delete === true,
  };
  const controller = useQuickEntryController("personal");
  const [tab, setTab] = useState("home");
  const [month, setMonth] = useState(localMonth);
  const [hidden, setHidden] = useState(false);
  const [sheet, setSheet] = useState<"entry" | "wallet" | "category" | null>(
    null,
  );
  const [launchAction, setLaunchAction] = useState<{
    id: number;
    action: "attachment" | "camera" | "gallery" | "voice";
  }>();
  const [manualCompanyId, setManualCompanyId] = useState<string | null>(null);
  const [entryMode, setEntryMode] = useState("quick");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [filters, setFilters] = useState(emptyFilters);
  const [budgetTab, setBudgetTab] = useState("budget");
  useEffect(() => {
    if (
      sheet !== "entry" ||
      entryMode !== "manual" ||
      controller.mode !== "company" ||
      !controller.feed
    )
      return;
    const card = manualCompanyId
      ? controller.feed.cards[manualCompanyId]
      : null;
    if (!card || card.status.kind === "saved")
      setManualCompanyId(controller.feed.addManual("company"));
  }, [sheet, entryMode, controller.mode, controller.feed, manualCompanyId]);
  const s = query.data;
  let m: ReturnType<typeof selectMonth> | null = null;
  let balance = 0;
  let moneyError: string | null = null;
  try {
    if (s) {
      balance = selectBalance(s);
      m = selectMonth(s, month);
      // Preflight every aggregate used by the mounted tabs, including older report months.
      selectGoals(s);
      for (let i = 1; i < 6; i++) selectMonth(s, shiftMonth(month, -i));
    }
  } catch (error) {
    if (!(error instanceof MoneyRangeError)) throw error;
    moneyError = error.message;
  }
  const props = s ? { snapshot: s, permissions, edit: setEditor } : null;
  const manualDestination = (
    <div className="pf-manual-destination">
      <span className="pf-destination-caption">Gửi thu chi vào</span>
      <div
        className="pf-launcher-destination"
        role="group"
        aria-label="Ghi vào"
      >
        {controller.modes?.map((mode) => (
          <button
            type="button"
            key={mode}
            aria-pressed={controller.mode === mode}
            onClick={() => controller.setMode(mode)}
          >
            {mode === "personal" ? (
              <Wallet size={18} />
            ) : (
              <Building2 size={18} />
            )}{" "}
            {mode === "personal" ? "Cá nhân" : "Công ty"}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <MainLayout hideMobileHeader>
      <div className="pf-app" data-testid="personal-finance-app">
        {query.isLoading ? (
          <div className="pf-card pf-loading" role="status">
            Đang tải ví cá nhân…
          </div>
        ) : query.error && !s ? (
          <div className="pf-card" role="alert">
            Không tải được ví cá nhân.
            <Button onClick={() => void query.refetch()}>Thử lại</Button>
          </div>
        ) : moneyError ? (
          <div className="pf-card" role="alert">
            {moneyError}
            <Button onClick={() => void query.refetch()}>Tải lại</Button>
          </div>
        ) : s && m && props ? (
          <>
            {query.error && (
              <div
                role="alert"
                className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
              >
                <span>
                  Chưa cập nhật được ví. Đang hiển thị số liệu lần tải trước.
                </span>
                <Button
                  variant="outline"
                  disabled={query.isFetching}
                  aria-busy={query.isFetching}
                  onClick={() => void query.refetch()}
                >
                  {query.isFetching ? "Đang tải lại…" : "Tải lại"}
                </Button>
              </div>
            )}
            {tab === "home" && (
              <div className="pf-dashboard">
                <section className="pf-balance">
                  <div className="pf-between">
                    <span>Tổng số dư các ví</span>
                    <div className="pf-balance-tools">
                      <MonthPicker month={month} onChange={setMonth} />
                      <button
                        aria-label={hidden ? "Hiện số tiền" : "Ẩn số tiền"}
                        onClick={() => setHidden(!hidden)}
                      >
                        {hidden ? <EyeOff size={20} /> : <Eye size={20} />}
                      </button>
                    </div>
                  </div>
                  <strong data-testid="total-balance">
                    {hidden ? "••••••" : money(balance)}
                  </strong>
                  <small>Số dư hiện tại · {s.wallets.length} ví cá nhân</small>
                  <div className="pf-balance-stats">
                    <div>
                      <span>
                        <ArrowDownLeft size={13} className="inline-block" /> Thu
                        trong tháng
                      </span>
                      <b data-testid="month-income">
                        {hidden ? "••••" : money(m.income)}
                      </b>
                    </div>
                    <div>
                      <span>
                        <ArrowUpLeft size={13} className="inline-block" /> Chi
                        trong tháng
                      </span>
                      <b data-testid="month-expense">
                        {hidden ? "••••" : money(m.expense)}
                      </b>
                    </div>
                  </div>
                </section>
                {permissions.create && (
                  <section className="pf-quick pf-launcher">
                    <div className="pf-launcher-input">
                      <button
                        className="pf-prompt"
                        onClick={() => {
                          setEntryMode("quick");
                          setSheet("entry");
                        }}
                      >
                        Hôm nay bạn chi gì?
                      </button>
                      <div className="pf-launcher-actions">
                        {[
                          [Paperclip, "Ảnh kèm nội dung", "attachment"],
                          [Camera, "Chụp bill", "camera"],
                          [ImagePlus, "Chọn ảnh", "gallery"],
                          [Mic, "Ghi âm", "voice"],
                        ].map(([Icon, label, action]) => {
                          const ActionIcon = Icon as typeof Paperclip;
                          return (
                            <button
                              key={String(label)}
                              aria-label={String(label)}
                              onClick={() => {
                                setEntryMode("quick");
                                setSheet("entry");
                                setLaunchAction({
                                  id: Date.now(),
                                  action: action as
                                    | "attachment"
                                    | "camera"
                                    | "gallery"
                                    | "voice",
                                });
                              }}
                            >
                              <ActionIcon size={20} />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div
                      className="pf-launcher-destination"
                      role="group"
                      aria-label="Ghi vào"
                    >
                      {controller.modes?.map((mode) => (
                        <button
                          key={mode}
                          aria-pressed={controller.mode === mode}
                          onClick={() => controller.setMode(mode)}
                        >
                          {mode === "personal" ? (
                            <Wallet size={18} />
                          ) : (
                            <Building2 size={18} />
                          )}{" "}
                          {mode === "personal" ? "Cá nhân" : "Công ty"}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
            {tab === "home" && (
              <>
                <div className="pf-wallet-strip">
                  {s.wallets
                    .filter((w) => !w.hidden)
                    .map((w) => (
                      <button
                        key={w.id}
                        onClick={() => {
                          setFilters({ ...emptyFilters, wallet: w.id });
                          setTab("transactions");
                        }}
                      >
                        <small>
                          {w.icon} {w.name}
                        </small>
                        <b>{hidden ? "••••" : money(w.balance)}</b>
                      </button>
                    ))}
                  <button onClick={() => setSheet("wallet")}>
                    <Settings size={20} />
                    <small>Quản lý ví</small>
                  </button>
                </div>
                <div className="pf-dashboard pf-summary-grid">
                  <section className="pf-card pf-recent-card">
                    <div className="pf-between">
                      <h2>Giao dịch gần đây</h2>
                      <button
                        className="pf-link"
                        onClick={() => setTab("transactions")}
                      >
                        Xem tất cả <ChevronRight size={18} />
                      </button>
                    </div>
                    <Ledger
                      {...props}
                      month={month}
                      filters={emptyFilters}
                      onFilters={setFilters}
                      manage={() => setSheet("wallet")}
                      categories={() => setSheet("category")}
                      recent
                      entry={() => {
                        setEntryMode("quick");
                        setSheet("entry");
                      }}
                    />
                  </section>
                  <section className="pf-card pf-budget-card">
                    <div className="pf-between">
                      <h2>Trong tầm tay</h2>
                      <button
                        className="pf-link"
                        onClick={() => setTab("budget")}
                      >
                        Ngân sách <ChevronRight size={18} />
                      </button>
                    </div>
                    <Budgets {...props} month={month} compact />
                  </section>
                </div>
                <ShareholderNotice />
              </>
            )}
            {tab === "transactions" && (
              <>
                <div className="pf-top">
                  <input
                    aria-label="Tìm giao dịch"
                    placeholder="Tìm giao dịch..."
                    value={filters.search}
                    onChange={(e) =>
                      setFilters({ ...filters, search: e.target.value })
                    }
                  />
                  <MonthPicker month={month} onChange={setMonth} />
                </div>
                <Ledger
                  {...props}
                  month={month}
                  filters={filters}
                  onFilters={setFilters}
                  manage={() => setSheet("wallet")}
                  categories={() => setSheet("category")}
                />
              </>
            )}
            {tab === "budget" && (
              <>
                <div className="pf-pills pf-entry-tabs pf-plan-tabs">
                  <button
                    className={budgetTab === "budget" ? "active" : ""}
                    onClick={() => setBudgetTab("budget")}
                  >
                    Ngân sách
                  </button>
                  <button
                    className={budgetTab === "goal" ? "active" : ""}
                    onClick={() => setBudgetTab("goal")}
                  >
                    Mục tiêu tiết kiệm
                  </button>
                </div>
                {budgetTab === "budget" ? (
                  <Budgets
                    {...props}
                    month={month}
                    onMonth={setMonth}
                    categories={() => setSheet("category")}
                  />
                ) : (
                  <Goals {...props} />
                )}
              </>
            )}
            {tab === "reports" && (
              <>
                <Reports
                  snapshot={s}
                  month={month}
                  onMonth={setMonth}
                  onDrill={(category, type) => {
                    setFilters({ ...emptyFilters, category, type });
                    setTab("transactions");
                  }}
                />
              </>
            )}
            <PersonalPendingRequests
              mayRetry={(action) =>
                permissions[
                  action.endsWith(".delete")
                    ? "delete"
                    : action.endsWith(".update")
                      ? "edit"
                      : "create"
                ]
              }
            />
            <FinanceSheet
              open={sheet === "wallet" || sheet === "category"}
              title={sheet === "wallet" ? "Quản lý ví" : "Quản lý danh mục"}
              onClose={() => setSheet(null)}
            >
              {(sheet === "wallet" || sheet === "category") && (
                <Management
                  {...props}
                  kind={sheet}
                  onWallet={(id) => {
                    setFilters({ ...emptyFilters, wallet: id });
                    setSheet(null);
                    setTab("transactions");
                  }}
                />
              )}
            </FinanceSheet>
            <FinanceSheet
              open={sheet === "entry"}
              title="Ghi thu chi"
              onClose={() => setSheet(null)}
            >
              <div className="pf-pills pf-entry-tabs">
                <button
                  className={entryMode === "quick" ? "active" : ""}
                  onClick={() => setEntryMode("quick")}
                >
                  Ghi nhanh
                </button>
                <button
                  className={entryMode === "manual" ? "active" : ""}
                  onClick={() => {
                    setEntryMode("manual");
                    if (
                      controller.mode === "company" &&
                      (!manualCompanyId ||
                        !controller.feed.cards[manualCompanyId] ||
                        controller.feed.cards[manualCompanyId].status.kind ===
                          "saved")
                    )
                      setManualCompanyId(controller.feed.addManual("company"));
                  }}
                >
                  Nhập tay
                </button>
              </div>
              <div hidden={entryMode !== "quick"}>
                <p className="pf-muted pf-entry-hint">
                  Nhập nội dung, thêm ảnh hoặc ghi âm.
                </p>
                <QuickEntryInput
                  controller={controller}
                  appearance="personal"
                  launchAction={launchAction}
                />
                <QuickEntryDraftFeed controller={controller} inDialog />
              </div>
              <div hidden={entryMode !== "manual"}>
                <div hidden={controller.mode !== "company"}>
                  <p className="pf-muted">Sổ thu chi công ty</p>
                  {manualCompanyId && (
                    <QuickEntryDraftFeed
                      controller={controller}
                      onlyCardId={manualCompanyId}
                      inDialog
                    />
                  )}
                  {manualDestination}
                </div>
                <div hidden={controller.mode !== "personal"}>
                  {sheet === "entry" && (
                    <FinanceEditor
                      editor={{ entity: "transaction" }}
                      snapshot={s}
                      permissions={permissions}
                      embedded
                      footerAddon={manualDestination}
                      onClose={() => setSheet(null)}
                    />
                  )}
                </div>
              </div>
            </FinanceSheet>
            {editor && (
              <FinanceEditor
                key={`${editor.entity}-${editor.record?.id ?? "new"}-${editor.remove ?? false}`}
                editor={editor}
                snapshot={s}
                permissions={permissions}
                onClose={() => setEditor(null)}
              />
            )}
          </>
        ) : (
          <p role="status">Đăng nhập để xem ví cá nhân.</p>
        )}
        <nav className="pf-nav" aria-label="Điều hướng ví cá nhân">
          {[
            { id: "home", label: "Tổng quan", Icon: Home },
            { id: "transactions", label: "Giao dịch", Icon: List },
            { id: "entry", label: "Ghi thu chi", Icon: Plus },
            { id: "budget", label: "Ngân sách", Icon: ClipboardList },
            { id: "reports", label: "Báo cáo", Icon: ChartNoAxesColumn },
          ].map(({ id, label, Icon }) =>
            id === "entry" && !permissions.create ? null : (
              <button
                key={id}
                className={`${tab === id ? "active" : ""} ${id === "entry" ? "pf-add" : ""}`}
                aria-label={label}
                aria-current={tab === id ? "page" : undefined}
                disabled={!s || !!moneyError}
                onClick={() =>
                  id === "entry" ? setSheet("entry") : setTab(id)
                }
              >
                <Icon size={id === "entry" ? 26 : 20} />
                {id !== "entry" && <span>{label}</span>}
              </button>
            ),
          )}
        </nav>
      </div>
    </MainLayout>
  );
}
