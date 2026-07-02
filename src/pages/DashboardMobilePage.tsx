import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Calendar,
  TrendingUp,
  TrendingDown,
  Wallet,
  Building2,
  AlertTriangle,
  AlertCircle,
  Info,
  ChevronRight,
  Clock,
  DoorOpen,
  FileText,
  CircleDollarSign,
  UserPlus,
  FileSignature,
} from "lucide-react";
import "@/styles/mobileApp.css";
import "@/styles/dashboardMobile.css";
import {
  useDashboardStats,
  useRevenueChart,
  useOccupancyChart,
  useAlerts,
  useRecentActivities,
} from "@/hooks/useDashboard";
import { useContractDashboardCounts } from "@/hooks/useContracts";
import { useLeads } from "@/hooks/useLeads";
import { useDeposits } from "@/hooks/useDeposits";
import { useBuildings } from "@/hooks/useBuildings";
import { formatDistanceToNow, format } from "date-fns";
import { vi } from "date-fns/locale";
import { usePersistedState } from "@/hooks/usePersistedState";

/** Rút gọn tiền: 126.8tr · 84.5tr · 1.4 tỷ. */
const compact = (n: number): string => {
  const x = Number(n) || 0;
  const a = Math.abs(x);
  if (a >= 1e9) return (x / 1e9).toFixed(1).replace(/\.0$/, "") + " tỷ";
  if (a >= 1e6) return (x / 1e6).toFixed(1).replace(/\.0$/, "") + "tr";
  if (a >= 1e3) return Math.round(x / 1e3) + "k";
  return x.toLocaleString("vi-VN");
};

/** Nhãn trục X của biểu đồ doanh thu: "06/2026" → "T6" (an toàn nếu dữ liệu lệch định dạng). */
const monthLabel = (m: string): string => {
  const n = parseInt(m, 10);
  return Number.isFinite(n) ? `T${n}` : "—";
};

const OCC_COLOR: Record<string, string> = {
  "Đã thuê": "#1f9d57",
  "Còn trống": "#d6453f",
  "Đã cọc": "#2563eb",
};

const SEVERITY = {
  high: { Icon: AlertCircle, c: "#dc2626", bg: "#fde8e6" },
  medium: { Icon: AlertTriangle, c: "#ea580c", bg: "#fdecdc" },
  low: { Icon: Info, c: "#2563eb", bg: "#e7eefc" },
} as const;

const ALERT_LABEL: Record<string, string> = {
  overdue_invoice: "Hóa đơn quá hạn",
  expiring_contract: "Hợp đồng hết hạn",
  urgent_issue: "Công việc khẩn cấp",
  deposit_shortfall: "Thiếu cọc",
};

const ACTIVITY = {
  contract: { Icon: FileText, c: "#2563eb", bg: "#e7eefc" },
  payment: { Icon: CircleDollarSign, c: "#16a34a", bg: "#e6f5ec" },
  issue: { Icon: AlertCircle, c: "#ea580c", bg: "#fdecdc" },
} as const;

/**
 * Bảng tin — màn hình app full-screen trên mobile (web-app). Dựng theo handoff
 * Claude Design (ui_kits/mobile-app: DashboardScreen) nối DỮ LIỆU THẬT của
 * dashboard desktop: KPI (useDashboardStats), tỷ lệ lấp đầy (useOccupancyChart),
 * doanh thu 12 tháng (useRevenueChart), tổng quan vận hành (useLeads/useDeposits/
 * useContractDashboardCounts), cảnh báo (useAlerts), hoạt động gần đây
 * (useRecentActivities). Lọc theo toà giống desktop. Nút ← về trang chủ.
 * Scope .cm-stage/.cm-app, ngoài MainLayout.
 */
export default function DashboardMobilePage() {
  const navigate = useNavigate();
  const [building, setBuilding] = usePersistedState<string>("flt:dashboard-mb:building", "");
  const buildingId = building || null;

  const now = useMemo(() => new Date(), []);
  const period = `Kỳ ${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`;

  const { data: buildingsData } = useBuildings();
  const buildings = useMemo(
    () => (Array.isArray(buildingsData) ? (buildingsData as Array<{ id: string; name: string }>) : []),
    [buildingsData],
  );

  const { data: stats } = useDashboardStats(buildingId);
  const { data: revenue = [] } = useRevenueChart(12, buildingId);
  const { data: occupancy = [] } = useOccupancyChart(buildingId);
  const { data: alerts = [] } = useAlerts(buildingId);
  const { data: activities = [] } = useRecentActivities(buildingId);

  // Tổng quan vận hành — tính y hệt OperationsSummary desktop.
  const { data: leads = [] } = useLeads();
  const { data: deposits = [] } = useDeposits();
  const { data: contractCounts } = useContractDashboardCounts(buildingId);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const newLeads = leads.filter((l: any) => l.created_at && new Date(l.created_at) >= startOfMonth).length;
  const convertedLeads = leads.filter((l: any) => l.status === "CONVERTED").length;
  const leadConversion = leads.length ? `${Math.round((convertedLeads / leads.length) * 100)}%` : "0%";
  const newDeposits = deposits.filter((d: any) => d.created_at && new Date(d.created_at) >= startOfMonth).length;
  const movedIn = deposits.filter((d: any) => d.status === "CONVERTED").length;
  const depositConversion = deposits.length ? `${Math.round((movedIn / deposits.length) * 100)}%` : "0%";

  const ops = [
    {
      title: "Tổng quan khách hẹn",
      Icon: UserPlus,
      iconC: "#2563eb",
      to: "/leads",
      stats: [
        { label: "Khách hẹn mới", value: newLeads, tone: "#2563eb" },
        { label: "Đã chuyển đổi", value: convertedLeads, tone: "#1f9d57" },
        { label: "Tỷ lệ chuyển đổi", value: leadConversion },
        { label: "Đang theo dõi", value: leads.length },
      ],
    },
    {
      title: "Tổng quan đặt cọc",
      Icon: Wallet,
      iconC: "#d97706",
      to: "/deposits",
      stats: [
        { label: "Cọc mới (tháng)", value: newDeposits, tone: "#d97706" },
        { label: "Khách vào thuê", value: movedIn, tone: "#1f9d57" },
        { label: "Tỷ lệ chuyển đổi", value: depositConversion },
        { label: "Tổng phiếu cọc", value: deposits.length },
      ],
    },
    {
      title: "Tổng quan hợp đồng",
      Icon: FileSignature,
      iconC: "#1f9d57",
      to: "/contracts",
      stats: [
        { label: "Đang thuê", value: contractCounts?.active ?? 0, tone: "#1f9d57" },
        { label: "Ký mới (tháng)", value: contractCounts?.newThisMonth ?? 0, tone: "#2563eb" },
        { label: "Sắp hết hạn ≤30n", value: contractCounts?.expiringSoon ?? 0, tone: "#d97706" },
        { label: "Thanh lý (tháng)", value: contractCounts?.terminatedThisMonth ?? 0, tone: "#d6453f" },
      ],
    },
  ];

  const kpis = stats
    ? [
        { label: "Doanh thu tháng", value: compact(stats.revenueThisMonth), accent: "#1f9d57", Icon: TrendingUp, sub: period },
        { label: "Công nợ", value: compact(stats.totalDebt), accent: "#d97706", Icon: Wallet, sub: "Tổng còn phải thu" },
        { label: "Tỷ lệ lấp đầy", value: `${Number(stats.occupancyRate).toFixed(1)}%`, accent: "#2563eb", Icon: Building2, sub: `${stats.occupiedRooms} / ${stats.totalRooms} phòng` },
        { label: "CV chưa xử lý", value: String(stats.unresolvedIssues), accent: "#d6453f", Icon: AlertTriangle, sub: "Cần xử lý ngay" },
      ]
    : [];

  const totalRooms = stats?.totalRooms ?? occupancy.reduce((s, o) => s + o.count, 0);
  const maxRev = Math.max(1, ...revenue.map((r) => r.revenue));
  const lastGrowth = revenue.length ? revenue[revenue.length - 1].growth : undefined;

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate("/")} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Bảng tin</h1>
              <p>Tổng quan vận hành</p>
            </div>
          </div>

          <div className="mbody">
            <div className="dash-toprow">
              <div className="dash-period">
                <Calendar size={15} />
                <span>{period}</span>
              </div>
              <select
                className="cm-select dash-bld"
                value={building}
                onChange={(e) => setBuilding(e.target.value)}
                aria-label="Toà nhà"
              >
                <option value="">Tất cả toà</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>

            {!stats ? (
              <div className="stub">
                <p>Đang tải bảng tin…</p>
              </div>
            ) : (
              <>
                {/* KPI */}
                <div className="kgrid">
                  {kpis.map((k) => {
                    const Ico = k.Icon;
                    return (
                      <div className="kcard" key={k.label} style={{ borderLeftColor: k.accent }}>
                        <div className="kc-top">
                          <span className="kc-lbl">{k.label}</span>
                          <span className="kc-ic" style={{ background: k.accent + "1f", color: k.accent }}>
                            <Ico size={16} />
                          </span>
                        </div>
                        <div className="kc-val">{k.value}</div>
                        <div className="kc-sub">{k.sub}</div>
                      </div>
                    );
                  })}
                </div>

                {/* Tỷ lệ lấp đầy */}
                <div className="cd-card">
                  <div className="cd-card-h">
                    <span className="cd-card-t">
                      <DoorOpen size={16} />
                      Tỷ lệ lấp đầy
                    </span>
                    <span
                      className="cd-count"
                      style={{ background: "transparent", color: "var(--ink-3)", border: 0 }}
                    >
                      {totalRooms} phòng
                    </span>
                  </div>
                  <div className="occ-bar">
                    {occupancy.map((o) => (
                      <div
                        key={o.status}
                        style={{ width: o.percentage + "%", background: OCC_COLOR[o.status] || "#cbd2cb" }}
                        title={o.status}
                      />
                    ))}
                  </div>
                  <div className="occ-legend">
                    {occupancy.map((o) => (
                      <div className="occ-leg" key={o.status}>
                        <span className="occ-dot" style={{ background: OCC_COLOR[o.status] || "#cbd2cb" }} />
                        <span className="occ-leg-l">{o.status}</span>
                        <span className="occ-leg-v">
                          {o.count}
                          <small> · {Number(o.percentage).toFixed(1)}%</small>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Doanh thu theo tháng */}
                <div className="cd-card">
                  <div className="cd-card-h">
                    <span className="cd-card-t">
                      <TrendingUp size={16} />
                      Doanh thu theo tháng
                    </span>
                    {typeof lastGrowth === "number" && (
                      <span className={"occ-growth" + (lastGrowth < 0 ? " down" : "")}>
                        {lastGrowth < 0 ? <TrendingDown size={12} /> : <TrendingUp size={12} />}
                        {lastGrowth > 0 ? "+" : ""}
                        {lastGrowth.toFixed(1)}%
                      </span>
                    )}
                  </div>
                  <div className="chart">
                    {revenue.map((r, i) => (
                      <div className="chart-bw" key={r.month + i}>
                        <div
                          className="chart-bar"
                          style={{
                            height: (r.revenue / maxRev) * 100 + "%",
                            background: i === revenue.length - 1 ? "var(--brand)" : undefined,
                          }}
                        />
                        <span className="chart-x">{monthLabel(r.month)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="panel-s">12 tháng gần nhất · triệu ₫</p>
                </div>

                {/* Tổng quan vận hành */}
                <p className="dash-sec">Tổng quan vận hành</p>
                <div className="ops">
                  {ops.map((b) => {
                    const Ico = b.Icon;
                    return (
                      <div className="opsb" key={b.title}>
                        <div className="opsb-h">
                          <span className="opsb-ic" style={{ background: b.iconC + "1c", color: b.iconC }}>
                            <Ico size={16} />
                          </span>
                          <span className="opsb-t">{b.title}</span>
                          <button className="opsb-go" onClick={() => navigate(b.to)}>
                            Xem
                            <ChevronRight size={13} />
                          </button>
                        </div>
                        <div className="opsb-grid">
                          {b.stats.map((s) => (
                            <div className="opsb-stat" key={s.label}>
                              <span className="opsb-v" style={{ color: s.tone || "var(--ink)" }}>
                                {s.value}
                              </span>
                              <span className="opsb-l">{s.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Cảnh báo & Thông báo */}
                <div className="cd-card">
                  <div className="cd-card-h">
                    <span className="cd-card-t">
                      <AlertTriangle size={16} />
                      Cảnh báo & Thông báo
                    </span>
                    <span className="cd-count">{alerts.length}</span>
                  </div>
                  {alerts.length === 0 ? (
                    <p className="panel-s" style={{ margin: 0 }}>
                      Không có cảnh báo — hệ thống đang hoạt động bình thường.
                    </p>
                  ) : (
                    <div className="alerts">
                      {alerts.map((a) => {
                        const cfg = SEVERITY[a.severity] || SEVERITY.low;
                        const Ico = cfg.Icon;
                        return (
                          <div
                            className={"alert" + (a.link ? " tap" : "")}
                            key={a.id}
                            onClick={() => a.link && navigate(a.link)}
                          >
                            <span className="alert-ic" style={{ background: cfg.bg, color: cfg.c }}>
                              <Ico size={17} />
                            </span>
                            <div className="alert-body">
                              <div className="alert-top">
                                <span className="alert-t">{a.title}</span>
                                <span className="alert-badge" style={{ background: cfg.bg, color: cfg.c }}>
                                  {ALERT_LABEL[a.type] || "Thông báo"}
                                </span>
                              </div>
                              <div className="alert-desc">{a.description}</div>
                              <div className="alert-date">
                                {format(new Date(a.date), "dd/MM/yyyy HH:mm", { locale: vi })}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Hoạt động gần đây */}
                <div className="cd-card">
                  <div className="cd-card-h">
                    <span className="cd-card-t">
                      <Clock size={16} />
                      Hoạt động gần đây
                    </span>
                    <span
                      className="cd-count"
                      style={{ background: "transparent", color: "var(--ink-3)", border: 0 }}
                    >
                      7 ngày qua
                    </span>
                  </div>
                  {activities.length === 0 ? (
                    <p className="panel-s" style={{ margin: 0 }}>
                      Chưa có hoạt động nào.
                    </p>
                  ) : (
                    <div className="feed">
                      {activities.map((a) => {
                        const cfg = ACTIVITY[a.type] || ACTIVITY.contract;
                        const Ico = cfg.Icon;
                        return (
                          <div className="feed-it" key={a.id}>
                            <span className="feed-ic" style={{ background: cfg.bg, color: cfg.c }}>
                              <Ico size={15} />
                            </span>
                            <div className="feed-body">
                              <div className="feed-top">
                                <span className="feed-t">{a.title}</span>
                                {a.amount ? (
                                  <span className="feed-amt">
                                    +{compact(a.amount)}
                                    <small>₫</small>
                                  </span>
                                ) : null}
                              </div>
                              <div className="feed-desc">{a.description}</div>
                              <span className="feed-w">
                                {formatDistanceToNow(new Date(a.date), { addSuffix: true, locale: vi })}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
